// ==================== Deduplicação de Faturas ====================
// Impede que a mesma fatura seja cadastrada duas vezes.
//
// Estratégia de identificação (em ordem de prioridade):
//   1. Hash SHA-256 do conteúdo do arquivo (mesmo arquivo renomeado = duplicada)
//   2. Chave lógica: UC + competência + número da nota fiscal
//
// A verificação é feita ANTES da persistência e a chave fica armazenada
// na própria fatura (hashArquivo / chaveDedupe) para consultas futuras.

/**
 * Calcula o hash SHA-256 (hex) do conteúdo de um arquivo.
 * Usa a Web Crypto API (disponível em browsers modernos e em contextos seguros).
 * @param {File|Blob|ArrayBuffer} arquivo
 * @returns {Promise<string>} Hash hexadecimal (64 caracteres)
 */
export const calcularHashArquivo = async (arquivo) => {
  try {
    const buffer = arquivo instanceof ArrayBuffer ? arquivo : await arquivo.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch (e) {
    // Contexto não seguro ou crypto indisponível — degrada gracefully
    console.warn('[DEDUP] Não foi possível calcular hash do arquivo:', e?.message)
    return null
  }
}

/**
 * Normaliza uma UC para comparação: apenas dígitos, sem espaços/pontos/traços.
 * @param {string|number} uc
 * @returns {string} UC normalizada (somente dígitos) ou '' se vazia
 */
export const normalizarUC = (uc) => {
  if (uc === null || uc === undefined) return ''
  return String(uc).replace(/\D/g, '')
}

/**
 * Gera a chave lógica de deduplicação da fatura.
 * Formato: uc|referencia|numeroNota (valores ausentes viram '-')
 * @param {Object} params - { uc, referencia, numeroNota }
 * @returns {string} Chave determinística
 */
export const gerarChaveDedupe = ({ uc, referencia, numeroNota }) => {
  const normUC = normalizarUC(uc) || '-'
  const ref = (referencia || '-').toString().trim()
  const nota = (numeroNota || '-').toString().trim()
  return `${normUC}|${ref}|${nota}`
}

/**
 * Verifica se já existe fatura igual na lista fornecida.
 * @param {Array<Object>} faturasExistentes - Faturas já persistidas
 * @param {Object} identificacao - { hashArquivo, chaveDedupe }
 * @returns {Object|null} A fatura duplicada encontrada, ou null
 */
export const encontrarFaturaDuplicada = (faturasExistentes, { hashArquivo, chaveDedupe }) => {
  if (!Array.isArray(faturasExistentes)) return null

  // 1. Mesmo conteúdo de arquivo (mais forte)
  if (hashArquivo) {
    const porHash = faturasExistentes.find((f) => f.hashArquivo === hashArquivo)
    if (porHash) return porHash
  }

  // 2. Mesma UC + competência + nota (lógica)
  if (chaveDedupe && chaveDedupe !== '-|-|-') {
    const porChave = faturasExistentes.find(
      (f) => f.chaveDedupe === chaveDedupe && f.status !== 'erro',
    )
    if (porChave) return porChave
  }

  return null
}

// ==================== Idempotência forte ====================
// A chave de idempotência combina a chave lógica (UC|referencia|nota) com o hash
// do arquivo. A mesma fatura (mesmo arquivo renomeado OU mesmo mês/UC/nota) nunca
// é cadastrada duas vezes. Essa chave é persistida na própria fatura e gera um ID
// determinístico no Firestore (impede duplicação mesmo em concorrência/reatribuição).

/**
 * Monta a chave de idempotência canônica da fatura.
 * Formato: {uc|referencia|nota}#{hashArquivo}
 * @param {Object} params - { uc, referencia, numeroNota, hashArquivo }
 * @returns {string} Chave canônica
 */
export const montarChaveIdempotencia = ({ uc, referencia, numeroNota, hashArquivo }) => {
  const chaveLogica = gerarChaveDedupe({ uc, referencia, numeroNota })
  const hash = (hashArquivo || '').toString().trim()
  const base = chaveLogica !== '-|-|-'
    ? chaveLogica
    : hash || '-'
  return `${base}#${hash}`
}

/**
 * Hash determinístico e síncrono (FNV-1a 32 bits) para gerar IDs de documento.
 * Não depende da Web Crypto, funciona em qualquer runtim
 * @param {string} str
 * @returns {string} Hex de 8 dígitos
 */
export const hashDeterministico = (str) => {
  let h = 2166136261
  const s = String(str ?? '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Gera um ID determinístico para a fatura no Firestore.
 * Faturas idênticas produzem o mesmo ID → o mesmo documento (idempotência por natureza).
 * @param {object} params - { uc, referencia, numeroNota, hashArquivo }
 * @returns {string} ID determinístico (prefixo "fat_")
 */
export const gerarIdFatura = (params) => `fat_${hashDeterministico(montarChaveIdempotencia(params))}`

/**
 * Verifica se já existe fatura igual pela chave de idempotência ou hash do arquivo.
 * @param {Array<Object>} faturasExistentes
 * @param {object} params - { uc, referencia, numeroNota, hashArquivo }
 * @returns {Object|null} Fatura duplicada ou null
 */
export const encontrarDuplicadaPorIdempotencia = (faturasExistentes, params) => {
  if (!Array.isArray(faturasExistentes)) return null

  const chave = montarChaveIdempotencia(params)
  if (chave && chave !== '#-#') {
    const porChave = faturasExistentes.find((f) => f.chaveIdempotencia === chave)
    if (porChave) return porChave
  }

  // Reforço: mesmo hash de arquivo
  const hash = (params.hashArquivo || '').toString().trim()
  if (hash) {
    const porArquivo = faturasExistentes.find((f) => f.hashArquivo === hash)
    if (porArquivo) return porArquivo
  }

  return null
}