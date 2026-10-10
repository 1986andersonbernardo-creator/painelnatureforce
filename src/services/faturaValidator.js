// ==================== Validador de Fatura ====================
// Valida a integridade dos dados extraídos e do cálculo realizado.

import {
  normalizarReferencia,
  normalizarVencimento,
  vencimentoValido,
} from './faturaNormalizacao.js'

/**
 * Valida se os dados extraídos da fatura são consistentes.
 * @param {Object} componentes - Componentes classificados
 * @param {Object} calculo - Resultado do cálculo
 * @returns {Object} { valido: boolean, erros: string[] }
 */
export const validarFatura = (componentes, calculo) => {
  const erros = []

  // ===== Validação de identificação =====
  if (!componentes.uc) erros.push('UC não identificada')
  if (!componentes.cliente) erros.push('Cliente não identificado')
  const referenciaNormalizada = normalizarReferencia(componentes.referencia)
  if (!componentes.referencia) {
    erros.push('Mês de referência não identificado')
  } else if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(referenciaNormalizada)) {
    erros.push('Mês de referência inválido')
  }

  const vencimentoNormalizado = normalizarVencimento(componentes.vencimento)
  if (!componentes.vencimento) {
    erros.push('Vencimento não identificado')
  } else if (
    !/^\d{4}-\d{2}-\d{2}$/.test(vencimentoNormalizado) ||
    !vencimentoValido(componentes.vencimento)
  ) {
    erros.push('Vencimento inválido')
  }
  if (!componentes.consumo) erros.push('Consumo (kWh) não identificado')

  // ===== Validação de componentes =====
  const temEnergia = componentes.energia !== null || componentes.tusd !== null || componentes.te !== null
  if (!temEnergia) erros.push('Nenhum componente de energia identificado')

  // ===== Validação do cálculo =====
  if (calculo && !calculo.ok) {
    erros.push(calculo.erro || 'Cálculo não concluído')
  }

  if (calculo && calculo.ok) {
    // Verifica se o valor final é positivo
    if (calculo.valorFinal < 0) {
      erros.push('Valor final negativo — créditos superam o consumo')
    }

    // Verifica se o desconto é exatamente 20%
    if (calculo.percentualDesconto !== 0.2) {
      erros.push('Percentual de desconto diferente de 20%')
    }

    // Verifica consistência: valorFinal = (elegivel - desconto) + naoElegivel
    const esperado = (calculo.valorElegivel - calculo.valorDesconto) + calculo.impostosTributosEncargos
    if (Math.abs(esperado - calculo.valorFinal) > 0.01) {
      erros.push('Inconsistência no cálculo do valor final')
    }
  }

  return {
    valido: erros.length === 0,
    erros,
  }
}

/**
 * Determina o status da fatura com base na validação.
 * @param {Object} validacao - Resultado da validação
 * @returns {string} Status da fatura
 */
export const determinarStatus = (validacao) => {
  if (!validacao.valido) {
    return 'requer revisão'
  }
  return 'disponivel'
}