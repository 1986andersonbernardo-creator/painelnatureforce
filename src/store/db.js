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

const KEYS = {
  clientes: 'natureforce-clientes',
  unidades: 'natureforce-unidades',
  faturas: 'natureforce-faturas',
  usuarios: 'natureforce-usuarios',
  logs: 'natureforce-logs',
  session: 'natureforce-sessao',
  preCadastros: 'natureforce-pre-cadastros',
}

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

export const registrarLog = (acao, detalhe = '', usuario = '') => {
  const logs = getStore('logs')
  const novo = {
    id: Date.now() + Math.random(),
    acao,
    detalhe,
    usuario,
    data: new Date().toLocaleString('pt-BR'),
  }
  setStore('logs', [novo, ...logs].slice(0, 500))
}

// ==================== Dados iniciais ====================

export const seedData = () => {
  // Migra clientes antigos (sem emailAcesso/senhaAcesso) para o novo formato
  const clientesExistentes = getStore('clientes')
  if (clientesExistentes.length > 0) {
    const migrados = clientesExistentes.map((c) => ({
      ...c,
      emailAcesso: c.emailAcesso || c.email || '',
      senhaAcesso: c.senhaAcesso || '123456',
      ativo: c.ativo !== undefined ? c.ativo : true,
    }))
    setStore('clientes', migrados)
  }

  // Clientes de demonstração
  if (getStore('clientes').length === 0) {
    setStore('clientes', [
      {
        id: 1,
        nome: 'Marina Almeida',
        cpfCnpj: '456.123.789-09',
        telefone: '(81) 9 8765-4321',
        email: 'marina@natureforce.com',
        endereco: 'Rua das Palmeiras, 284, Recife/PE',
        cidade: 'Recife',
        estado: 'PE',
        cep: '50000-000',
        whatsapp: '81 9 8765-4321',
        emailAcesso: 'marina@natureforce.com',
        senhaAcesso: '123456',
        ativo: true,
        dataCadastro: '10/01/2026',
      },
      {
        id: 2,
        nome: 'João Pereira',
        cpfCnpj: '123.456.789-00',
        telefone: '(81) 9 9999-8888',
        email: 'joao@natureforce.com',
        endereco: 'Av. Boa Viagem, 1200, Recife/PE',
        cidade: 'Recife',
        estado: 'PE',
        cep: '51020-000',
        whatsapp: '81 9 9999-8888',
        emailAcesso: 'joao@natureforce.com',
        senhaAcesso: '123456',
        ativo: true,
        dataCadastro: '15/02/2026',
      },
      {
        id: 3,
        nome: 'Maria Santos',
        cpfCnpj: '987.654.321-00',
        telefone: '(81) 9 8888-7777',
        email: 'maria@natureforce.com',
        endereco: 'Rua do Sol, 500, Olinda/PE',
        cidade: 'Olinda',
        estado: 'PE',
        cep: '53000-000',
        whatsapp: '81 9 8888-7777',
        emailAcesso: 'maria@natureforce.com',
        senhaAcesso: '123456',
        ativo: false,
        dataCadastro: '02/03/2026',
      },
    ])
  }

  // Usuários administrativos de demonstração
  if (getStore('usuarios').length === 0) {
    setStore('usuarios', [
      {
        id: 1,
        nome: 'Anderson Lima',
        email: 'admin@natureforce.com',
        senha: 'admin123',
        perfil: 'administrador',
        criadoEm: '01/01/2026',
      },
      {
        id: 2,
        nome: 'Operador Maria',
        email: 'operador@natureforce.com',
        senha: 'operador123',
        perfil: 'operador',
        criadoEm: '01/01/2026',
      },
    ])
  }

  // Unidades consumidoras de demonstração
  if (getStore('unidades').length === 0) {
    setStore('unidades', [
      {
        id: 1,
        clienteId: 1,
        numeroUC: '1234567890',
        codigoInstalacao: 'IN-04218',
        nomeConcessionaria: 'Neoenergia',
        tipoFornecimento: 'Residencial',
        classeConsumo: 'Residencial',
        dataVinculacao: '10/01/2026',
      },
      {
        id: 2,
        clienteId: 2,
        numeroUC: '0987654321',
        codigoInstalacao: 'IN-03907',
        nomeConcessionaria: 'Neoenergia',
        tipoFornecimento: 'Comercial',
        classeConsumo: 'Comercial',
        dataVinculacao: '15/02/2026',
      },
    ])
  }

  // Faturas de demonstração
  if (getStore('faturas').length === 0) {
    setStore('faturas', [
      {
        id: 1,
        clienteId: 1,
        ucId: 1,
        arquivo: 'fatura-marina-08-2026.pdf',
        clienteNome: 'Marina Almeida',
        uc: '1234567890',
        referencia: '2026-08',
        dataUpload: '17/08/2026',
        status: 'disponivel',
        valorTotal: 400,
        consumo: 432,
        vencimento: '18/09/2026',
        componentes: {
          uc: '1234567890',
          cliente: 'Marina Almeida',
          referencia: '2026-08',
          vencimento: '18/09/2026',
          consumo: 432,
          energia: 300,
          tusd: 80,
          te: 120,
          icms: 60,
          pis: 15,
          cofins: 25,
          encargos: 0,
          iluminacao: 0,
          creditos: 0,
          descontos: 0,
          outros: 0,
        },
        calculo: {
          ok: true,
          valorElegivel: 500,
          percentualDesconto: 0.2,
          valorDesconto: 100,
          impostos: 100,
          encargos: 0,
          outros: 0,
          impostosTributosEncargos: 100,
          valorFinal: 400,
          formulaUtilizada:
            'Valor final = (Energia + TUSD + TE) − 20% + (ICMS + PIS + COFINS + Encargos + Outros)',
          requerRevisao: false,
        },
        validacao: { valido: true, erros: [] },
      },
      {
        id: 2,
        clienteId: 1,
        ucId: 1,
        arquivo: 'fatura-marina-07-2026.pdf',
        clienteNome: 'Marina Almeida',
        uc: '1234567890',
        referencia: '2026-07',
        dataUpload: '15/07/2026',
        status: 'disponivel',
        valorTotal: 385,
        consumo: 418,
        vencimento: '18/08/2026',
        componentes: {
          uc: '1234567890',
          cliente: 'Marina Almeida',
          referencia: '2026-07',
          vencimento: '18/08/2026',
          consumo: 418,
          energia: 290,
          tusd: 76,
          te: 114,
          icms: 58,
          pis: 14,
          cofins: 24,
          encargos: 0,
          iluminacao: 0,
          creditos: 0,
          descontos: 0,
          outros: 0,
        },
        calculo: {
          ok: true,
          valorElegivel: 480,
          percentualDesconto: 0.2,
          valorDesconto: 96,
          impostos: 96,
          encargos: 0,
          outros: 0,
          impostosTributosEncargos: 96,
          valorFinal: 385,
          formulaUtilizada:
            'Valor final = (Energia + TUSD + TE) − 20% + (ICMS + PIS + COFINS + Encargos + Outros)',
          requerRevisao: false,
        },
        validacao: { valido: true, erros: [] },
      },
      {
        id: 3,
        clienteId: 2,
        ucId: 2,
        arquivo: 'fatura-joao-08-2026.pdf',
        clienteNome: 'João Pereira',
        uc: '0987654321',
        referencia: '2026-08',
        dataUpload: '17/08/2026',
        status: 'requer revisão',
        valorTotal: 1250.0,
        consumo: 980,
        vencimento: '20/09/2026',
        componentes: {
          uc: '0987654321',
          cliente: 'João Pereira',
          referencia: '2026-08',
          vencimento: '20/09/2026',
          consumo: 980,
          energia: null,
          tusd: null,
          te: null,
          icms: null,
          pis: null,
          cofins: null,
          encargos: 0,
          iluminacao: 0,
          creditos: 0,
          descontos: 0,
          outros: null,
        },
        calculo: null,
        validacao: {
          valido: false,
          erros: [
            'Nenhum componente de energia identificado',
            'ICMS não identificado',
            'PIS não identificado',
            'COFINS não identificado',
          ],
        },
        completude: {
          faltantes: ['Energia/Consumo', 'ICMS', 'PIS', 'COFINS'],
        },
      },
    ])
  }

  // Logs iniciais
  if (getStore('logs').length === 0) {
    setStore('logs', [
      {
        id: 1,
        acao: 'Sistema inicializado',
        detalhe: 'Dados de demonstração criados',
        usuario: 'Sistema',
        data: '17/08/2026 22:00',
      },
    ])
  }
}