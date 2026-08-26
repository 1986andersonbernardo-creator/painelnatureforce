import { createContext, useContext, useState, useEffect } from 'react'
import {
  getStore,
  setStore,
  getSession,
  setSession,
  clearSession,
  registrarLog,
} from '../store/db'
import { loginComEmail, logoutFirebase, observarAuth } from '../firebase/auth'
import {
  getClientePorUid,
  salvarCliente,
  salvarFaturaProcessada,
  salvarFaturaIdempotente,
  atualizarFatura,
  getTodasFaturas,
  getFaturasPorStatus,
  registrarProcessamento,
  atualizarProcessamento,
  criarRevisaoFatura,
  getRevisoesPendentes,
  atualizarRevisao,
} from '../firebase/firestore'
import { processarFatura, normalizarReferencia, normalizarVencimento } from '../services/faturaProcessor'
import { normalizarUC } from '../services/faturaDedup'
import {
  buscarClientePorUC,
  criarPreCadastro as criarPreCadastroService,
  confirmarPreCadastro as confirmarPreCadastroService,
  descartarPreCadastro as descartarPreCadastroService,
  atualizarPreCadastro as atualizarPreCadastroService,
} from '../services/clienteAutoCadastro'

const AuthContext = createContext(null)

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth deve ser usado dentro de AuthProvider')
  return context
}

export function AuthProvider({ children }) {
  const [session, setSessionState] = useState(getSession())
  const [authLoading, setAuthLoading] = useState(true)

  // Observa o estado de autenticação do Firebase
  useEffect(() => {
    const unsubscribe = observarAuth(async (user) => {
      if (user) {
        // Usuário autenticado no Firebase
        const uid = user.uid

        // Busca dados do cliente no Firestore
        const resultado = await getClientePorUid(uid)

        if (resultado.ok) {
          const dadosCliente = resultado.data
          const novaSessao = {
            tipo: 'cliente',
            clienteId: uid,
            uid,
            nome: dadosCliente.nome || user.displayName || 'Cliente',
            email: dadosCliente.email || user.email,
            loginEm: new Date().toLocaleString('pt-BR'),
          }
          setSession(novaSessao)
          setSessionState(novaSessao)
        } else {
          // Cliente não encontrado no Firestore — tenta dados locais
          const clientes = getStore('clientes')
          const clienteLocal = clientes.find(
            (c) => c.emailAcesso?.toLowerCase() === user.email?.toLowerCase(),
          )

          if (clienteLocal) {
            // Vincula o UID ao cliente local e salva no Firestore
            const dadosFirestore = {
              nome: clienteLocal.nome,
              email: clienteLocal.email || user.email,
              telefone: clienteLocal.telefone || '',
              cpfCnpj: clienteLocal.cpfCnpj || '',
              endereco: clienteLocal.endereco || '',
              cidade: clienteLocal.cidade || '',
              estado: clienteLocal.estado || '',
              cep: clienteLocal.cep || '',
              whatsapp: clienteLocal.whatsapp || '',
              ativo: true,
              dataCadastro: clienteLocal.dataCadastro || new Date().toLocaleDateString('pt-BR'),
            }
            await salvarCliente(uid, dadosFirestore)

            const novaSessao = {
              tipo: 'cliente',
              clienteId: uid,
              uid,
              nome: clienteLocal.nome,
              email: clienteLocal.emailAcesso || user.email,
              loginEm: new Date().toLocaleString('pt-BR'),
            }
            setSession(novaSessao)
            setSessionState(novaSessao)
          } else {
            // Cliente não encontrado — sessão sem dados
            const novaSessao = {
              tipo: 'cliente',
              clienteId: uid,
              uid,
              nome: user.displayName || 'Cliente',
              email: user.email,
              loginEm: new Date().toLocaleString('pt-BR'),
            }
            setSession(novaSessao)
            setSessionState(novaSessao)
          }
        }
      } else {
        // Usuário deslogado
        clearSession()
        setSessionState(null)
      }
      setAuthLoading(false)
    })

    return () => unsubscribe()
  }, [])

  const loginAdmin = (email, senha) => {
    const usuarios = getStore('usuarios')
    const usuario = usuarios.find(
      (u) => u.email.toLowerCase() === email.trim().toLowerCase() && u.senha === senha,
    )

    if (!usuario) {
      return { ok: false, message: 'Credenciais inválidas. Verifique e-mail e senha.' }
    }

    const novaSessao = {
      tipo: 'admin',
      usuarioId: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      perfil: usuario.perfil,
      loginEm: new Date().toLocaleString('pt-BR'),
    }

    setSession(novaSessao)
    setSessionState(novaSessao)
    registrarLog('Login administrativo', `${usuario.nome} (${usuario.perfil})`, usuario.nome)
    return { ok: true }
  }

  const loginCliente = async (email, senha) => {
    // Tenta autenticar no Firebase
    const resultado = await loginComEmail(email, senha)

    if (resultado.ok) {
      const uid = resultado.user.uid

      // Busca dados do cliente no Firestore
      const dadosFirestore = await getClientePorUid(uid)

      if (dadosFirestore.ok) {
        const dadosCliente = dadosFirestore.data
        const novaSessao = {
          tipo: 'cliente',
          clienteId: uid,
          uid,
          nome: dadosCliente.nome || 'Cliente',
          email: dadosCliente.email || email,
          loginEm: new Date().toLocaleString('pt-BR'),
        }
        setSession(novaSessao)
        setSessionState(novaSessao)
        registrarLog('Login do cliente', `${novaSessao.nome} acessou o portal`, novaSessao.nome)
        return { ok: true }
      }

      // Fallback: dados locais
      const clientes = getStore('clientes')
      const clienteLocal = clientes.find(
        (c) => c.emailAcesso?.toLowerCase() === email.trim().toLowerCase(),
      )

      if (clienteLocal) {
        const dadosFirestore = {
          nome: clienteLocal.nome,
          email: clienteLocal.email || email,
          telefone: clienteLocal.telefone || '',
          cpfCnpj: clienteLocal.cpfCnpj || '',
          endereco: clienteLocal.endereco || '',
          cidade: clienteLocal.cidade || '',
          estado: clienteLocal.estado || '',
          cep: clienteLocal.cep || '',
          whatsapp: clienteLocal.whatsapp || '',
          ativo: true,
          dataCadastro: clienteLocal.dataCadastro || new Date().toLocaleDateString('pt-BR'),
        }
        await salvarCliente(uid, dadosFirestore)

        const novaSessao = {
          tipo: 'cliente',
          clienteId: uid,
          uid,
          nome: clienteLocal.nome,
          email: clienteLocal.emailAcesso || email,
          loginEm: new Date().toLocaleString('pt-BR'),
        }
        setSession(novaSessao)
        setSessionState(novaSessao)
        registrarLog('Login do cliente', `${clienteLocal.nome} acessou o portal`, clienteLocal.nome)
        return { ok: true }
      }

      // Cliente autenticado mas sem dados
      const novaSessao = {
        tipo: 'cliente',
        clienteId: uid,
        uid,
        nome: resultado.user.displayName || 'Cliente',
        email: resultado.user.email || email,
        loginEm: new Date().toLocaleString('pt-BR'),
      }
      setSession(novaSessao)
      setSessionState(novaSessao)
      return { ok: true }
    }

    // Fallback: login local (dados de demonstração)
    const clientes = getStore('clientes')
    const cliente = clientes.find(
      (c) => c.emailAcesso?.toLowerCase() === email.trim().toLowerCase() && c.senhaAcesso === senha,
    )

    if (cliente) {
      if (!cliente.ativo) {
        return { ok: false, message: 'Sua conta está inativa. Contate o suporte.' }
      }

      const novaSessao = {
        tipo: 'cliente',
        clienteId: cliente.id,
        nome: cliente.nome,
        email: cliente.emailAcesso,
        loginEm: new Date().toLocaleString('pt-BR'),
      }

      setSession(novaSessao)
      setSessionState(novaSessao)
      registrarLog('Login do cliente', `${cliente.nome} acessou o portal`, cliente.nome)
      return { ok: true }
    }

    return { ok: false, message: 'Credenciais inválidas. Verifique e-mail e senha.' }
  }

  const logout = async () => {
    if (session) {
      registrarLog('Logout', `${session.nome} encerrou a sessão`, session.nome)
    }
    await logoutFirebase()
    clearSession()
    setSessionState(null)
  }

  // ==================== CRUD Clientes ====================

  const getClientes = () => getStore('clientes')

  const addCliente = (dados) => {
    const clientes = getStore('clientes')
    const jaExiste = clientes.some(
      (c) => c.emailAcesso?.toLowerCase() === dados.emailAcesso?.toLowerCase(),
    )
    if (jaExiste) {
      return { ok: false, message: 'Já existe um cliente com este e-mail de acesso.' }
    }

    const novo = {
      id: Date.now() + Math.random(),
      ativo: true,
      dataCadastro: new Date().toLocaleDateString('pt-BR'),
      ...dados,
    }
    setStore('clientes', [...clientes, novo])
    const acao = session?.perfil === 'operador' ? 'Operador cadastrou cliente' : 'Cliente cadastrado'
    registrarLog(acao, `Cliente ${novo.nome} cadastrado`, session?.nome || 'Sistema')
    return { ok: true, cliente: novo }
  }

  const updateCliente = (id, dados) => {
    const clientes = getStore('clientes')
    const updated = clientes.map((c) => (c.id === id ? { ...c, ...dados } : c))
    setStore('clientes', updated)
    const cliente = updated.find((c) => c.id === id)
    registrarLog('Dados do cliente alterados', `Cliente ${cliente?.nome || id} atualizado`, session?.nome || 'Sistema')
    return { ok: true }
  }

  const toggleClienteAtivo = (id) => {
    const clientes = getStore('clientes')
    const cliente = clientes.find((c) => c.id === id)
    const updated = clientes.map((c) =>
      c.id === id ? { ...c, ativo: !c.ativo } : c,
    )
    setStore('clientes', updated)
    registrarLog(
      cliente?.ativo ? 'Cliente desativado' : 'Cliente ativado',
      `Cliente ${cliente?.nome || id}`,
      session?.nome || 'Sistema',
    )
    return { ok: true }
  }

  const removeCliente = (id) => {
    const clientes = getStore('clientes').filter((c) => c.id !== id)
    setStore('clientes', clientes)
    registrarLog('Cliente removido', `Cliente ID ${id} removido`, session?.nome || 'Sistema')
    return { ok: true }
  }

  // ==================== CRUD Unidades Consumidoras ====================

  const getUnidades = () => getStore('unidades')

  const addUnidade = (dados) => {
    const unidades = getStore('unidades')
    const numeroUC = normalizarUC(dados?.numeroUC)

    // numeroUC é OBRIGATÓRIO e é o principal identificador
    if (!numeroUC) {
      return { ok: false, message: 'O número da UC é obrigatório.' }
    }

    // Impede UC duplicada dentro do conjunto de unidades (evita confusão de fatura)
    const duplicada = unidades.some(
      (u) => normalizarUC(u.numeroUC) === numeroUC,
    )
    if (duplicada) {
      return { ok: false, message: `Já existe uma UC cadastrada com o número ${numeroUC}.` }
    }

    // O titular da conta NÃO é preenchido automaticamente com o nome do cliente:
    // Cliente Nature Force ≠ Titular da fatura. Conceitos mantidos separados.
    const nova = {
      id: Date.now() + Math.random(),
      codigoInstalacao: dados.codigoInstalacao || '',
      distribuidora: dados.distribuidora || '',
      titularNome: dados.titularNome || '',
      titularCpfCnpj: dados.titularCpfCnpj || '',
      endereco: dados.endereco || '',
      numero: dados.numero || '',
      complemento: dados.complemento || '',
      bairro: dados.bairro || '',
      cidade: dados.cidade || '',
      estado: dados.estado || '',
      cep: dados.cep || '',
      numeroMedidor: dados.numeroMedidor || '',
      status: dados.status || 'ativo',
      dataVinculacao: new Date().toLocaleDateString('pt-BR'),
      ...dados,
      numeroUC, // sobrescreve qualquer numeroUC vindo de dados (normalizado)
    }
    setStore('unidades', [...unidades, nova])
    registrarLog('UC vinculada', `UC ${nova.numeroUC} vinculada ao cliente ${nova.clienteId}`, session?.nome || 'Sistema')
    return { ok: true, unidade: nova }
  }

  const updateUnidade = (id, dados) => {
    const unidades = getStore('unidades')
    const atual = unidades.find((u) => u.id === id)
    if (!atual) return { ok: false, message: 'Unidade consumidora não encontrada.' }

    const numeroUC = normalizarUC(dados?.numeroUC ?? atual.numeroUC)
    if (!numeroUC) {
      return { ok: false, message: 'O número da UC é obrigatório.' }
    }

    // Não permite repetir uma UC que já pertença a outra unidade cadastrada
    const duplicada = unidades.some(
      (u) => u.id !== id && normalizarUC(u.numeroUC) === numeroUC,
    )
    if (duplicada) {
      return { ok: false, message: `Já existe outra UC cadastrada com o número ${numeroUC}.` }
    }

    const updated = unidades.map((u) =>
      u.id === id
        ? { ...u, ...dados, numeroUC, atualizadoEm: new Date().toLocaleString('pt-BR') }
        : u,
    )
    setStore('unidades', updated)
    registrarLog('UC atualizada', `UC ${numeroUC} atualizada`, session?.nome || 'Sistema')
    return { ok: true, unidade: updated.find((u) => u.id === id) }
  }

  const removeUnidade = (id) => {
    const unidades = getStore('unidades').filter((u) => u.id !== id)
    setStore('unidades', unidades)
    registrarLog('UC removida', `UC ID ${id} removida`, session?.nome || 'Sistema')
    return { ok: true }
  }

  // ==================== CRUD Faturas ====================

  const getFaturas = () => getStore('faturas')

  const addFatura = (dados) => {
    const faturas = getStore('faturas')
    const nova = {
      id: Date.now() + Math.random(),
      dataUpload: new Date().toLocaleDateString('pt-BR'),
      status: 'aguardando revisão',
      ...dados,
    }
    setStore('faturas', [...faturas, nova])
    registrarLog(
      'Fatura enviada',
      `Fatura ${nova.arquivo} para ${nova.clienteNome || 'cliente desconhecido'}`,
      session?.nome || 'Sistema',
    )
    return { ok: true, fatura: nova }
  }

  const updateFatura = (id, dados) => {
    const faturas = getStore('faturas')
    const updated = faturas.map((f) => (f.id === id ? { ...f, ...dados } : f))
    setStore('faturas', updated)
    const fat = updated.find((f) => f.id === id)
    registrarLog('Fatura atualizada', `Fatura ${fat?.arquivo || id} status: ${dados.status || 'alterado'}`, session?.nome || 'Sistema')
    return { ok: true }
  }

  const removeFatura = (id) => {
    const faturas = getStore('faturas').filter((f) => f.id !== id)
    setStore('faturas', faturas)
    registrarLog('Fatura removida', `Fatura ID ${id} removida`, session?.nome || 'Sistema')
    return { ok: true }
  }

  // ==================== Processamento de Faturas (PDF) ====================

  // Processa um PDF de fatura e retorna os dados extraídos e calculados
  const processarPDF = async (arquivoPDF) => {
    return await processarFatura(arquivoPDF)
  }

  // Salva uma fatura processada no Firestore
  const salvarFaturaFirestore = async (dados) => {
    return await salvarFaturaProcessada(dados)
  }

  // Salva uma fatura no Firestore de forma idempotente (impede duplicação)
  const salvarFaturaIdempotenteFirestore = async (dados) => {
    return await salvarFaturaIdempotente(dados)
  }

  // Atualiza uma fatura no Firestore
  const atualizarFaturaFirestore = async (faturaId, dados) => {
    return await atualizarFatura(faturaId, dados)
  }

  // Busca todas as faturas do Firestore
  const buscarTodasFaturas = async () => {
    return await getTodasFaturas()
  }

  // Busca faturas por status no Firestore
  const buscarFaturasPorStatus = async (status) => {
    return await getFaturasPorStatus(status)
  }

  // Registra o processamento de uma fatura
  const registrarProcessamentoFatura = async (dados) => {
    return await registrarProcessamento(dados)
  }

  // Atualiza o status do processamento
  const atualizarProcessamentoFatura = async (processamentoId, dados) => {
    return await atualizarProcessamento(processamentoId, dados)
  }

  // Cria uma revisão para fatura que requer análise
  const criarRevisao = async (dados) => {
    return await criarRevisaoFatura(dados)
  }

  // Busca revisões pendentes
  const buscarRevisoesPendentes = async () => {
    return await getRevisoesPendentes()
  }

  // Atualiza uma revisão
  const atualizarRevisaoFatura = async (revisaoId, dados) => {
    return await atualizarRevisao(revisaoId, dados)
  }

  // Normaliza a referência extraída do PDF
  const normalizarRef = (referencia) => normalizarReferencia(referencia)

  // Normaliza o vencimento extraído do PDF
  const normalizarVenc = (vencimento) => normalizarVencimento(vencimento)

  // ==================== Auto-cadastro por fatura (pré-cadastros) ====================

  const getPreCadastros = () => getStore('preCadastros')

  const identificarClientePorUC = (uc) => buscarClientePorUC(uc)

  const addPreCadastro = (dados, contexto) => criarPreCadastroService(dados, contexto)

  const confirmarPreCadastro = (id, dadosEditados, contexto) =>
    confirmarPreCadastroService(id, dadosEditados, contexto)

  const descartarPreCadastro = (id, contexto) => descartarPreCadastroService(id, contexto)

  const updatePreCadastro = (id, dados, contexto) => atualizarPreCadastroService(id, dados, contexto)

  // ==================== Usuários administrativos ====================

  const getUsuarios = () => getStore('usuarios')

  const addUsuario = (dados) => {
    const usuarios = getStore('usuarios')
    const jaExiste = usuarios.some((u) => u.email.toLowerCase() === dados.email.toLowerCase())
    if (jaExiste) {
      return { ok: false, message: 'Já existe um usuário com este e-mail.' }
    }
    const novo = {
      id: Date.now() + Math.random(),
      criadoEm: new Date().toLocaleDateString('pt-BR'),
      ...dados,
    }
    setStore('usuarios', [...usuarios, novo])
    registrarLog('Usuário administrativo criado', `${novo.nome} (${novo.perfil})`, session?.nome || 'Sistema')
    return { ok: true }
  }

  const removeUsuario = (id) => {
    if (session?.usuarioId === id) {
      return { ok: false, message: 'Você não pode remover o próprio usuário.' }
    }
    const usuarios = getStore('usuarios').filter((u) => u.id !== id)
    setStore('usuarios', usuarios)
    registrarLog('Usuário administrativo removido', `Usuário ID ${id}`, session?.nome || 'Sistema')
    return { ok: true }
  }

  // ==================== Logs ====================

  const getLogs = () => getStore('logs')

  const value = {
    session,
    authLoading,
    loginAdmin,
    loginCliente,
    logout,
    getClientes,
    addCliente,
    updateCliente,
    toggleClienteAtivo,
    removeCliente,
    getUnidades,
    addUnidade,
    updateUnidade,
    removeUnidade,
    getFaturas,
    addFatura,
    updateFatura,
    removeFatura,
    getUsuarios,
    addUsuario,
    removeUsuario,
    getLogs,
    // Auto-cadastro por fatura
    getPreCadastros,
    identificarClientePorUC,
    addPreCadastro,
    confirmarPreCadastro,
    descartarPreCadastro,
    updatePreCadastro,
    // Processamento de faturas
    processarPDF,
    salvarFaturaFirestore,
    salvarFaturaIdempotenteFirestore,
    atualizarFaturaFirestore,
    buscarTodasFaturas,
    buscarFaturasPorStatus,
    registrarProcessamentoFatura,
    atualizarProcessamentoFatura,
    criarRevisao,
    buscarRevisoesPendentes,
    atualizarRevisaoFatura,
    normalizarRef,
    normalizarVenc,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}