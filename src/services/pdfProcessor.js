
// ==================== Processamento de PDF ====================
// Extrai o texto de faturas de energia usando pdfjs-dist.
// Usa o build principal e faz fallback automático para o build legacy
// (mais compatível) caso ocorra falha no worker ou na leitura.

import * as pdfjsLib from 'pdfjs-dist'
import * as pdfjsLibLegacy from 'pdfjs-dist/legacy/build/pdf.mjs'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import PdfWorkerLegacy from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker'

// Configura os workers via workerPort (abordagem recomendada para Vite)
try {
  pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()
} catch (e) {
  console.warn('Falha ao iniciar worker do PDF.js:', e)
}
try {
  pdfjsLibLegacy.GlobalWorkerOptions.workerPort = new PdfWorkerLegacy()
} catch (e) {
  console.warn('Falha ao iniciar worker legacy do PDF.js:', e)
}

// Timeout de segurança para evitar travamento indefinido
const TIMEOUT_PDF_MS = 30000 // 30 segundos

/**
 * Extrai o texto de todas as páginas de um documento PDF já aberto.
 */
const extrairTextoDeDocumento = async (pdf) => {
  let textoCompleto = ''

  for (let pagina = 1; pagina <= pdf.numPages; pagina++) {
    const page = await pdf.getPage(pagina)
    const content = await page.getTextContent()
    const textoPagina = content.items
      .map((item) => item.str)
      .join(' ')
    textoCompleto += textoPagina + '\n'
  }

  return textoCompleto
}

/**
 * Tenta abrir e extrair o texto usando uma biblioteca específica.
 */
const tentarExtrair = async (lib, nomeLib, data) => {
  const pdf = await Promise.race([
    lib.getDocument({ data }).promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Tempo limite excedido ao ler o PDF.')), TIMEOUT_PDF_MS),
    ),
  ])

  try {
    const texto = await extrairTextoDeDocumento(pdf)
    return texto
  } finally {
    // Libera recursos do documento
    await pdf.destroy().catch(() => {})
  }
}

/**
 * Extrai o texto completo de um arquivo PDF.
 * @param {File|Blob|ArrayBuffer} arquivo - O arquivo PDF
 * @returns {Promise<string>} Texto extraído do PDF
 */
export const extrairTextoDoPDF = async (arquivo) => {
  try {
    const buffer = arquivo instanceof ArrayBuffer ? arquivo : await arquivo.arrayBuffer()

    // Cria cópias independentes do buffer (cada tentativa consome os dados)
    const data1 = new Uint8Array(buffer.slice(0))
    const data2 = new Uint8Array(buffer.slice(0))

    try {
      // Tentativa 1: build principal
      return await tentarExtrair(pdfjsLib, 'principal', data1)
    } catch (erroPrincipal) {
      console.error('[PDF] Falha no build principal:', erroPrincipal?.name, erroPrincipal?.message)

      // Tentativa 2: build legacy (mais compatível)
      try {
        const texto = await tentarExtrair(pdfjsLibLegacy, 'legacy', data2)
        console.info('[PDF] Extraído com sucesso usando o build legacy.')
        return texto
      } catch (erroLegacy) {
        console.error('[PDF] Falha no build legacy:', erroLegacy?.name, erroLegacy?.message)

        if (erroLegacy?.message?.includes('Tempo limite')) {
          throw new Error('Tempo limite excedido ao ler o PDF. Tente novamente.')
        }
        if (erroLegacy?.name === 'PasswordException') {
          throw new Error('O PDF é protegido por senha e não pode ser lido.')
        }
        if (erroLegacy?.name === 'InvalidPDFException') {
          throw new Error('O arquivo não é um PDF válido ou está corrompido.')
        }
        throw new Error(
          `Não foi possível ler o PDF (${erroPrincipal?.name || 'erro desconhecido'}). Verifique se o arquivo é válido.`,
        )
      }
    }
  } catch (error) {
    console.error('Erro ao extrair texto do PDF:', error)
    // Repropaga erros já tratados; caso contrário, usa mensagem genérica
    if (
      error?.message?.includes('Tempo limite') ||
      error?.message?.includes('senha') ||
      error?.message?.includes('não é um PDF') ||
      error?.message?.includes('Não foi possível ler')
    ) {
      throw error
    }
    throw new Error('Não foi possível ler o PDF. Verifique se o arquivo é válido.')
  }
}

/**
 * Extrai o texto de um PDF a partir de uma URL (data URL ou blob URL).
 * @param {string} dataUrl - URL do PDF
 * @returns {Promise<string>} Texto extraído
 */
export const extrairTextoDeDataUrl = async (dataUrl) => {
  try {
    const response = await fetch(dataUrl)
    const arrayBuffer = await response.arrayBuffer()
    return await extrairTextoDoPDF(arrayBuffer)
  } catch (error) {
    console.error('Erro ao extrair texto de data URL:', error)
    throw new Error('Não foi possível ler o PDF.')
  }
}