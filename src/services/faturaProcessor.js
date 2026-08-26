// ==================== Orquestrador de Processamento de Fatura ====================
// Pipeline completo: PDF → texto → classificação → cálculo → validação.

import { extrairTextoDoPDF } from './pdfProcessor'
import { classificarFatura, verificarCompletude } from './faturaClassifier'
import { calcularDesconto } from './descontoCalculator'
import { validarFatura, determinarStatus } from './faturaValidator'

/**
 * Processa uma fatura completa a partir do arquivo PDF.
 * @param {File|Blob|ArrayBuffer} arquivoPDF - Arquivo PDF da fatura
 * @returns {Promise<Object>} Resultado do processamento
 */
export const processarFatura = async (arquivoPDF) => {
  try {
    // 1. Extrai o texto do PDF
    const texto = await extrairTextoDoPDF(arquivoPDF)

    // 2. Classifica os componentes da fatura
    const componentes = classificarFatura(texto)

    if (componentes.erro) {
      return {
        ok: false,
        status: 'requer revisão',
        erro: componentes.erro,
        componentes: null,
        calculo: null,
        validacao: { valido: false, erros: [componentes.erro] },
      }
    }

    // 3. Verifica completude dos dados
    const completude = verificarCompletude(componentes)

    // 4. Calcula o desconto de 20%
    const calculo = calcularDesconto(componentes)

    // 5. Valida a fatura
    const validacao = validarFatura(componentes, calculo)

    // 6. Determina o status
    const status = determinarStatus(validacao)

    return {
      ok: validacao.valido,
      status,
      componentes,
      calculo,
      validacao,
      completude,
      textoExtraido: texto,
    }
  } catch (error) {
    console.error('Erro no processamento da fatura:', error)
    return {
      ok: false,
      status: 'erro',
      erro: error.message || 'Erro ao processar a fatura.',
      componentes: null,
      calculo: null,
      validacao: { valido: false, erros: [error.message || 'Erro ao processar a fatura.'] },
    }
  }
}

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
 * @returns {string} Data no formato ISO
 */
export const normalizarVencimento = (vencimento) => {
  if (!vencimento) return ''
  const match = vencimento.match(/(\d{2})\/(\d{2})\/(\d{4})/)
  if (match) return `${match[3]}-${match[2]}-${match[1]}`
  return vencimento
}