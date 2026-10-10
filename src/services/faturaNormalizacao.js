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
  const texto = String(referencia).trim()

  // Formato: "AGO/2026"
  const meses = {
    JAN: '01', FEV: '02', MAR: '03', ABR: '04', MAI: '05', JUN: '06',
    JUL: '07', AGO: '08', SET: '09', OUT: '10', NOV: '11', DEZ: '12',
  }
  const matchMesAno = texto.match(/^([A-Z]{3})\/(\d{4})$/i)
  if (matchMesAno) {
    const mes = meses[matchMesAno[1].toUpperCase()]
    if (mes && Number(matchMesAno[2]) > 0) return `${matchMesAno[2]}-${mes}`
  }

  // Formato: "08/2026"
  const matchNum = texto.match(/^(\d{2})\/(\d{4})$/)
  if (matchNum && Number(matchNum[1]) >= 1 && Number(matchNum[1]) <= 12 && Number(matchNum[2]) > 0) {
    return `${matchNum[2]}-${matchNum[1]}`
  }

  // Formato: "2026-08"
  const matchISO = texto.match(/^(\d{4})-(\d{2})$/)
  if (matchISO && Number(matchISO[1]) > 0 && Number(matchISO[2]) >= 1 && Number(matchISO[2]) <= 12) {
    return `${matchISO[1]}-${matchISO[2]}`
  }

  return texto
}

const dataValida = (ano, mes, dia) => {
  if (ano < 1 || mes < 1 || mes > 12 || dia < 1) return false
  const bissexto = ano % 4 === 0 && (ano % 100 !== 0 || ano % 400 === 0)
  const diasNoMes = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return dia <= diasNoMes[mes - 1]
}

/**
 * Converte a data de vencimento extraída (ex: "18/09/2026") para formato ISO.
 * @param {string} vencimento - Data extraída do PDF
 * @returns {string} Data no formato "YYYY-MM-DD"
 */
export const normalizarVencimento = (vencimento) => {
  if (!vencimento) return ''
  const texto = String(vencimento).trim()
  const matchBR = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (matchBR) {
    const [, dia, mes, ano] = matchBR
    if (dataValida(Number(ano), Number(mes), Number(dia))) return `${ano}-${mes}-${dia}`
    return texto
  }

  const matchISO = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (matchISO && dataValida(Number(matchISO[1]), Number(matchISO[2]), Number(matchISO[3]))) {
    return texto
  }

  return texto
}

export const vencimentoValido = (vencimento) => {
  const normalizado = normalizarVencimento(vencimento)
  const match = normalizado.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return Boolean(
    match && dataValida(Number(match[1]), Number(match[2]), Number(match[3])),
  )
}