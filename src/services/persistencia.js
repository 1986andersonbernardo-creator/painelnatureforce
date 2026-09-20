// ==================== Persistência (local-first + Firestore) ====================
// Camada única de persistência do painel. Regras arquiteturais:
//
//   1. localStorage (store/db) é o CACHE local — sempre gravado de forma
//      SÍNCRONA. É ele que garante que a alteração administrativa sobreviva a
//      reload, logout/login e reabertura da aplicação.
//   2. Firestore é a FONTE DE VERDADE COMPARTILHADA — gravado em seguida
//      (assíncrono) quando existe sessão autenticada. É ele que faz o dado
//      chegar à Área do Cliente e a outros navegadores/dispositivos.
//   3. Nenhuma falha é silenciosa: quem chama recebe o estado da sincronização.
//
// Módulo PURO (não importa firebase) — é importável nos testes em Node.

import { hashDeterministico, normalizarUC } from './faturaDedup.js'

// Coleções que participam da sincronização local ↔ Firestore (banco central).
// `usuarios` e `logs` também sincronizam: a tela de Usuários e o histórico de
// auditoria precisam ser iguais em todos os dispositivos. A SENHA nunca vai
// para o banco (ver usuarioParaBanco) — credenciais vivem no Firebase Auth.
export const COLECOES_SINCRONIZADAS = Object.freeze([
  'clientes',
  'unidades',
  'faturas',
  'preCadastros',
  'usuarios',
  'logs',
])

// ==================== Identidade ====================

export const normalizarEmail = (valor) => String(valor ?? '').trim().toLowerCase()

export const normalizarDocumento = (valor) => String(valor ?? '').replace(/\D/g, '')

/**
 * Gera um ID único para novas entidades.
 * @param {string} prefixo
 * @returns {string}
 */
export const novoId = (prefixo = 'id') =>
  `${prefixo}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/**
 * Chave LÓGICA única de um registro dentro da coleção.
 * É o critério de reconciliação entre o cache local e o Firestore — por isso é
 * derivada dos dados de negócio (UC, e-mail, idempotência) e não do id gerado
 * localmente.
 * @param {string} colecao
 * @param {Object} item
 * @returns {string}
 */
export const chaveUnica = (colecao, item) => {
  if (!item) return ''

  switch (colecao) {
    case 'clientes': {
      const email = normalizarEmail(item.emailAcesso || item.email)
      if (email) return `email:${email}`
      const doc = normalizarDocumento(item.cpfCnpj)
      return doc ? `doc:${doc}` : `id:${item.id ?? ''}`
    }
    case 'unidades': {
      const uc = normalizarUC(item.numeroUC) || normalizarUC(item.codigoInstalacao)
      return uc ? `uc:${uc}` : `id:${item.id ?? ''}`
    }
    case 'faturas': {
      if (item.chaveIdempotencia) return `idem:${item.chaveIdempotencia}`
      if (item.hashArquivo) return `hash:${item.hashArquivo}`
      const uc = normalizarUC(item.uc)
      return `fat:${uc}|${item.referencia || '-'}|${item.arquivo || '-'}`
    }
    case 'preCadastros': {
      const uc = normalizarUC(item.uc)
      return uc ? `uc:${uc}` : `id:${item.id ?? ''}`
    }
    case 'usuarios': {
      const email = normalizarEmail(item.email)
      return email ? `email:${email}` : `id:${item.id ?? ''}`
    }
    case 'logs':
      return `id:${item.id ?? ''}`
    default:
      return `id:${item.id ?? ''}`
  }
}

/**
 * ID do DOCUMENTO no Firestore.
 * - clientes → o UID do Firebase quando existir (chave usada pela Área do
 *   Cliente e pelas regras de segurança); senão o id local.
 * - faturas → ID determinístico (idFatura / hash da chave de idempotência), o
 *   MESMO usado por `salvarFaturaIdempotente`. Sem isso a fatura gravava dois
 *   documentos no banco (um pelo pipeline idempotente, outro pelo espelho) e
 *   cada dispositivo exibia contagens diferentes.
 * - usuarios → o e-mail normalizado (identidade lógica do usuário).
 * - demais coleções → o id local (string estável).
 * @param {string} colecao
 * @param {Object} item
 * @returns {string}
 */
export const idDocumento = (colecao, item) => {
  if (!item) return ''
  if (colecao === 'clientes' && item.uid) return String(item.uid)
  if (colecao === 'faturas') {
    if (item.idFatura) return String(item.idFatura)
    if (item.chaveIdempotencia) return `fat_${hashDeterministico(item.chaveIdempotencia)}`
  }
  if (colecao === 'usuarios') {
    const email = normalizarEmail(item.email)
    if (email) return email
  }
  return String(item.id ?? '')
}

/**
 * Payload de um usuário para o banco central — NUNCA inclui a senha.
 * As credenciais vivem no Firebase Authentication; o campo `senha` existe
 * apenas para o login administrativo offline/bootstrap e não deve vazar para
 * o banco compartilhado.
 * @param {Object} usuario
 * @returns {Object} Registro sem `senha`
 */
export const usuarioParaBanco = (usuario) => {
  if (!usuario || typeof usuario !== 'object') return usuario
  const { senha, ...resto } = usuario
  return resto
}

/**
 * Converte as datas usadas no sistema ("dd/mm/yyyy hh:mm:ss", "dd/mm/yyyy" ou
 * ISO) em milissegundos. Sem data → 0.
 * @param {string|number} valor
 * @returns {number}
 */
export const paraTimestamp = (valor) => {
  if (!valor) return 0
  if (typeof valor === 'number') return valor

  const texto = String(valor).trim()

  if (/\d{4}-\d{2}-\d{2}/.test(texto)) {
    const iso = Date.parse(texto)
    if (!Number.isNaN(iso)) return iso
  }

  const m = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (m) {
    const [, dia, mes, ano, hh = '0', mi = '0', ss = '0'] = m
    return new Date(
      Number(ano),
      Number(mes) - 1,
      Number(dia),
      Number(hh),
      Number(mi),
      Number(ss),
    ).getTime()
  }

  return 0
}

/**
 * Momento da última alteração conhecida de um registro.
 * @param {Object} item
 * @returns {number}
 */
export const timestampRegistro = (item) => {
  if (!item) return 0
  return Math.max(
    paraTimestamp(item.atualizadoEm),
    paraTimestamp(item.resolvidoEm),
    paraTimestamp(item.criadoEm),
    paraTimestamp(item.dataUpload),
    paraTimestamp(item.dataCadastro),
    Number.isFinite(item.atualizadoEmMs) ? item.atualizadoEmMs : 0,
  )
}

// ==================== Reconciliação local ↔ remoto ====================

/**
 * Escolhe qual versão do mesmo registro lógico deve prevalecer.
 *
 * Prioridade:
 *   1. registro com `uid` (vínculo Firebase já resolvido);
 *   2. registro com timestamp de alteração mais recente;
 *   3. empate → o REMOTO (fonte de verdade compartilhada).
 *
 * @param {{item:Object, origem:string}} candidatoA
 * @param {{item:Object, origem:string}} candidatoB
 * @returns {{item:Object, origem:string}}
 */
export const escolherVersao = (candidatoA, candidatoB) => {
  const { item: a, origem: origemA } = candidatoA
  const { item: b } = candidatoB

  const aTemUid = Boolean(a?.uid)
  const bTemUid = Boolean(b?.uid)
  if (aTemUid !== bTemUid) return aTemUid ? candidatoA : candidatoB

  const ta = timestampRegistro(a)
  const tb = timestampRegistro(b)
  if (ta !== tb) return ta > tb ? candidatoA : candidatoB

  return origemA === 'remoto' ? candidatoA : candidatoB
}

/**
 * Mescla o cache local com os documentos remotos, sem duplicar e sem perder
 * alterações locais ainda não sincronizadas.
 * @param {{colecao:string, local?:Array, remoto?:Array}} params
 * @returns {Array}
 */
export const mesclarColecao = ({ colecao, local = [], remoto = [] }) => {
  const mapa = new Map()

  const inserir = (item, origem) => {
    const chave = chaveUnica(colecao, item)
    if (!chave) return

    const existente = mapa.get(chave)
    if (!existente) {
      mapa.set(chave, { item, origem })
      return
    }

    const vencedor = escolherVersao(existente, { item, origem })
    const perdedor = vencedor === existente ? { item, origem } : existente
    // Campos que existem só no perdedor são preservados (nada é descartado).
    mapa.set(chave, {
      item: { ...perdedor.item, ...vencedor.item },
      origem: vencedor.origem,
    })
  }

  local.forEach((item) => inserir(item, 'local'))
  remoto.forEach((item) => inserir(item, 'remoto'))

  return Array.from(mapa.values()).map((entrada) => entrada.item)
}

// ==================== Reconciliação com o BANCO CENTRAL ====================

/**
 * Chaves lógicas de uma coleção (conteúdo do índice de sincronização).
 * @param {string} colecao
 * @param {Array} itens
 * @returns {string[]}
 */
export const chavesDaColecao = (colecao, itens = []) =>
  itens.map((item) => chaveUnica(colecao, item)).filter(Boolean)

/**
 * Reconcilia o cache local com o BANCO CENTRAL (Firestore).
 *
 * Regras (o Firestore é a fonte única da verdade):
 *   1. registro nos dois lados → o REMOTO vence. Toda escrita local é espelhada
 *      no banco na hora; falha de espelhamento é reportada na UI. Campos
 *      opcionais em `preservarCampos` presentes só no cache são mantidos
 *      (ex.: `senha` do bootstrap, que não vai para o banco);
 *   2. registro que JÁ foi visto no banco central (chavesConhecidas) e não
 *      existe mais no remoto → foi EXCLUÍDO em outro dispositivo → removido;
 *   3. registro que nunca foi visto remotamente → pendência local legítima
 *      (escrita ainda não sincronizada) → permanece.
 *
 * @param {{colecao:string, local?:Array, remoto?:Array,
 *          chavesConhecidas?:Array<string>, preservarCampos?:string[]}} params
 * @returns {{itens:Array, chavesRemotas:string[], removidos:string[]}}
 */
export const reconciliarComRemoto = ({
  colecao,
  local = [],
  remoto = [],
  chavesConhecidas = [],
  preservarCampos = [],
}) => {
  const mapa = new Map()

  remoto.forEach((item) => {
    const chave = chaveUnica(colecao, item)
    if (chave) mapa.set(chave, { item, origem: 'remoto' })
  })

  local.forEach((item) => {
    const chave = chaveUnica(colecao, item)
    if (!chave || mapa.has(chave)) return
    mapa.set(chave, { item, origem: 'local' })
  })

  // Campos que existem só no cache local são preservados (nada é descartado).
  if (preservarCampos.length > 0) {
    const locaisPorChave = new Map(local.map((item) => [chaveUnica(colecao, item), item]))
    locaisPorChave.forEach((itemLocal, chave) => {
      const entrada = mapa.get(chave)
      if (!entrada || entrada.origem !== 'remoto') return
      const extras = {}
      preservarCampos.forEach((campo) => {
        if (itemLocal?.[campo] !== undefined && entrada.item[campo] === undefined) {
          extras[campo] = itemLocal[campo]
        }
      })
      if (Object.keys(extras).length > 0) {
        mapa.set(chave, { item: { ...entrada.item, ...extras }, origem: 'remoto' })
      }
    })
  }

  const conhecidas = new Set(chavesConhecidas.map(String))
  const chavesRemotas = []
  const removidos = []
  const itens = []

  mapa.forEach((entrada, chave) => {
    if (entrada.origem === 'remoto') {
      chavesRemotas.push(chave)
      itens.push(entrada.item)
      return
    }
    if (conhecidas.has(chave)) {
      removidos.push(chave)
      return
    }
    itens.push(entrada.item)
  })

  return { itens, chavesRemotas, removidos }
}

/**
 * Atualiza o índice de chaves conhecidas do banco central.
 * @param {{[colecao:string]: string[]}} indice
 * @param {string} colecao
 * @param {string[]} chavesRemotas
 * @returns {{indice:Object, removidas:string[]}} Chaves que saíram do banco
 */
export const atualizarIndiceRemoto = (indice = {}, colecao, chavesRemotas = []) => {
  const anteriores = new Set((indice?.[colecao] || []).map(String))
  const atuais = new Set(chavesRemotas.map(String))
  const removidas = []
  anteriores.forEach((chave) => {
    if (!atuais.has(chave)) removidas.push(chave)
  })
  return { indice: { ...indice, [colecao]: [...atuais] }, removidas }
}

// ==================== Vínculo cliente ↔ UID (Firebase) ====================

/**
 * IDs que identificam um cliente (local + Firebase).
 * @param {Object} cliente
 * @returns {string[]}
 */
export const idsDoCliente = (cliente) =>
  [cliente?.id, cliente?.uid].filter(Boolean).map(String)

/**
 * Este registro (unidade/fatura) pertence ao cliente informado?
 * Considera o id local, o UID e o vínculo anterior (clienteIdLocal).
 * @param {{registro:Object, cliente:Object}} params
 * @returns {boolean}
 */
export const registroPertenceAoCliente = ({ registro, cliente }) => {
  if (!registro || !cliente) return false
  const ids = idsDoCliente(cliente)
  return (
    ids.includes(String(registro.clienteId ?? '')) ||
    ids.includes(String(registro.clienteIdLocal ?? ''))
  )
}

/**
 * Propaga o vínculo de um cliente com o UID do Firebase para TODOS os seus
 * registros (unidades/faturas), trocando `clienteId` local pelo UID.
 * Sem isso, a Área do Cliente (que filtra por UID) nunca encontra os dados.
 *
 * @param {{clientes?:Array, unidades?:Array, faturas?:Array, cliente:Object,
 *          uid:string, clienteIdAnterior?:string}} params
 * @returns {{clientes:Array, unidades:Array, faturas:Array, cliente:Object, propagados:number}}
 */
export const propagarVinculoCliente = ({
  clientes = [],
  unidades = [],
  faturas = [],
  cliente,
  uid,
  clienteIdAnterior,
}) => {
  const uidFinal = String(uid || '')
  if (!cliente || !uidFinal) {
    return { clientes, unidades, faturas, cliente, propagados: 0 }
  }

  const idsAntigos = new Set(
    [cliente.id, cliente.uid, clienteIdAnterior].filter(Boolean).map(String),
  )

  const agora = new Date()
  const clienteAtualizado = {
    ...cliente,
    uid: uidFinal,
    uidVinculadoEm: agora.toLocaleString('pt-BR'),
    atualizadoEm: agora.toLocaleString('pt-BR'),
    atualizadoEmMs: agora.getTime(),
  }

  let propagados = 0

  const unidadesAtualizadas = unidades.map((u) => {
    if (!idsAntigos.has(String(u.clienteId ?? ''))) return u
    if (String(u.clienteId) === uidFinal) return u
    propagados += 1
    return { ...u, clienteIdLocal: u.clienteIdLocal ?? u.clienteId, clienteId: uidFinal }
  })

  const faturasAtualizadas = faturas.map((f) => {
    if (!idsAntigos.has(String(f.clienteId ?? ''))) return f
    if (String(f.clienteId) === uidFinal) return f
    propagados += 1
    return {
      ...f,
      clienteIdLocal: f.clienteIdLocal ?? f.clienteId,
      clienteId: uidFinal,
      pendenteVinculacao: false,
    }
  })

  const clientesAtualizados = clientes.map((c) =>
    String(c.id) === String(cliente.id) ? { ...c, ...clienteAtualizado } : c,
  )

  return {
    clientes: clientesAtualizados,
    unidades: unidadesAtualizadas,
    faturas: faturasAtualizadas,
    cliente: clienteAtualizado,
    propagados,
  }
}

// ==================== Associação manual UC → Cliente ====================

/**
 * Associa uma UC (fatura pendente de associação) a um cliente existente.
 *
 * Regra de negócio: a UC é o identificador principal. A associação grava
 * UC → cliente, vincula as faturas daquela UC e remove o pré-cadastro pendente
 * correspondente. NUNCA cria um cliente novo.
 *
 * @param {{unidades?:Array, faturas?:Array, preCadastros?:Array, uc:string|number,
 *          cliente:Object, usuario?:string}} params
 * @returns {{unidades:Array, faturas:Array, preCadastros:Array, unidade:Object|null,
 *            faturasVinculadas:number, ok:boolean, message?:string}}
 */
export const associarUCaCliente = ({
  unidades = [],
  faturas = [],
  preCadastros = [],
  uc,
  cliente,
  usuario = 'Sistema',
}) => {
  const ucNorm = normalizarUC(uc)
  const base = { unidades, faturas, preCadastros, unidade: null, faturasVinculadas: 0 }

  if (!ucNorm) {
    return { ...base, ok: false, message: 'UC não informada — não é possível associar.' }
  }
  if (!cliente) {
    return { ...base, ok: false, message: 'Selecione o cliente que receberá esta UC.' }
  }

  const clienteId = String(cliente.uid || cliente.id)
  const pre = preCadastros.find((p) => normalizarUC(p.uc) === ucNorm) || null
  const existente = unidades.find((u) => normalizarUC(u.numeroUC) === ucNorm) || null
  const agora = new Date()

  let unidade
  let unidadesAtualizadas

  if (existente) {
    unidade = {
      ...existente,
      clienteId,
      clienteIdLocal: existente.clienteIdLocal ?? existente.clienteId,
      titularNome: existente.titularNome || pre?.nome || '',
      atualizadoEm: agora.toLocaleString('pt-BR'),
      atualizadoEmMs: agora.getTime(),
    }
    unidadesAtualizadas = unidades.map((u) => (u.id === existente.id ? unidade : u))
  } else {
    unidade = {
      id: novoId('uc'),
      clienteId,
      numeroUC: ucNorm,
      codigoInstalacao: pre?.numeroInstalacao || '',
      distribuidora: pre?.distribuidora || '',
      titularNome: pre?.nome || '',
      titularCpfCnpj: pre?.cpfCnpj || '',
      numeroMedidor: pre?.numeroMedidor || '',
      endereco: pre?.endereco || '',
      cidade: pre?.cidade || '',
      estado: pre?.estado || '',
      cep: pre?.cep || '',
      status: 'ativo',
      origem: 'ASSOCIACAO_MANUAL',
      associadaPor: usuario,
      dataVinculacao: agora.toLocaleDateString('pt-BR'),
      atualizadoEm: agora.toLocaleString('pt-BR'),
      atualizadoEmMs: agora.getTime(),
    }
    unidadesAtualizadas = [...unidades, unidade]
  }

  let faturasVinculadas = 0
  const faturasAtualizadas = faturas.map((f) => {
    if (normalizarUC(f.uc) !== ucNorm) return f
    if (String(f.clienteId) === clienteId) return f

    // Vincula faturas sem cliente, de pré-cadastro, ou já deste mesmo cliente
    const semCliente =
      !f.clienteId || f.pendenteVinculacao || (pre && String(f.clienteId) === String(pre.id))
    const doCliente = String(f.clienteId) === String(cliente.id)
    if (!semCliente && !doCliente) return f

    faturasVinculadas += 1
    return {
      ...f,
      clienteId,
      clienteIdLocal: f.clienteIdLocal ?? cliente.id,
      clienteNome: cliente.nome || f.clienteNome || null,
      ucId: f.ucId || unidade.id,
      // Passa a ficar disponível na Área do Cliente
      status: f.status === 'erro' ? f.status : 'disponivel',
      pendenteVinculacao: false,
      associadaManualmente: true,
      atualizadoEm: agora.toLocaleString('pt-BR'),
      atualizadoEmMs: agora.getTime(),
    }
  })

  // Remove o pré-cadastro pendente (a UC agora tem cliente definitivo)
  const preCadastrosAtualizados = pre ? preCadastros.filter((p) => p.id !== pre.id) : preCadastros

  return {
    unidades: unidadesAtualizadas,
    faturas: faturasAtualizadas,
    preCadastros: preCadastrosAtualizados,
    unidade,
    faturasVinculadas,
    ok: true,
  }
}

// ==================== Isolamento da Área do Cliente ====================

/**
 * Faturas visíveis para um cliente — SOMENTE as dele.
 * O cliente é identificado pelo UID (Firebase), pelo id local (vínculo
 * anterior) e pelas UCs que possui. Nunca por nome ou heurística.
 *
 * @param {{faturas?:Array, clienteId?:string, uids?:Array<string>, ucs?:Array<string>}} params
 * @returns {Array}
 */
export const filtrarFaturasDoCliente = ({ faturas = [], clienteId, uids = [], ucs = [] }) => {
  const ids = new Set([clienteId, ...uids].filter(Boolean).map(String))
  const ucsNorm = new Set(ucs.map(normalizarUC).filter(Boolean))

  return faturas.filter((f) => {
    if (!f) return false
    if (ids.has(String(f.clienteId ?? ''))) return true
    if (ids.has(String(f.clienteIdLocal ?? ''))) return true
    const uc = normalizarUC(f.uc)
    return Boolean(uc) && ucsNorm.has(uc)
  })
}

/**
 * Ordena faturas por competência (mais recente primeiro).
 * @param {Array} faturas
 * @returns {Array}
 */
export const ordenarPorCompetencia = (faturas = []) =>
  [...faturas].sort((a, b) => {
    const ra = String(a?.referencia ?? '')
    const rb = String(b?.referencia ?? '')
    if (ra === rb) return 0
    return ra < rb ? 1 : -1
  })

// ==================== Resumo do processamento (dashboard) ====================

/**
 * Contadores do dashboard de processamento de faturas.
 * @param {Array} faturas
 * @returns {{total:number, processadas:number, pendentes:number, comErro:number,
 *            duplicadas:number, disponiveis:number}}
 */
export const resumoProcessamento = (faturas = []) => {
  const porStatus = (valores) =>
    faturas.filter((f) => valores.includes(f?.statusProcessamento || f?.status || '')).length

  return {
    total: faturas.length,
    processadas: porStatus(['PROCESSADO']),
    pendentes: porStatus(['PENDENTE', 'PROCESSANDO', 'REVISAO_MANUAL', 'aguardando revisão']),
    comErro: porStatus(['ERRO_EXTRACAO', 'ERRO', 'erro']),
    duplicadas: porStatus(['DUPLICADA', 'duplicada']),
    disponiveis: faturas.filter((f) => f?.status === 'disponivel').length,
  }
}
