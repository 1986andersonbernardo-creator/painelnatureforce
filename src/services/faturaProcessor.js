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

// Reexporta as normalizações puras (módulo pequeno, sem dependência do pdf.js).
export { normalizarReferencia, normalizarVencimento } from './faturaNormalizacao'