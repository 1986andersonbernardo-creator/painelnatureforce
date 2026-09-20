// ==================== Classificador de Componentes da Fatura ====================
// Analisa o texto extraído do PDF e identifica os componentes da fatura de energia.
// Classifica cada componente como elegível ou não elegível ao desconto Nature Force.
// Suporta faturas da Neoenergia (Celpe, Coelba, Cosern, Elektro) e outras concessionárias.
//
// Sistema de confiança: campos-chave recebem status
//   CONFIRMADO        → padrão específico e confiável casou
//   REVISAR           → padrão genérico/fraco casou (requer conferência humana)
//   NAO_IDENTIFICADO  → campo ausente no PDF (valor null — nunca inventar dados)

// Função auxiliar para converter string em número
const paraNumero = (valor) => {
  if (!valor) return null
  const limpo = String(valor).replace(/\./g, '').replace(',', '.')
  const num = parseFloat(limpo)
  return isNaN(num) ? null : num
}

// ==================== Extração da UC (Unidade Consumidora) ====================
// A UC é o identificador PRINCIPAL de uma fatura. Nas faturas reais o rótulo e
// o valor quase sempre ficam em LINHAS DIFERENTES:
//
//   NÚMERO DA UNIDADE CONSUMIDORA
//   1234567890
//
// Por isso a extração precisa do texto com as linhas reconstruídas
// (ver pdfTextLayout.reconstruirLinhas).

// Rótulo da UC/instalação sozinho na linha (o valor vem na linha seguinte).
const RE_UC_ROTULO =
  /^\s*(?:n[úu]mero\s+(?:da|de)\s+)?(?:unidade\s+consumidora(?:\s*\(uc\))?|uc|c[óo]digo\s+da\s+instala[cç][ãa]o)\s*[:\-.]?\s*$/i

// Valor "solto" na linha seguinte: "1234567890", "2.014.249.014-06"
// Exige pelo menos 6 dígitos para não confundir com códigos curtos de tabela.
const RE_UC_VALOR_LINHA = /^\s*(\d[\d.\-/\s]{5,25}\d)\s*$/

/**
 * Tenta extrair a UC a partir de uma linha e da linha seguinte.
 * @param {string} linha - Linha atual (já reconstruída)
 * @param {string} [proximaLinha] - Linha imediatamente abaixo
 * @returns {{ uc: string, confianca: 'CONFIRMADO' }|null}
 */
export const extrairUCDaLinha = (linha, proximaLinha = '') => {
  const l = String(linha ?? '').trim()
  if (!l) return null

  // (1) Formato explícito na MESMA linha: "UC 123456789"
  //     ou "Unidade Consumidora: 123456789"
  let m = l.match(
    /(?:^|\b)(?:UC|Unidade Consumidora|Unidade Consumidora \(UC\))[:\s nºº]*([0-9][0-9.\-\s]{5,20}[0-9])/i,
  )
  if (m) return { uc: m[1].replace(/[^\d]/g, ''), confianca: 'CONFIRMADO' }

  // (2) "numero da unidade consumidora e 2.014.249.014-06"
  m = l.match(
    /(?:n[uú]mero da unidade consumidora|[uú]nidade consumidora)[:\s]*(?:[ée])?\s*([0-9][0-9.\-/]{5,25})/i,
  )
  if (m) return { uc: m[1].replace(/[^\d]/g, ''), confianca: 'CONFIRMADO' }

  // (3) Rótulo em uma linha e VALOR na linha seguinte (layout mais comum)
  if (RE_UC_ROTULO.test(l)) {
    const mv = String(proximaLinha ?? '').trim().match(RE_UC_VALOR_LINHA)
    if (mv) return { uc: mv[1].replace(/[^\d]/g, ''), confianca: 'CONFIRMADO' }
  }

  return null
}

/**
 * Percorre todo o texto (linha a linha, com a linha seguinte como apoio)
 * e devolve a primeira UC confiável encontrada.
 * @param {string} texto - Texto extraído do PDF (linhas preservadas)
 * @returns {{ uc: string, confianca: 'CONFIRMADO' }|null}
 */
export const extrairUC = (texto) => {
  if (!texto) return null

  const linhas = String(texto).split('\n')
  for (let i = 0; i < linhas.length; i++) {
    const encontrada = extrairUCDaLinha(linhas[i], linhas[i + 1] || '')
    if (encontrada) return encontrada
  }

  return null
}

/**
 * Classifica os componentes da fatura a partir do texto extraído do PDF.
 * Processa linha por linha para identificar os itens da fatura.
 * @param {string} texto - Texto extraído do PDF
 * @returns {Object} Componentes classificados (+ campo `confiancas`)
 */
export const classificarFatura = (texto) => {
  if (!texto || texto.trim().length === 0) {
    return { erro: 'Texto do PDF vazio ou inválido.' }
  }

  const linhas = texto.split('\n')
  const componentes = {
    // Identificação
    uc: null,
    cliente: null,
    cpfCnpj: null,
    referencia: null,
    vencimento: null,
    consumo: null,

    // Unidade consumidora (extras)
    numeroInstalacao: null,
    numeroCliente: null,
    numeroMedidor: null,
    endereco: null,

    // Fatura (extras)
    numeroNota: null,
    dataEmissao: null,

    // Componentes elegíveis ao desconto
    energia: null,
    tusd: null,
    te: null,

    // Impostos (não elegíveis)
    icms: null,
    pis: null,
    cofins: null,

    // Encargos (não elegíveis)
    encargos: 0,
    iluminacao: null,

    // Créditos/Descontos (não elegíveis)
    creditos: null,
    creditosKwh: null,
    descontos: null,

    // Outros (não elegíveis)
    outros: 0,
  }

  // Confiança por campo-chave (nunca inventar percentuais: usar status)
  const confiancas = {
    uc: 'NAO_IDENTIFICADO',
    cliente: 'NAO_IDENTIFICADO',
    cpfCnpj: 'NAO_IDENTIFICADO',
    consumo: 'NAO_IDENTIFICADO',
    referencia: 'NAO_IDENTIFICADO',
    vencimento: 'NAO_IDENTIFICADO',
  }

  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i].trim()
    if (!l) continue

    // Próxima linha (para campos onde o valor está na linha seguinte)
    const proxima = (linhas[i + 1] || '').trim()

    // ===== Identificação =====

    // Código do cliente (Neoenergia) — usado como UC quando não há "UC" explícito
    if (!componentes.numeroCliente) {
      let m = l.match(/C[ÓO]DIGO DO CLIENTE[:\s]*([0-9]{6,12})/i)
      if (!m) m = l.match(/C[ÓO]DIGO DO CLIENTE[:\s]*$/i) && /^[0-9]{6,12}$/.test(proxima)
        ? [null, proxima]
        : null
      if (m) componentes.numeroCliente = m[1]
    }

    // UC / Código da instalação
    if (!componentes.uc) {
      // Mesma linha ("UC 123456789") ou valor na LINHA SEGUINTE
      // ("NÚMERO DA UNIDADE CONSUMIDORA" \n "1234567890").
      const ucEncontrada = extrairUCDaLinha(l, proxima)
      if (ucEncontrada) {
        componentes.uc = ucEncontrada.uc
        confiancas.uc = ucEncontrada.confianca
      }
    }
    if (!componentes.uc && componentes.numeroCliente) {
      // Fallback Neoenergia: código do cliente funciona como identificador da UC
      componentes.uc = componentes.numeroCliente
      confiancas.uc = 'REVISAR'
    }

    // Código da instalação
    if (!componentes.numeroInstalacao) {
      let m = l.match(/C[ÓO]DIGO DA INSTALA[CÇ][ÃA]O[:\s]*([0-9]{5,15})/i)
      if (!m) {
        m = l.match(/C[ÓO]DIGO DA INSTALA[CÇ][ÃA]O[:\s]*$/i)
        if (m && /^[0-9]{5,15}$/.test(proxima)) m = [null, proxima]
      }
      if (m) componentes.numeroInstalacao = m[1]
    }

    // CPF/CNPJ (pode vir mascarado: 083.2**.***-**)
    if (!componentes.cpfCnpj) {
      const m = l.match(/(?:CPF|CNPJ|CPF\/CNPJ)[:\s]*([0-9*.\-/]{9,20})/i)
      if (m) {
        componentes.cpfCnpj = m[1].trim()
        // Mascarado (contém *) exige revisão humana
        confiancas.cpfCnpj = m[1].includes('*') ? 'REVISAR' : 'CONFIRMADO'
      }
    }

    // Cliente
    if (!componentes.cliente) {
      // Formato: "NOME DO CLIENTE: THIAGO TIERRY PATRIOTA LIMA" (mesma linha)
      let m = l.match(/(?:NOME DO CLIENTE|Cliente|Consumidor|Titular)[:\s]*([A-ZÀ-Úa-zà-ú\s]+?)(?:\n|$)/i)
      if (m && m[1].trim().length > 2) {
        componentes.cliente = m[1].trim()
        confiancas.cliente = 'CONFIRMADO'
      } else {
        // Formato: "NOME DO CLIENTE:\nTHIAGO TIERRY PATRIOTA LIMA" (linha seguinte)
        m = l.match(/(?:NOME DO CLIENTE|Cliente|Consumidor|Titular)[:\s]*$/i)
        if (m && /^[A-ZÀ-Úa-zà-ú\s]{3,}$/.test(proxima)) {
          componentes.cliente = proxima
          confiancas.cliente = 'CONFIRMADO'
        }
      }
    }

    // Endereço (bloco multilinha após "ENDEREÇO:")
    if (!componentes.endereco) {
      if (/ENDERE[CÇ]O[:\s]*$/i.test(l)) {
        // Coleta até 4 linhas seguintes não vazias
        const partes = []
        for (let j = i + 1; j < Math.min(i + 6, linhas.length); j++) {
          const linhaEnd = linhas[j]?.trim()
          if (linhaEnd) partes.push(linhaEnd)
          if (partes.length >= 4) break
        }
        if (partes.length > 0) {
          componentes.endereco = partes.join(', ')
          // Tenta separar cidade/estado/cep do bloco
          const bloco = partes.join(' ')
          const mCep = bloco.match(/(\d{5}-\d{3})/)
          if (mCep) componentes.cep = mCep[1]
          const mCidadeUf = bloco.match(/([A-ZÀ-Úa-zà-ú\s]+)\s*\/\s*([A-Z]{2})\b/)
          if (mCidadeUf) {
            componentes.cidade = mCidadeUf[1].trim()
            componentes.estado = mCidadeUf[2].toUpperCase()
          }
        }
      }
    }

    // Referência (REF:MÊS/ANO, Referência, Competência, etc.)
    if (!componentes.referencia) {
      // Formato: "REF:MÊS/ANO 07/2026" (mesma linha)
      let m = l.match(/(?:REF:MÊS\/ANO|REF:MES\/ANO|Referente a|Referência|Referencia|Competência|Competencia|Mês de referência|Mes de referencia)[:\s]*([A-Z]{3}\/\d{4}|\d{2}\/\d{4}|\d{4}-\d{2})/i)
      if (m) {
        componentes.referencia = m[1]
        confiancas.referencia = 'CONFIRMADO'
      } else {
        // Formato: "REF:MÊS/ANO\n07/2026" (linha seguinte)
        m = l.match(/(?:REF:MÊS\/ANO|REF:MES\/ANO|Referente a|Referência|Referencia|Competência|Competencia|Mês de referência|Mes de referencia)[:\s]*$/i)
        if (m && /^(\d{2}\/\d{4}|\d{4}-\d{2}|[A-Z]{3}\/\d{4})$/i.test(proxima)) {
          componentes.referencia = proxima
          confiancas.referencia = 'CONFIRMADO'
        }
      }
    }

    // Vencimento
    if (!componentes.vencimento) {
      // Formato: "VENCIMENTO 26/08/2026" (mesma linha)
      let m = l.match(/(?:Vencimento|Venc\.)[:\s]*(\d{2}\/\d{2}\/\d{4})/i)
      if (m) {
        componentes.vencimento = m[1]
        confiancas.vencimento = 'CONFIRMADO'
      } else {
        // Formato: "VENCIMENTO\n26/08/2026" (linha seguinte)
        m = l.match(/(?:Vencimento|Venc\.)[:\s]*$/i)
        if (m && /^\d{2}\/\d{2}\/\d{4}$/.test(proxima)) {
          componentes.vencimento = proxima
          confiancas.vencimento = 'CONFIRMADO'
        }
      }
    }

    // Data de emissão
    if (!componentes.dataEmissao) {
      const m = l.match(/DATA DE EMISS[ÃA]O[:\s]*(\d{2}\/\d{2}\/\d{4})/i)
      if (m) componentes.dataEmissao = m[1]
    }

    // Número da nota fiscal
    if (!componentes.numeroNota) {
      const m = l.match(/NOTA FISCAL N?[°º]?\s*([0-9]{5,15})/i)
      if (m) componentes.numeroNota = m[1]
    }

    // Número do medidor (sequência longa antes de "Energia Ativa")
    if (!componentes.numeroMedidor) {
      const m = l.match(/^\s*(\d{8,15})\s+Energia Ativa/i)
      if (m) componentes.numeroMedidor = m[1]
    }

    // Consumo faturado (tabela de consumo mensal: "JUL26 189 31")
    if (!componentes.consumo) {
      const m = l.match(/(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\d{2}\s+([0-9.,]+)\s+\d+/i)
      if (m) {
        componentes.consumo = paraNumero(m[1])
        confiancas.consumo = 'CONFIRMADO'
      }
    }

    // Consumo (padrão geral)
    if (!componentes.consumo) {
      const m = l.match(/(?:CONSUMO FATURADO|Consumo|Energia consumida)[:\s]*([0-9.,]+)/i)
      if (m) {
        componentes.consumo = paraNumero(m[1])
        confiancas.consumo = 'REVISAR'
      } else {
        // Formato: "CONSUMO FATURADO" \n "188,75" (valor na LINHA SEGUINTE)
        const mRotulo = l.match(/(?:CONSUMO FATURADO|Consumo|Energia consumida)\s*[:\s]*$/i)
        const mValor = proxima.match(/^([0-9][0-9.,]*)\s*(?:k?wh)?$/i)
        if (mRotulo && mValor) {
          componentes.consumo = paraNumero(mValor[1])
          confiancas.consumo = 'REVISAR'
        }
      }
    }

    // ===== Componentes de energia (elegíveis) =====

    // Energia Ativa (medidor): "Energia Ativa Único 16.602,00 16.925,00 1,00000 188,75"
    if (!componentes.energia) {
      const m = l.match(/Energia Ativa\s+[A-ZÀ-Úa-zà-ú]+\s+[0-9.,]+\s+[0-9.,]+\s+[0-9.,]+\s+([0-9.,]+)/i)
      if (m) componentes.energia = paraNumero(m[1])
    }

    // Energia (padrão geral)
    if (!componentes.energia) {
      const m = l.match(/(?:Energia Elétrica|Energia\s+Consumida|Consumo de Energia)[:\s]*([0-9.,]+)/i)
      if (m) componentes.energia = paraNumero(m[1])
    }

    // TUSD: "Consumo-TUSDkWh 188,75 0,72048386 135,99 7,10 135,99 20,50 27,88 0,53521000"
    if (!componentes.tusd) {
      const m = l.match(/Consumo-TUSDkWh\s+[0-9.,]+\s+[0-9.,]+\s+([0-9.,]+)/i)
      if (m) componentes.tusd = paraNumero(m[1])
    }

    // TUSD (padrão geral)
    if (!componentes.tusd) {
      const m = l.match(/(?:TUSD|Tarifa de Uso do Sistema|Uso do Sistema de Distribuição)[:\s]*([0-9.,]+)/i)
      if (m) componentes.tusd = paraNumero(m[1])
    }

    // TE: "Consumo-TEkWh 188,75 0,35491782 66,99 3,49 66,99 20,50 13,73 0,26365000"
    if (!componentes.te) {
      const m = l.match(/Consumo-TEkWh\s+[0-9.,]+\s+[0-9.,]+\s+([0-9.,]+)/i)
      if (m) componentes.te = paraNumero(m[1])
    }

    // TE (padrão geral)
    if (!componentes.te) {
      const m = l.match(/(?:TE|Tarifa de Energia|Energia\s+\(TE\))[:\s]*([0-9.,]+)/i)
      if (m) componentes.te = paraNumero(m[1])
    }

    // ===== Impostos (não elegíveis) =====
    // Formato: "ICMS 236,01 20,50 48,37" → captura o último número (valor do imposto)

    // ICMS
    if (!componentes.icms) {
      const m = l.match(/ICMS\s+[0-9.,]+\s+[0-9.,]+\s+([0-9.,]+)/i)
      if (m) componentes.icms = paraNumero(m[1])
    }

    // PIS
    if (!componentes.pis) {
      const m = l.match(/PIS\s+[0-9.,]+\s+[0-9.,]+\s+([0-9.,]+)/i)
      if (m) componentes.pis = paraNumero(m[1])
    }

    // COFINS
    if (!componentes.cofins) {
      const m = l.match(/COFINS\s+[0-9.,]+\s+[0-9.,]+\s+([0-9.,]+)/i)
      if (m) componentes.cofins = paraNumero(m[1])
    }

    // ===== Encargos (não elegíveis) =====
    // "Acrés. Band. AMARELA 4,77" e "TUSD GDII com trib. 28,26"
    const mEncargo = l.match(/(?:Acrés\. Band\.|Acres\. Band\.|TUSD GDII)[^0-9]*([0-9.,]+)/i)
    if (mEncargo) componentes.encargos += paraNumero(mEncargo[1]) || 0

    // Encargos (padrão geral)
    const mEncargoGeral = l.match(/(?:Encargos|Encargo|CDE|PROINFA|Conta de Desenvolvimento Energético)[^0-9]*([0-9.,]+)/i)
    if (mEncargoGeral) componentes.encargos += paraNumero(mEncargoGeral[1]) || 0

    // ===== Iluminação (não elegível) =====
    // "Ilum. Púb. Municipal 28,39"
    if (!componentes.iluminacao) {
      const m = l.match(/(?:Ilum\. Púb\.|Ilum\. Pub\.|Iluminação Pública|Contribuição de Iluminação|CIP)[^0-9]*([0-9.,]+)/i)
      if (m) componentes.iluminacao = paraNumero(m[1])
    }

    // ===== Créditos (energia compensada — GD) =====
    // "creditos utilizados 134,25 kWh" / "Excedente 0 kWh e creditos utilizados 134,25 kWh"
    if (!componentes.creditosKwh) {
      const m = l.match(/cr[eé]ditos utilizados\s+([0-9.,]+)\s*k?wh/i)
      if (m) componentes.creditosKwh = paraNumero(m[1])
    }
    if (!componentes.creditos) {
      const m = l.match(/(?:Crédito|Credito|Compensação|Compensacao|Energia Injetada|Energia Compensada)[:\s]*([0-9.,]+)/i)
      if (m) componentes.creditos = paraNumero(m[1])
    }

    if (!componentes.descontos) {
      const m = l.match(/(?:Desconto|Subsídio|Subsidio|Bônus|Bonus)[:\s]*([0-9.,]+)/i)
      if (m) componentes.descontos = paraNumero(m[1])
    }

    // ===== Outros (multa, juros) =====
    // "Multa-NF 413225874 1,41" e "Juros-NF 413225874 0,04"
    // Captura o ÚLTIMO número da linha (o valor), ignorando números de documento
    const mOutro = l.match(/(?:Multa|Juros).*?([0-9]+[.,][0-9]{2})\s*$/i)
    if (mOutro) componentes.outros += paraNumero(mOutro[1]) || 0

    // Outros (padrão geral)
    const mOutroGeral = l.match(/(?:Outros|Demais|Taxa|Taxas)[^0-9]*([0-9.,]+)/i)
    if (mOutroGeral) componentes.outros += paraNumero(mOutroGeral[1]) || 0
  }

  // Verifica se pelo menos um componente de energia foi identificado
  const temEnergia = componentes.energia !== null || componentes.tusd !== null || componentes.te !== null
  if (!temEnergia) {
    componentes.erro = 'Nenhum componente de energia identificado na fatura.'
  }

  // Anexa o mapa de confiança (campos-chave)
  componentes.confiancas = confiancas

  return componentes
}

/**
 * Verifica se todos os campos obrigatórios foram identificados.
 * @param {Object} componentes - Componentes classificados
 * @returns {Object} { completo: boolean, faltantes: string[] }
 */
export const verificarCompletude = (componentes) => {
  const faltantes = []

  if (!componentes.uc) faltantes.push('UC')
  if (!componentes.cliente) faltantes.push('Cliente')
  if (!componentes.referencia) faltantes.push('Mês de referência')
  if (!componentes.vencimento) faltantes.push('Vencimento')
  if (!componentes.consumo) faltantes.push('Consumo (kWh)')

  // Pelo menos um componente de energia é obrigatório
  const temEnergia = componentes.energia !== null || componentes.tusd !== null || componentes.te !== null
  if (!temEnergia) faltantes.push('Energia/Consumo')

  return {
    completo: faltantes.length === 0,
    faltantes,
  }
}