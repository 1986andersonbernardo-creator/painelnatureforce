
// ==================== Processamento de PDF ====================
// Extrai o texto de faturas de energia usando pdfjs-dist.
// Usa o build principal e faz fallback automático para o build legacy
// (mais compatível) caso ocorra falha no worker ou na leitura.
//
// Correções relevantes (bug "PDF válido rejeitado"):
//   1. A extração preserva a ESTRUTURA DE LINHAS do PDF (pdfTextLayout).
//      Antes, todos os fragmentos da página eram unidos com um espaço e a
//      página inteira virava UMA linha — o que quebrava todo o classificador
//      orientado a linhas (UC, vencimento, cliente na linha seguinte).
//   2. Cada documento recebe um WORKER NOVO e ele é encerrado no fim.
//      Antes havia um único `GlobalWorkerOptions.workerPort` compartilhado
//      por todos os arquivos de um upload múltiplo.
//   3. PDFs sem camada de texto (escaneados/imagem) são detectados e
//      reportados com mensagem específica — antes caíam em "UC não identificada".

import * as pdfjsLib from 'pdfjs-dist'
import * as pdfjsLibLegacy from 'pdfjs-dist/legacy/build/pdf.mjs'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import PdfWorkerLegacy from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker'

import { reconstruirLinhas, temCamadaDeTexto } from './pdfTextLayout'
import { ERRO_PDF, ErroPDF, validarArquivoPDF } from './pdfValidacao'

// Timeout de segurança para evitar travamento indefinido
const TIMEOUT_PDF_MS = 30000 // 30 segundos

/**
 * Cria uma PORTA de worker nova para um documento.
 * Não usamos mais `GlobalWorkerOptions.workerPort` no escopo do módulo:
 * um worker compartilhado é reaproveitado (e destruído) entre documentos,
 * quebrando uploads múltiplos. Aqui cada documento tem o seu.
 * @param {Function} Fabrica - classe Worker gerada pelo Vite (?worker)
 * @returns {Worker|null}
 */
const criarPortaWorker = (Fabrica) => {
  try {
    return typeof Fabrica === 'function' ? new Fabrica() : null
  } catch (e) {
    console.warn('Falha ao iniciar worker do PDF.js:', e?.message)
    return null
  }
}

/**
 * Encerra a porta de worker com segurança (nunca lança).
 * @param {Worker|null} porta
 */
const encerrarPortaWorker = (porta) => {
  try {
    porta?.terminate?.()
  } catch {
    /* worker já encerrado */
  }
}


/**
 * Extrai o texto de todas as páginas de um documento PDF já aberto,
 * RECONSTRUINDO as linhas visuais (ver pdfTextLayout).
 * @param {Object} pdf - PDFDocumentProxy
 * @returns {Promise<{ texto: string, totalItens: number }>}
 */
const extrairTextoDeDocumento = async (pdf) => {
  const linhas = []
  let totalItens = 0

  for (let pagina = 1; pagina <= pdf.numPages; pagina++) {
    const page = await pdf.getPage(pagina)
    const content = await page.getTextContent()

    totalItens += Array.isArray(content.items) ? content.items.length : 0

    // Cada página é reconstruída em LINHAS reais — exatamente o formato que o
    // faturaClassifier espera (texto.split('\n') + valor na linha seguinte).
    linhas.push(...reconstruirLinhas(content.items))
  }

  return { texto: linhas.join('\n'), totalItens }
}

/**
 * Tenta abrir e extrair o texto usando uma biblioteca específica.
 * @param {Object} lib - pdfjsLib (build principal) ou pdfjsLibLegacy
 * @param {string} nomeLib - rótulo do build, usado apenas em logs
 * @param {Uint8Array} data - conteúdo do PDF
 * @param {Function} FabricaWorker - fábrica de worker do build correspondente
 * @returns {Promise<string>} Texto extraído do PDF
 */
const tentarExtrair = async (lib, nomeLib, data, FabricaWorker) => {
  // Worker NOVO por documento — evita reutilizar (ou herdar) estado de outro PDF.
  const porta = criarPortaWorker(FabricaWorker)
  let pdfWorker = null
  let pdf = null

  try {
    if (porta && typeof lib.PDFWorker === 'function') {
      pdfWorker = new lib.PDFWorker({ port: porta })
    }

    const parametros = pdfWorker ? { data, worker: pdfWorker } : { data }

    pdf = await Promise.race([
      lib.getDocument(parametros).promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new ErroPDF(ERRO_PDF.TIMEOUT)), TIMEOUT_PDF_MS),
      ),
    ])

    const { texto, totalItens } = await extrairTextoDeDocumento(pdf)

    // PDF sem camada de texto (digitalizado/imagem): o getTextContent() devolve
    // praticamente nada. Erro explícito para o usuário — nunca "UC não identificada".
    if (!temCamadaDeTexto(texto)) {
      console.warn(
        `[PDF] Build ${nomeLib}: sem camada de texto (${totalItens} itens, ` +
          `${texto.replace(/\s/g, '').length} caracteres úteis em ${pdf.numPages} página(s)).`,
      )
      throw new ErroPDF(ERRO_PDF.SEM_TEXTO)
    }

    return texto
  } finally {
    // Libera recursos do documento e encerra o worker DESTE documento.
    try {
      await pdf?.destroy()
    } catch {
      /* documento já liberado */
    }
    try {
      pdfWorker?.destroy()
    } catch {
      /* worker já destruído */
    }
    encerrarPortaWorker(porta)
  }
}


/**
 * Converte exceções cruas do PDF.js em `ErroPDF` com código e mensagem amigável.
 * @param {Error} erro - Exceção lançada pelo PDF.js
 * @param {Error|null} erroPrincipal - Exceção do build principal (contexto)
 * @returns {ErroPDF}
 */
const traduzirErroPDF = (erro, erroPrincipal = null) => {
  if (erro instanceof ErroPDF) return erro
  if (erro?.name === 'PasswordException') return new ErroPDF(ERRO_PDF.PROTEGIDO)
  if (erro?.name === 'InvalidPDFException') return new ErroPDF(ERRO_PDF.CORROMPIDO)
  if (erro?.message?.includes('Tempo limite')) return new ErroPDF(ERRO_PDF.TIMEOUT)

  return new ErroPDF(
    ERRO_PDF.DESCONHECIDO,
    `Não foi possível ler o PDF (${erroPrincipal?.name || erro?.name || 'erro desconhecido'}). ` +
      'Verifique se o arquivo é válido e tente novamente.',
  )
}

/**
 * Extrai o texto completo de um arquivo PDF.
 *
 * Fluxo:
 *   1. valida o CONTEÚDO pela assinatura "%PDF-" (nunca pelo MIME);
 *   2. lê o arquivo como ArrayBuffer aguardando a Promise;
 *   3. tenta o build principal do PDF.js e, se falhar, o build legacy;
 *   4. reconstrói as linhas visuais do texto (getTextContent).
 *
 * @param {File|Blob|ArrayBuffer|Uint8Array} arquivo - O arquivo PDF
 * @returns {Promise<string>} Texto extraído do PDF (linhas preservadas)
 * @throws {ErroPDF} código NAO_E_PDF | CORROMPIDO | VAZIO | SEM_TEXTO |
 *                   PROTEGIDO | TIMEOUT | DESCONHECIDO
 */
export const extrairTextoDoPDF = async (arquivo) => {
  // 1. Validação por conteúdo — evita rejeitar PDF válido por MIME vazio/errado.
  const validacao = await validarArquivoPDF(arquivo)
  if (!validacao.ok) {
    throw new ErroPDF(validacao.codigo, validacao.mensagem)
  }

  try {
    // 2. Leitura correta como ArrayBuffer (sempre com await).
    const buffer =
      arquivo instanceof ArrayBuffer
        ? arquivo
        : arquivo instanceof Uint8Array
          ? arquivo.buffer.slice(arquivo.byteOffset, arquivo.byteOffset + arquivo.byteLength)
          : await arquivo.arrayBuffer()

    // O PDF.js transfere (desanexa) o buffer para o worker → cada tentativa
    // precisa da sua PRÓPRIA cópia, senão a segunda leitura chega vazia.
    const data1 = new Uint8Array(buffer.slice(0))
    const data2 = new Uint8Array(buffer.slice(0))

    try {
      // Tentativa 1: build principal (com worker próprio deste documento)
      return await tentarExtrair(pdfjsLib, 'principal', data1, PdfWorker)
    } catch (erroPrincipal) {
      console.error('[PDF] Falha no build principal:', erroPrincipal?.name, erroPrincipal?.message)

      // Sem camada de texto é característica do ARQUIVO, não do build:
      // repetir no legacy só gastaria tempo e daria o mesmo resultado.
      if (erroPrincipal?.codigo === ERRO_PDF.SEM_TEXTO) {
        throw erroPrincipal
      }

      // Tentativa 2: build legacy (mais compatível)
      try {
        const texto = await tentarExtrair(pdfjsLibLegacy, 'legacy', data2, PdfWorkerLegacy)
        console.info('[PDF] Extraído com sucesso usando o build legacy.')
        return texto
      } catch (erroLegacy) {
        console.error('[PDF] Falha no build legacy:', erroLegacy?.name, erroLegacy?.message)
        throw traduzirErroPDF(erroLegacy, erroPrincipal)
      }
    }
  } catch (error) {
    console.error('Erro ao extrair texto do PDF:', error?.codigo || '', error?.message)
    throw traduzirErroPDF(error, null)
  }
}

/**
 * Extrai o texto de um PDF a partir de uma URL (data URL ou blob URL).
 * @param {string} dataUrl - URL do PDF
 * @returns {Promise<string>} Texto extraído
 * @throws {ErroPDF} mesma taxonomia de `extrairTextoDoPDF`
 */
export const extrairTextoDeDataUrl = async (dataUrl) => {
  try {
    const response = await fetch(dataUrl)
    if (!response.ok) {
      throw new ErroPDF(
        ERRO_PDF.DESCONHECIDO,
        `Não foi possível carregar o PDF armazenado (HTTP ${response.status}).`,
      )
    }
    const arrayBuffer = await response.arrayBuffer()
    return await extrairTextoDoPDF(arrayBuffer)
  } catch (error) {
    console.error('Erro ao extrair texto de data URL:', error?.codigo || '', error?.message)
    throw traduzirErroPDF(error, null)
  }
}