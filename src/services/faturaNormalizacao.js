// ==================== Normalização de campos extraídos do PDF ====================
// Módulo PEQUENO e puro: fica separado do `faturaProcessor` para que a
// autenticação/estado não precise carregar o pdf.js (~1,5 MB) — o processador é
// importado dinamicamente, apenas quando um PDF é realmente importado.

/**
 * Converte a referência extraída (ex: "AGO/2026" ou "08/2026") para o formato "2026-08".
 * @param {string} referencia - Referência extraída do PDF
 * @returns {string} Referência no formato "YYYY-MM"
 */
export const normalizarReferencia = (referencia) => {
  if (!referencia) return ''

  // Formato: "AGO/2026"
  const meses = {
    JAN: '01', FEV: '02', MAR: '03', ABR: '04', MAI: '05', JUN: '06',
    JUL: '07', AGO: '08', SET: '09', OUT: '10', NOV: '11', DEZ: '12',
  }
  const matchMesAno = referencia.match(/([A-Z]{3})\/(\d{4})/i)
  if (matchMesAno) {
    const mes = meses[matchMesAno[1].toUpperCase()]
    if (mes) return `${matchMesAno[2]}-${mes}`
  }

  // Formato: "08/2026"
  const matchNum = referencia.match(/(\d{2})\/(\d{4})/)
  if (matchNum) return `${matchNum[2]}-${matchNum[1]}`

  // Formato: "2026-08"
  const matchISO = referencia.match(/(\d{4})-(\d{2})/)
  if (matchISO) return `${matchISO[1]}-${matchISO[2]}`

  return referencia
}

/**
 * Converte a data de vencimento extraída (ex: "18/09/2026") para formato ISO.
 * @param {string} vencimento - Data extraída do PDF
 * @returns {string} Data no formato "YYYY-MM-DD"
 */
export const normalizarVencimento = (vencimento) => {
  if (!vencimento) return ''
  const match = vencimento.match(/(\d{2})\/(\d{2})\/(\d{4})/)
  if (match) return `${match[3]}-${match[2]}-${match[1]}`
  return vencimento
}