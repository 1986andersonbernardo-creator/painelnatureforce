// ==================== Identificação da Fatura (Unidade Consumidora → Cliente) ====================
// Motor puro e testável que decide a que UNIDADE CONSUMIDORA e a que CLIENTE
// uma fatura extraída pertence.
//
// REGRAS FUNDAMENTAIS (regra de negócio):
//   - A UC é o identificador PRINCIPAL. Cliente ≠ Titular ≠ Unidade Consumidora.
//   - NUNCA associar uma fatura apenas porque o nome do titular coincide.
//   - NUNCA criar cliente/inventar dados automaticamente.
//   - Se houver ambiguidade ou incompatibilidade → REVISAO_MANUAL.
//
// ESTRATÉGIA DE PRIORIDADE:
//   1. Número da Unidade Consumidora (numeroUC / codigoInstalacao)
//   2. Cliente vinculado à UC (via vínculo numeroUC → clienteId)
//   3-6. Titular, CPF/CNPJ, endereço e medidor são usados APENAS como apoio
//        para indicar candidatos à revisão humana — nunca como decisão automática.

import { normalizarUC } from './faturaDedup.js'
import { MOTIVO_REVISAO } from './faturaStatus.js'

// Resultado da decisão
export const DECISAO = Object.freeze({
  PROCESSADO: 'PROCESSADO', // UC única + compatível + cliente vinculado
  REVISAO_MANUAL: 'REVISAO_MANUAL', // requer análise humana
  ERRO_EXTRACAO: 'ERRO_EXTRACAO', // sem dados confiáveis de identificação
})

// Normaliza CPF/CNPJ para comparação (somente dígitos)
const normalizarDoc = (valor) =>
  valor == null ? '' : String(valor).replace(/\D/g, '')

// Normaliza nome para comparação (lowercase, espaços únicos)
const normalizarNome = (valor) =>
  valor == null ? '' : String(valor).toLowerCase().replace(/\s+/g, ' ').trim()

// Normaliza endereço para comparação (só letras/números, espaços únicos)
const normalizarEndereco = (valor) =>
  valor == null
    ? ''
    : String(valor)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

// Verifica se uma unidade corresponde a uma UC (númeroUC ou código de instalação)
const unidadePorUC = (unidade, uc) => {
  const n = normalizarUC(uc)
  if (!n) return false
  return (
    normalizarUC(unidade?.numeroUC) === n ||
    normalizarUC(unidade?.codigoInstalacao) === n
  )
}

// Busca candidatas por dados secundários (titular/CPF/endereço/medidor).
// Retorna ordenado por pontuação; nunca decide sozinho — apenas subsidia revisão.
const buscarCandidatasSecundarias = (componentes, unidades) => {
  const cpfFatura = normalizarDoc(componentes.cpfCnpj)
  const titularFatura = normalizarNome(componentes.cliente)
  const enderecoFatura = normalizarEndereco(componentes.endereco)
  const medidorFatura = normalizarUC(componentes.numeroMedidor)

  const pontuar = (u) => {
    let pontos = 0
    if (
      cpfFatura &&
      (normalizarDoc(u.titularCpfCnpj) === cpfFatura ||
        normalizarDoc(u.cpfCnpj) === cpfFatura)
    ) {
      pontos += 3
    }
    if (medidorFatura && normalizarUC(u.numeroMedidor) === medidorFatura) {
      pontos += 2
    }
    if (titularFatura && normalizarNome(u.titularNome) === titularFatura) {
      pontos += 2
    }
    if (
      enderecoFatura &&
      normalizarEndereco(
        `${u.endereco || ''} ${u.cidade || ''} ${u.estado || ''}`,
      ).includes(enderecoFatura)
    ) {
      pontos += 1
    }
    return pontos
  }

  return unidades
    .map((unidade) => ({ unidade, pontos: pontuar(unidade) }))
    .filter((x) => x.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos)
}

// Verifica compatibilidade entre a fatura e a UC encontrada.
// Se o CPF/CNPJ do PDF divergir do registrado na UC → incompatível (revisão).
const verificarCompatibilidade = (componentes, unidade) => {
  const cpfFatura = normalizarDoc(componentes.cpfCnpj)
  const cpfRegistrado = normalizarDoc(unidade?.titularCpfCnpj || unidade?.cpfCnpj)
  if (cpfFatura && cpfRegistrado && cpfFatura !== cpfRegistrado) {
    return { ok: false, detalhe: 'CPF_CNPJ_DIVERGENTE' }
  }
  return { ok: true, detalhe: null }
}

/**
 * Decide a que UC e cliente a fatura pertence.
 *
 * @param {Object} args
 * @param {Object} args.componentes - Dados extraídos (classificarFatura)
 * @param {Array}  args.unidades   - Lista de unidades consumidoras (numeroUC, codigoInstalacao, clienteId, titularNome, titularCpfCnpj, numeroMedidor, endereco...)
 * @param {Array}  args.clientes   - Lista de clientes (id, nome, cpfCnpj)
 * @returns {Object} Decisão estruturada
 */
export const identificarFatura = ({ componentes = {}, unidades = [], clientes = [] }) => {
  const uc = normalizarUC(componentes.uc)
  const temDadosSecundarios = Boolean(
    componentes.cliente ||
      componentes.cpfCnpj ||
      componentes.endereco ||
      componentes.numeroMedidor,
  )

  // Sem UC e sem nenhum dado secundário → PDF ilegível para identificação
  if (!uc && !temDadosSecundarios) {
    return {
      decisao: DECISAO.ERRO_EXTRACAO,
      motivo: MOTIVO_REVISAO.SEM_DADOS_IDENTIFICACAO,
      uc: '',
      unidade: null,
      cliente: null,
    }
  }

  // ===== Prioridade 1/2: UC presente =====
  if (uc) {
    const diretas = unidades.filter((u) => unidadePorUC(u, uc))

    // Mais de uma UC possível → nunca escolher aleatoriamente → revisão
    if (diretas.length > 1) {
      return {
        decisao: DECISAO.REVISAO_MANUAL,
        motivo: MOTIVO_REVISAO.MULTIPLAS_UCS,
        uc,
        unidade: null,
        cliente: null,
        candidatas: diretas.map((u) => ({ unidadeId: u.id, numeroUC: normalizarUC(u.numeroUC) })),
      }
    }

    // UC única encontrada
    if (diretas.length === 1) {
      const unidade = diretas[0]

      // Compatibilidade: se o CPF/CNPJ conflitar → revisão (não processar cego)
      const compat = verificarCompatibilidade(componentes, unidade)
      if (!compat.ok) {
        return {
          decisao: DECISAO.REVISAO_MANUAL,
          motivo: MOTIVO_REVISAO.CLIENTE_INCOMPATIVEL,
          detalhe: compat.detalhe,
          uc,
          unidade,
          cliente: null,
        }
      }

      const cliente =
        clientes.find((c) => String(c.id) === String(unidade.clienteId)) || null

      // UC existe mas não tem cliente vinculado → revisão (nunca criar cliente)
      if (!cliente) {
        return {
          decisao: DECISAO.REVISAO_MANUAL,
          motivo: MOTIVO_REVISAO.UC_SEM_CLIENTE,
          uc,
          unidade,
          cliente: null,
        }
      }

      return {
        decisao: DECISAO.PROCESSADO,
        motivo: 'UC_UNICA',
        uc,
        unidade,
        cliente,
      }
    }

    // UC presente mas não cadastrada → NUNCA criar cliente automaticamente → revisão.
    // Dados secundários apenas apontam candidatos para a análise humana.
    const candidatas = temDadosSecundarios
      ? buscarCandidatasSecundarias(componentes, unidades)
      : []
    return {
      decisao: DECISAO.REVISAO_MANUAL,
      motivo: MOTIVO_REVISAO.UC_NAO_ENCONTRADA,
      uc,
      unidade: null,
      cliente: null,
      candidatas: candidatas.map((c) => ({
        unidadeId: c.unidade.id,
        numeroUC: normalizarUC(c.unidade.numeroUC),
        pontos: c.pontos,
      })),
    }
  }

  // ===== Sem UC no PDF, mas há dados secundários =====
  // Nunca decidir por nome/endereço sozinho → revisão com candidatos
  const candidatas = buscarCandidatasSecundarias(componentes, unidades)
  return {
    decisao: DECISAO.REVISAO_MANUAL,
    motivo: MOTIVO_REVISAO.UC_AUSENTE_NO_PDF,
    uc: '',
    unidade: null,
    cliente: null,
    candidatas: candidatas.map((c) => ({
      unidadeId: c.unidade.id,
      numeroUC: normalizarUC(c.unidade.numeroUC),
      pontos: c.pontos,
    })),
  }
}

/**
 * Verifica a regra de isolamento entre clientes (usada também nos testes de segurança).
 * Um cliente só pode visualizar faturas/UCs cujo clienteId seja igual ao seu uid.
 */
export const podeAcessarRecurso = ({ uid, clienteId }) => {
  if (!uid || !clienteId) return false
  return String(uid) === String(clienteId)
}

