// ==================== Auto-cadastro de Clientes por Fatura ====================
// Pipeline: identificar UC → localizar cliente → vincular fatura
//           OU criar pré-cadastro (PENDING_REVIEW) para revisão do admin.
//
// Regras fundamentais:
//   - NUNCA criar dois clientes/unidades para a mesma UC (double-check na
//     persistência + ID determinístico no Firestore quando disponível)
//   - Dados manuais prevalecem sobre dados extraídos (nunca sobrescrever
//     automaticamente; divergências são registradas para revisão)
//   - Campos não identificados permanecem null (nunca inventar dados)
//   - Toda ação relevante gera log de auditoria

import { getStore, setStore, registrarLog } from '../store/db.js'
import { normalizarUC } from './faturaDedup.js'

// ==================== BUSCA POR UC ====================

/**
 * Localiza a unidade consumidora e o cliente correspondentes a uma UC.
 * Compara a UC normalizada contra numeroUC e codigoInstalacao das unidades.
 * @param {string|number} uc - UC extraída do PDF
 * @returns {{ unidade: Object|null, cliente: Object|null }}
 */
export const buscarClientePorUC = (uc) => {
  const ucNorm = normalizarUC(uc)
  if (!ucNorm) return { unidade: null, cliente: null }

  const unidades = getStore('unidades')
  const clientes = getStore('clientes')

  const unidade = unidades.find(
    (u) => normalizarUC(u.numeroUC) === ucNorm || normalizarUC(u.codigoInstalacao) === ucNorm,
  )
  if (!unidade) return { unidade: null, cliente: null }

  const cliente = clientes.find((c) => c.id === unidade.clienteId) || null
  return { unidade, cliente }
}

/**
 * Verifica se já existe pré-cadastro pendente para a mesma UC.
 * @param {string|number} uc
 * @returns {Object|null} Pré-cadastro existente ou null
 */
export const buscarPreCadastroPorUC = (uc) => {
  const ucNorm = normalizarUC(uc)
  if (!ucNorm) return null
  const preCadastros = getStore('preCadastros')
  return (
    preCadastros.find(
      (p) => p.status === 'PENDING_REVIEW' && normalizarUC(p.uc) === ucNorm,
    ) || null
  )
}

// ==================== PRÉ-CADASTRO ====================

/**
 * Cria um pré-cadastro pendente de revisão (PENDING_REVIEW).
 * Proteção anti-duplicidade: double-check imediatamente antes da escrita
 * (localStorage é síncrono → a checagem+escrita são atômicas na aba).
 *
 * @param {Object} dados - Dados extraídos do PDF
 * @param {Object} contexto - { arquivo, hashArquivo, usuario, faturaId }
 * @returns {{ ok: boolean, preCadastro?: Object, duplicado?: Object, message?: string }}
 */
export const criarPreCadastro = (dados, contexto = {}) => {
  const ucNorm = normalizarUC(dados.uc)

  // UC é obrigatória para pré-cadastro automático (regra: nunca criar cliente sem UC)
  if (!ucNorm) {
    return { ok: false, message: 'UC não identificada — pré-cadastro automático não permitido.' }
  }

  // Double-check 1: já existe cliente definitivo com essa UC?
  const { cliente } = buscarClientePorUC(ucNorm)
  if (cliente) {
    return { ok: false, duplicado: cliente, message: 'UC já pertence a um cliente cadastrado.' }
  }

  // Double-check 2: já existe pré-cadastro pendente com essa UC?
  const preExistente = buscarPreCadastroPorUC(ucNorm)
  if (preExistente) {
    return {
      ok: false,
      duplicado: preExistente,
      message: 'Já existe um pré-cadastro pendente para esta UC.',
    }
  }

  const preCadastros = getStore('preCadastros')
  const novo = {
    id: Date.now() + Math.random(),
    status: 'PENDING_REVIEW',
    source: 'PDF_IMPORT',
    uc: ucNorm,
    // Dados extraídos (null quando não identificado — nunca inventar)
    nome: dados.nome || null,
    cpfCnpj: dados.cpfCnpj || null,
    numeroInstalacao: dados.numeroInstalacao || null,
    numeroCliente: dados.numeroCliente || null,
    numeroMedidor: dados.numeroMedidor || null,
    endereco: dados.endereco || null,
    cidade: dados.cidade || null,
    estado: dados.estado || null,
    cep: dados.cep || null,
    // Metadados do upload
    arquivo: contexto.arquivo || null,
    hashArquivo: contexto.hashArquivo || null,
    faturaId: contexto.faturaId || null,
    usuario: contexto.usuario || 'Sistema',
    confiancas: dados.confiancas || {},
    errosExtracao: dados.errosExtracao || [],
    criadoEm: new Date().toLocaleString('pt-BR'),
    atualizadoEm: new Date().toLocaleString('pt-BR'),
  }

  setStore('preCadastros', [novo, ...preCadastros])
  registrarLog(
    'NOVO_CLIENTE_DETECTADO',
    `Pré-cadastro criado para UC ${ucNorm} (arquivo: ${contexto.arquivo || '—'})`,
    contexto.usuario || 'Sistema',
  )

  return { ok: true, preCadastro: novo }
}

/**
 * Confirma um pré-cadastro: cria o cliente definitivo + unidade consumidora
 * e vincula as faturas que estavam aguardando.
 * Revalida a UC no momento da confirmação (proteção contra concorrência).
 *
 * @param {Object|string|number} preCadastroOuId
 * @param {Object} dadosEditados - Dados revisados pelo admin (prevalecem)
 * @param {Object} contexto - { usuario }
 * @returns {{ ok: boolean, cliente?: Object, message?: string }}
 */
export const confirmarPreCadastro = (preCadastroOuId, dadosEditados = {}, contexto = {}) => {
  const preCadastros = getStore('preCadastros')
  const id = typeof preCadastroOuId === 'object' ? preCadastroOuId?.id : preCadastroOuId
  const pre = preCadastros.find((p) => p.id === id)

  if (!pre) {
    return { ok: false, message: 'Pré-cadastro não encontrado.' }
  }

  // Mescla: dados editados pelo admin prevalecem sobre os extraídos
  const dados = { ...pre, ...dadosEditados }
  const ucNorm = normalizarUC(dados.uc)

  if (!ucNorm) {
    return { ok: false, message: 'UC é obrigatória para confirmar o cadastro.' }
  }

  // Revalidação anti-duplicidade no momento da confirmação (concorrência)
  const { cliente: clienteExistente } = buscarClientePorUC(ucNorm)
  if (clienteExistente) {
    // Outro processo já cadastrou essa UC — vincula as faturas ao cliente existente
    vincularFaturasAoCliente(pre.id, clienteExistente.id, clienteExistente.nome)
    removerPreCadastroInterno(pre.id)
    registrarLog(
      'FATURA_VINCULADA',
      `UC ${ucNorm} já cadastrada — faturas vinculadas ao cliente ${clienteExistente.nome}`,
      contexto.usuario || 'Sistema',
    )
    return {
      ok: true,
      cliente: clienteExistente,
      message: 'UC já existia — faturas vinculadas ao cliente existente.',
    }
  }

  // Cria o cliente definitivo
  const clientes = getStore('clientes')
  const novoCliente = {
    id: Date.now() + Math.random(),
    nome: dados.nome || `Cliente UC ${ucNorm}`,
    cpfCnpj: dados.cpfCnpj || '',
    telefone: dados.telefone || '',
    email: dados.email || '',
    endereco: dados.endereco || '',
    cidade: dados.cidade || '',
    estado: dados.estado || '',
    cep: dados.cep || '',
    whatsapp: dados.whatsapp || '',
    // Sem credenciais de acesso até o admin definir (não consegue logar)
    emailAcesso: dados.emailAcesso || '',
    senhaAcesso: dados.senhaAcesso || '',
    ativo: true,
    dataCadastro: new Date().toLocaleDateString('pt-BR'),
    source: 'PDF_IMPORT',
    createdBy: contexto.usuario || 'Sistema',
  }
  setStore('clientes', [...clientes, novoCliente])

  // Cria a unidade consumidora
  const unidades = getStore('unidades')
  const novaUnidade = {
    id: Date.now() + Math.random(),
    clienteId: novoCliente.id,
    numeroUC: ucNorm,
    codigoInstalacao: dados.numeroInstalacao || '',
    numeroMedidor: dados.numeroMedidor || '',
    nomeConcessionaria: dados.nomeConcessionaria || '—',
    tipoFornecimento: dados.tipoFornecimento || '',
    classeConsumo: dados.classeConsumo || '',
    dataVinculacao: new Date().toLocaleDateString('pt-BR'),
    source: 'PDF_IMPORT',
  }
  setStore('unidades', [...unidades, novaUnidade])

  // Vincula as faturas que estavam aguardando esse pré-cadastro
  vincularFaturasAoCliente(pre.id, novoCliente.id, novoCliente.nome, novaUnidade.id)

  // Remove o pré-cadastro (foi confirmado)
  removerPreCadastroInterno(pre.id)

  registrarLog(
    'CLIENTE_CONFIRMADO',
    `Cliente ${novoCliente.nome} confirmado via PDF (UC ${ucNorm})`,
    contexto.usuario || 'Sistema',
  )

  return { ok: true, cliente: novoCliente, unidade: novaUnidade }
}

/**
 * Descarta um pré-cadastro e suas faturas órfãs.
 * @param {Object|string|number} preCadastroOuId
 * @param {Object} contexto - { usuario }
 */
export const descartarPreCadastro = (preCadastroOuId, contexto = {}) => {
  const preCadastros = getStore('preCadastros')
  const id = typeof preCadastroOuId === 'object' ? preCadastroOuId?.id : preCadastroOuId
  const pre = preCadastros.find((p) => p.id === id)

  if (!pre) return { ok: false, message: 'Pré-cadastro não encontrado.' }

  // Remove faturas órfãs vinculadas ao pré-cadastro
  const faturas = getStore('faturas')
  const faturasOrfas = faturas.filter((f) => f.clienteId === pre.id)
  if (faturasOrfas.length > 0) {
    setStore(
      'faturas',
      faturas.filter((f) => f.clienteId !== pre.id),
    )
  }

  removerPreCadastroInterno(pre.id)
  registrarLog(
    'PRE_CADASTRO_DESCARTADO',
    `Pré-cadastro UC ${pre.uc || '—'} descartado (${faturasOrfas.length} fatura(s) removida(s))`,
    contexto.usuario || 'Sistema',
  )

  return { ok: true }
}

// ==================== AUXILIARES ====================

/**
 * Vincula faturas de um pré-cadastro ao cliente definitivo.
 * Preserva dados já existentes; apenas atualiza clienteId/ucId/clienteNome.
 */
const vincularFaturasAoCliente = (preCadastroId, clienteId, clienteNome, ucId = null) => {
  const faturas = getStore('faturas')
  const atualizadas = faturas.map((f) =>
    f.clienteId === preCadastroId
      ? { ...f, clienteId, clienteNome, ucId: f.ucId || ucId, pendenteVinculacao: false }
      : f,
  )
  setStore('faturas', atualizadas)
}

/**
 * Remove um pré-cadastro da lista (uso interno).
 */
const removerPreCadastroInterno = (id) => {
  const preCadastros = getStore('preCadastros')
  setStore(
    'preCadastros',
    preCadastros.filter((p) => p.id !== id),
  )
}

/**
 * Atualiza um pré-cadastro existente (edição manual pelo admin).
 * @param {Object|string|number} preCadastroOuId
 * @param {Object} dados - Campos a atualizar
 * @param {Object} contexto - { usuario }
 */
export const atualizarPreCadastro = (preCadastroOuId, dados = {}, contexto = {}) => {
  const preCadastros = getStore('preCadastros')
  const id = typeof preCadastroOuId === 'object' ? preCadastroOuId?.id : preCadastroOuId
  const pre = preCadastros.find((p) => p.id === id)
  if (!pre) return { ok: false, message: 'Pré-cadastro não encontrado.' }

  const atualizado = {
    ...pre,
    ...dados,
    atualizadoEm: new Date().toLocaleString('pt-BR'),
    editadoManualmente: true,
  }
  setStore(
    'preCadastros',
    preCadastros.map((p) => (p.id === id ? atualizado : p)),
  )
  registrarLog(
    'DADO_EDITADO_MANUALMENTE',
    `Pré-cadastro UC ${pre.uc || '—'} editado manualmente`,
    contexto.usuario || 'Sistema',
  )
  return { ok: true, preCadastro: atualizado }
}