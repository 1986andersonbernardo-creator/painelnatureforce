// ==================== IndexedDB (arquivos PDF) ====================

const openDB = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open('natureforce-arquivos', 2)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('arquivos')) {
        db.createObjectStore('arquivos', { keyPath: 'id' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

export const salvarArquivo = async (id, data) => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('arquivos', 'readwrite')
    tx.objectStore('arquivos').put({ id, data })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export const removerArquivo = async (id) => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('arquivos', 'readwrite')
    tx.objectStore('arquivos').delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export const obterArquivo = (id) =>
  openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction('arquivos', 'readonly')
        const request = tx.objectStore('arquivos').get(id)
        request.onsuccess = () => resolve(request.result?.data)
        request.onerror = () => reject(request.error)
      }),
  )

// ==================== localStorage (dados estruturados) ====================

// Chaves do cache local. Exportadas para que a camada de persistência
// (services/persistencia.js) possa reconciliar o cache local com o Firestore.
//
// IMPORTANTE: nenhuma destas chaves é a FONTE DA VERDADE. Elas são o espelho
// local (cache de leitura + pendências de escrita) das coleções do Firestore,
// que é o banco central compartilhado entre todos os dispositivos.
export const KEYS = {
  clientes: 'natureforce-clientes',
  unidades: 'natureforce-unidades',
  faturas: 'natureforce-faturas',
  usuarios: 'natureforce-usuarios',
  logs: 'natureforce-logs',
  session: 'natureforce-sessao',
  preCadastros: 'natureforce-pre-cadastros',
}

// Metadados de sincronização (NÃO são dados de negócio): guardam quais chaves
// lógicas já foram vistas no banco central. É o que permite detectar uma
// exclusão feita em outro dispositivo e removê-la também deste cache.
export const CHAVE_INDICE_SYNC = 'natureforce-indice-sync'

export const getStore = (key) => {
  try {
    const stored = localStorage.getItem(KEYS[key])
    return stored ? JSON.parse(stored) : []
  } catch {
    return []
  }
}

export const setStore = (key, value) => {
  localStorage.setItem(KEYS[key], JSON.stringify(value))
}

export const removerStore = (key) => {
  localStorage.removeItem(KEYS[key])
}

export const getSession = () => {
  try {
    const stored = localStorage.getItem(KEYS.session)
    return stored ? JSON.parse(stored) : null
  } catch {
    return null
  }
}

export const setSession = (session) => {
  localStorage.setItem(KEYS.session, JSON.stringify(session))
}

export const clearSession = () => {
  localStorage.removeItem(KEYS.session)
}

// ==================== Logs de auditoria ====================

/**
 * Monta o registro de log (sem gravar).
 * @param {string} acao
 * @param {string} detalhe
 * @param {string} usuario
 * @returns {Object}
 */
export const montarLog = (acao, detalhe = '', usuario = '') => ({
  id: Date.now() + Math.random(),
  acao,
  detalhe,
  usuario,
  data: new Date().toLocaleString('pt-BR'),
})

/**
 * Grava um registro de log pronto no cache local (máx. 500).
 * @param {Object} novo
 * @returns {Object} O próprio registro (para espelhamento no banco central)
 */
export const salvarLog = (novo) => {
  const logs = getStore('logs')
  setStore('logs', [novo, ...logs].slice(0, 500))
  return novo
}

/**
 * Cria e grava um log de auditoria. Retorna o registro criado para que o
 * chamador (AuthContext.logar) possa espelhá-lo no Firestore — assim o
 * histórico também é compartilhado entre os dispositivos.
 * @param {string} acao
 * @param {string} detalhe
 * @param {string} usuario
 * @returns {Object} Registro criado
 */
export const registrarLog = (acao, detalhe = '', usuario = '') =>
  salvarLog(montarLog(acao, detalhe, usuario))

// ==================== Índice de sincronização ====================
// Metadados locais (NÃO são dados de negócio): para cada coleção guarda as
// chaves lógicas já vistas no banco central. Permite:
//   1. detectar que um registro foi EXCLUÍDO em outro dispositivo e remover
//      também deste cache (o Firestore é a fonte da verdade);
//   2. diferenciar "pendente de sincronização" de "registro órfão".

/**
 * @returns {Object<string, string[]>} Índice no formato { colecao: [chaves] }
 */
export const getIndiceSync = () => {
  try {
    const stored = localStorage.getItem(CHAVE_INDICE_SYNC)
    return stored ? JSON.parse(stored) : {}
  } catch {
    return {}
  }
}

/**
 * Persiste o índice de sincronização.
 * @param {Object<string, string[]>} indice
 */
export const setIndiceSync = (indice) => {
  try {
    localStorage.setItem(CHAVE_INDICE_SYNC, JSON.stringify(indice || {}))
  } catch {
    // Sem espaço/disponibilidade: a sincronização continua funcionando,
    // apenas sem a detecção de exclusões entre dispositivos.
  }
}

// ==================== Migração do cache local ====================
// Prepara o cache local na inicialização. NÃO cria dados de negócio fictícios:
// se o banco central estiver vazio, as telas exibem estado vazio — que é o
// comportamento correto de um sistema real centralizado no Firestore.

/**
 * Bootstrap do acesso administrativo.
 *
 * ATENÇÃO: isto NÃO é dado de demonstração — é a conta de acesso do sistema.
 * A FONTE DE VERDADE da autenticação é o Firebase Authentication: a conta
 * abaixo PRECISA estar provisionada lá (mesmo e-mail e senha). Este registro
 * existe para permitir o primeiro acesso/offline e a tela de Usuários.
 *
 * Configurável por ambiente:
 *   VITE_ADMIN_EMAIL="admin@natureforce.com"
 *   VITE_ADMIN_PASSWORD="..."
 */
const BOOTSTRAP_ADMIN = {
  nome: 'Administrador',
  email: String(
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ADMIN_EMAIL) ||
      'admin@natureforce.com',
  )
    .trim()
    .toLowerCase(),
  senha:
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ADMIN_PASSWORD) || 'admin123',
  perfil: 'administrador',
  origem: 'BOOTSTRAP',
}

// Assinaturas dos registros de DEMONSTRAÇÃO que versões anteriores deste
// sistema semeavam no localStorage de cada navegador. São removidos na
// migração: nunca deveriam existir como dados do sistema (a causa do celular
// mostrar informações diferentes do computador).
const ASSINATURAS_DEMO = {
  emailClientes: ['marina@natureforce.com', 'joao@natureforce.com', 'maria@natureforce.com'],
  nomeClientes: ['Marina Almeida', 'João Pereira', 'Maria Santos'],
  arquivosFaturas: [
    'fatura-marina-08-2026.pdf',
    'fatura-marina-07-2026.pdf',
    'fatura-joao-08-2026.pdf',
  ],
  idsUnidades: ['1', '2'],
  ucsUnidades: ['1234567890', '0987654321'],
  emailUsuarios: ['operador@natureforce.com'],
}

/**
 * Migra o cache local:
 *   1. remove registros de demonstração (mocks) legados;
 *   2. normaliza campos antigos de cliente;
 *   3. garante o usuário administrativo de bootstrap.
 *
 * Registros legítimos (sincronizados com o Firestore) NUNCA são removidos:
 * o filtro usa assinaturas exatas dos mocks e ignora qualquer registro que já
 * tenha vínculo com o banco central (uid / idFatura / firestoreId).
 */
export const migrarCacheLocal = () => {
  // 1. Clientes — remove mocks e normaliza campos antigos
  const clientes = getStore('clientes')
  const clientesLimpos = clientes
    .filter((c) => {
      const email = String(c.emailAcesso || c.email || '').trim().toLowerCase()
      const temVinculoCentral = Boolean(c.uid || c.firestoreId)
      if (temVinculoCentral) return true
      return !ASSINATURAS_DEMO.emailClientes.includes(email)
    })
    .map((c) => ({
      ...c,
      emailAcesso: c.emailAcesso || c.email || '',
      ativo: c.ativo !== undefined ? c.ativo : true,
    }))
  if (clientesLimpos.length !== clientes.length || clientes.some((c) => !c.emailAcesso)) {
    setStore('clientes', clientesLimpos)
  }

  // 2. Unidades — remove as UCs de demonstração (id semeado + UC conhecida)
  const unidades = getStore('unidades')
  const unidadesLimpas = unidades.filter(
    (u) =>
      !(
        ASSINATURAS_DEMO.idsUnidades.includes(String(u.id)) &&
        ASSINATURAS_DEMO.ucsUnidades.includes(String(u.numeroUC)) &&
        !u.firestoreId
      ),
  )
  if (unidadesLimpas.length !== unidades.length) setStore('unidades', unidadesLimpas)

  // 3. Faturas — remove as faturas de demonstração. Uma fatura real do
  //    pipeline SEMPRE tem chave de idempotência/ID determinístico ou vínculo
  //    com o banco central; os mocks não têm nenhum desses campos.
  const faturas = getStore('faturas')
  const faturasLimpa = faturas.filter((f) => {
    const temVinculoCentral = Boolean(f.firestoreId || f.idFatura || f.chaveIdempotencia)
    if (temVinculoCentral) return true
    if (ASSINATURAS_DEMO.arquivosFaturas.includes(String(f.arquivo))) return false
    const nome = String(f.clienteNome || '').trim()
    return !ASSINATURAS_DEMO.nomeClientes.includes(nome)
  })
  if (faturasLimpa.length !== faturas.length) setStore('faturas', faturasLimpa)

  // 4. Usuários — remove usuários de demonstração e garante o bootstrap
  const usuarios = getStore('usuarios')
  const usuariosLimpos = usuarios.filter(
    (u) => !ASSINATURAS_DEMO.emailUsuarios.includes(String(u.email).trim().toLowerCase()),
  )
  const jaTemBootstrap = usuariosLimpos.some(
    (u) => String(u.email).trim().toLowerCase() === BOOTSTRAP_ADMIN.email,
  )
  if (!jaTemBootstrap) {
    usuariosLimpos.push({
      ...BOOTSTRAP_ADMIN,
      criadoEm: new Date().toLocaleDateString('pt-BR'),
    })
  }
  if (usuariosLimpos.length !== usuarios.length || !jaTemBootstrap) {
    setStore('usuarios', usuariosLimpos)
  }

  // 5. Logs — remove o registro de "dados de demonstração"
  const logs = getStore('logs')
  const logsLimpos = logs.filter(
    (l) => !(l.acao === 'Sistema inicializado' && l.detalhe === 'Dados de demonstração criados'),
  )
  if (logsLimpos.length !== logs.length) setStore('logs', logsLimpos)
}