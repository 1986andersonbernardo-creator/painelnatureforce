// ==================== Calculadora de Desconto Nature Force ====================
// Aplica a regra comercial: 20% de desconto sobre a parcela elegível.
// Impostos, tributos e encargos permanecem como responsabilidade do cliente.

export const PERCENTUAL_DESCONTO = 0.2 // 20%

/**
 * Calcula o desconto Nature Force sobre a parcela elegível da fatura.
 *
 * Regra comercial:
 * - Componentes ELEGÍVEIS (recebem 20% de desconto):
 *   - Energia elétrica (consumo)
 *   - Tarifa de Uso do Sistema (TUSD)
 *   - Tarifa de Energia (TE)
 *
 * - Componentes NÃO ELEGÍVEIS (responsabilidade do cliente):
 *   - ICMS, PIS, COFINS (impostos)
 *   - Encargos setoriais (CDE, PROINFA, etc.)
 *   - Iluminação pública
 *   - Créditos/compensação
 *   - Descontos da concessionária
 *   - Outros valores
 *
 * @param {Object} componentes - Componentes classificados da fatura
 * @returns {Object} Resultado do cálculo
 */
export const calcularDesconto = (componentes) => {
  if (!componentes) {
    return {
      ok: false,
      erro: 'Componentes da fatura não fornecidos.',
    }
  }

  // ===== Parcela elegível ao desconto =====
  const valorElegivel =
    (componentes.energia || 0) +
    (componentes.tusd || 0) +
    (componentes.te || 0)

  // ===== Parcela não elegível (impostos, tributos, encargos) =====
  const impostos =
    (componentes.icms || 0) +
    (componentes.pis || 0) +
    (componentes.cofins || 0)

  const encargos =
    (componentes.encargos || 0) +
    (componentes.iluminacao || 0)

  const outros =
    (componentes.creditos || 0) +
    (componentes.descontos || 0) +
    (componentes.outros || 0)

  const impostosTributosEncargos = impostos + encargos + outros

  // ===== Cálculo do desconto =====
  const valorDesconto = valorElegivel * PERCENTUAL_DESCONTO

  // ===== Valor final devido pelo cliente =====
  const valorFinal = (valorElegivel - valorDesconto) + impostosTributosEncargos

  // ===== Validação de segurança =====
  // Se não houver parcela elegível, o cálculo não pode ser concluído
  if (valorElegivel <= 0) {
    return {
      ok: false,
      erro: 'Nenhum componente elegível ao desconto identificado. Fatura requer revisão.',
      requerRevisao: true,
    }
  }

  // Se o valor final for negativo (créditos maiores que o consumo), requer revisão
  if (valorFinal < 0) {
    return {
      ok: false,
      erro: 'Valor final negativo. Créditos superam o consumo. Fatura requer revisão.',
      requerRevisao: true,
    }
  }

  return {
    ok: true,
    valorElegivel: arredondar(valorElegivel),
    percentualDesconto: PERCENTUAL_DESCONTO,
    valorDesconto: arredondar(valorDesconto),
    impostos: arredondar(impostos),
    encargos: arredondar(encargos),
    outros: arredondar(outros),
    impostosTributosEncargos: arredondar(impostosTributosEncargos),
    valorFinal: arredondar(valorFinal),
    formulaUtilizada:
      `Valor final = (Energia + TUSD + TE) − 20% + (ICMS + PIS + COFINS + Encargos + Outros)`,
    requerRevisao: false,
  }
}

/**
 * Arredonda para 2 casas decimais.
 * @param {number} valor
 * @returns {number}
 */
const arredondar = (valor) => Math.round(valor * 100) / 100