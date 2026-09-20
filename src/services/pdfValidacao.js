// ==================== Validação de Arquivo PDF ====================
// A validação de formato NÃO pode depender de `input.files[0].type` (MIME).
//
// Por quê (armadilha comum):
//   - Alguns navegadores/SO entregam `type` VAZIO ('') ou genérico
//     ('application/octet-stream') para PDFs perfeitamente válidos;
//   - Outros entregam 'application/x-pdf' ou 'text/pdf';
//   - Um .txt renomeado para .pdf continua chegando com type PDF.
//
// Portanto a decisão é tomada pela ASSINATURA do arquivo ("%PDF-"), lida
// diretamente dos primeiros bytes do conteúdo. O MIME e a extensão são usados
// apenas como pista para escolher a mensagem de erro (não como bloqueio).
//
// Módulo puro (sem pdfjs) — é importável nos testes em Node.

export const ASSINATURA_PDF = '%PDF-'

// A especificação exige o cabeçalho na primeira linha, mas geradores antigos
// costumam inserir bytes antes dele — por isso procuramos dentro de uma janela.
export const JANELA_ASSINATURA_BYTES = 1024

// Quantidade de bytes lidos para validação (nunca o arquivo inteiro).
export const TAMANHO_AMOSTRA_BYTES = 2048

// Códigos de erro de arquivo (estáveis — usados pela UI e pelos testes).
export const ERRO_PDF = Object.freeze({
  NAO_E_PDF: 'NAO_E_PDF',
  CORROMPIDO: 'CORROMPIDO',
  VAZIO: 'VAZIO',
  SEM_TEXTO: 'SEM_TEXTO',
  PROTEGIDO: 'PROTEGIDO',
  TIMEOUT: 'TIMEOUT',
  DESCONHECIDO: 'DESCONHECIDO',
})

// Mensagens amigáveis para o usuário final.
export const MENSAGEM_ERRO_PDF = Object.freeze({
  [ERRO_PDF.NAO_E_PDF]:
    'O arquivo selecionado não é um PDF (assinatura "%PDF-" não encontrada no conteúdo).',
  [ERRO_PDF.CORROMPIDO]:
    'O arquivo tem extensão/MIME de PDF, mas o conteúdo não contém o cabeçalho "%PDF-". O arquivo está corrompido, renomeado ou o upload foi incompleto.',
  [ERRO_PDF.VAZIO]: 'O arquivo está vazio (0 bytes).',
  [ERRO_PDF.SEM_TEXTO]:
    'O PDF não possui camada de texto — provavelmente é uma digitalização (imagem). Envie o PDF original da distribuidora ou um arquivo com texto selecionável.',
  [ERRO_PDF.PROTEGIDO]: 'O PDF é protegido por senha e não pode ser lido.',
  [ERRO_PDF.TIMEOUT]: 'Tempo limite excedido ao ler o PDF. Tente novamente.',
  [ERRO_PDF.DESCONHECIDO]:
    'Não foi possível ler o arquivo. Verifique se o PDF é válido e tente novamente.',
})

/**
 * Erro tipado de PDF — carrega o `codigo` para a UI decidir o que exibir.
 */
export class ErroPDF extends Error {
  constructor(codigo, mensagem) {
    super(mensagem || MENSAGEM_ERRO_PDF[codigo] || MENSAGEM_ERRO_PDF[ERRO_PDF.DESCONHECIDO])
    this.name = 'ErroPDF'
    this.codigo = codigo
  }
}

// MIMEs que realmente identificam PDF (o MIME genérico octet-stream NÃO entra:
// ele sozinho não prova nada, então a decisão fica com a assinatura).
export const MIME_PDF_ACEITOS = Object.freeze([
  'application/pdf',
  'application/x-pdf',
  'application/acrobat',
  'applications/vnd.pdf',
  'text/pdf',
  'text/x-pdf',
])

/**
 * Normaliza um MIME removendo parâmetros (ex: "application/pdf; charset=binary").
 * @param {string} mime
 * @returns {string} MIME normalizado em minúsculas
 */
export const normalizarMime = (mime) =>
  String(mime ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()

/**
 * Verifica se o MIME declarado aponta para PDF.
 * @param {string} mime
 * @returns {boolean}
 */
export const ehMimePdf = (mime) => MIME_PDF_ACEITOS.includes(normalizarMime(mime))

/**
 * Verifica se o nome do arquivo termina com .pdf (case-insensitive).
 * @param {string} nome
 * @returns {boolean}
 */
export const ehNomePdf = (nome) => /\.pdf$/i.test(String(nome ?? '').trim())

/**
 * Procura a assinatura "%PDF-" dentro da janela inicial dos bytes.
 * @param {Uint8Array|number[]} bytes
 * @returns {boolean}
 */
export const encontrarAssinaturaPDF = (bytes) => {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length === 0) return false

  const limite = Math.min(bytes.length, JANELA_ASSINATURA_BYTES)
  const alvo = ASSINATURA_PDF.length

  for (let i = 0; i <= limite - alvo; i++) {
    let casou = true
    for (let j = 0; j < alvo; j++) {
      if (bytes[i + j] !== ASSINATURA_PDF.charCodeAt(j)) {
        casou = false
        break
      }
    }
    if (casou) return true
  }

  return false
}

/**
 * Lê apenas os primeiros bytes do arquivo (nunca o PDF inteiro).
 * Aceita Blob/File (navegador), ArrayBuffer e Uint8Array.
 * @param {Blob|File|ArrayBuffer|Uint8Array} arquivo
 * @returns {Promise<Uint8Array>}
 */
export const lerAmostraBytes = async (arquivo) => {
  if (!arquivo) throw new Error('Arquivo não informado.')

  if (arquivo instanceof Uint8Array) {
    return arquivo.subarray(0, Math.min(arquivo.length, TAMANHO_AMOSTRA_BYTES))
  }

  if (arquivo instanceof ArrayBuffer) {
    return new Uint8Array(arquivo.slice(0, TAMANHO_AMOSTRA_BYTES))
  }

  if (typeof arquivo.slice === 'function' && typeof arquivo.arrayBuffer === 'function') {
    const fatia = arquivo.slice(0, TAMANHO_AMOSTRA_BYTES)
    return new Uint8Array(await fatia.arrayBuffer())
  }

  if (typeof arquivo.arrayBuffer === 'function') {
    const buffer = await arquivo.arrayBuffer()
    return new Uint8Array(buffer.slice(0, TAMANHO_AMOSTRA_BYTES))
  }

  throw new Error('Tipo de arquivo não suportado para leitura.')
}

/**
 * Valida bytes de PDF pela assinatura (função pura e testável).
 * @param {Uint8Array|number[]} bytes
 * @returns {{ ok: boolean, codigo: string|null, mensagem: string }}
 */
export const validarBytesPDF = (bytes) => {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length === 0) {
    return { ok: false, codigo: ERRO_PDF.VAZIO, mensagem: MENSAGEM_ERRO_PDF[ERRO_PDF.VAZIO] }
  }

  if (!encontrarAssinaturaPDF(bytes)) {
    return {
      ok: false,
      codigo: ERRO_PDF.NAO_E_PDF,
      mensagem: MENSAGEM_ERRO_PDF[ERRO_PDF.NAO_E_PDF],
    }
  }

  return { ok: true, codigo: null, mensagem: '' }
}

/**
 * Valida um arquivo de upload: assinatura + tamanho, IGNORANDO o MIME.
 * Substitui a checagem ingênua `file.type === 'application/pdf'`.
 *
 * @param {File|Blob|ArrayBuffer|Uint8Array} arquivo
 * @returns {Promise<{ ok: boolean, codigo: string|null, mensagem: string, nome: string, mime: string, assinaturaOk: boolean }>}
 */
export const validarArquivoPDF = async (arquivo) => {
  const nome = typeof arquivo?.name === 'string' ? arquivo.name : ''
  const mime = typeof arquivo?.type === 'string' ? arquivo.type : ''
  const tamanho = typeof arquivo?.size === 'number' ? arquivo.size : null

  const base = { nome, mime, assinaturaOk: false }

  if (!arquivo) {
    return { ok: false, codigo: ERRO_PDF.NAO_E_PDF, mensagem: MENSAGEM_ERRO_PDF[ERRO_PDF.NAO_E_PDF], ...base }
  }

  if (tamanho === 0) {
    return { ok: false, codigo: ERRO_PDF.VAZIO, mensagem: MENSAGEM_ERRO_PDF[ERRO_PDF.VAZIO], ...base }
  }

  let bytes
  try {
    bytes = await lerAmostraBytes(arquivo)
  } catch (e) {
    console.warn('[PDF] Falha ao ler os bytes iniciais do arquivo:', e?.message)
    return {
      ok: false,
      codigo: ERRO_PDF.DESCONHECIDO,
      mensagem: MENSAGEM_ERRO_PDF[ERRO_PDF.DESCONHECIDO],
      ...base,
    }
  }

  const resultado = validarBytesPDF(bytes)
  if (resultado.ok) {
    return { ok: true, codigo: null, mensagem: '', ...base, assinaturaOk: true }
  }

  // Sem assinatura: se o MIME ou o nome diziam ser PDF, o mais provável é
  // arquivo corrompido/renomeado — mensagem específica ajuda o usuário.
  const declaradoComoPdf = ehMimePdf(mime) || ehNomePdf(nome)
  if (declaradoComoPdf) {
    return {
      ok: false,
      codigo: ERRO_PDF.CORROMPIDO,
      mensagem: `"${nome || 'arquivo'}" foi enviado como PDF, mas o conteúdo não contém o cabeçalho "%PDF-". Arquivo corrompido, renomeado ou upload incompleto.`,
      ...base,
    }
  }

  return {
    ok: false,
    codigo: ERRO_PDF.NAO_E_PDF,
    mensagem: `O arquivo "${nome || 'selecionado'}" não é um PDF (assinatura "%PDF-" não encontrada).`,
    ...base,
  }
}
