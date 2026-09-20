import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import {
  getStore,
  setStore,
  getSession,
  setSession,
  clearSession,
  montarLog,
  salvarLog,
  getIndiceSync,
  setIndiceSync,
} from '../store/db'
import { loginComEmail, logoutFirebase, observarAuth, entrarComoSessaoAdmin } from '../firebase/auth'
// Autorização administrativa — a MESMA lista usada nas Firestore Security Rules.
import { ehEmailAdmin, podeAdministrar } from '../services/adminAccess'
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
  listarDocumentos,
  observarColecao,
  observarClientePorUid,
  sincronizarColecaoRemota,
  removerDocumento,
  salvarDocumento,
} from '../firebase/firestore'
import { processarFatura, normalizarReferencia, normalizarVencimento } from '../services/faturaProcessor'
import { normalizarUC } from '../services/faturaDedup'
import {
  COLECOES_SINCRONIZADAS,
  associarUCaCliente,
  atualizarIndiceRemoto,
  filtrarFaturasDoCliente,
  idDocumento,
  mesclarColecao,
  novoId,
  propagarVinculoCliente,
  reconciliarComRemoto,
  resumoProcessamento,
  usuarioParaBanco,
} from '../services/persistencia'
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

// A autorização administrativa vive em src/services/adminAccess.js — a MESMA
// lista de e-mails usada nas Firestore Security Rules (isAdmin). Sem uma conta
// Firebase autorizada o administrador NÃO grava no banco compartilhado: as
// alterações ficam restritas ao cache local e a interface avisa isso.

export function AuthProvider({ children }) {
  const [session, setSessionState] = useState(getSession())
  const [authLoading, setAuthLoading] = useState(true)

  // Espelho imediato da sessão. Necessário porque os callbacks do Firebase
  // (onAuthStateChanged) podem disparar antes de o estado React atualizar.
  const sessaoRef = useRef(getSession())

  // Índice de chaves já vistas no banco central — permite detectar exclusões
  // feitas em outro dispositivo. Metadado de sincronização, não é dado de
  // negócio (fica fora das chaves de dados em store/db.js).
  const indiceSyncRef = useRef(getIndiceSync())

  // Versão dos dados locais: incrementada a cada escrita/hidratação para
  // forçar a re-renderização das telas que leem getStore() durante o render.
  const [dadosVersao, setDadosVersao] = useState(0)

  // Estado da sincronização com o banco compartilhado (Firestore):
  //   modo 'firestore' → alterações persistem no banco e chegam à Área do Cliente
  //   modo 'local'     → alterações persistem apenas neste navegador (cache local)
  const [estadoSync, setEstadoSync] = useState({
    modo: 'local',
    sincronizando: false,
    erro: '',
    ultimaSync: '',
  })

  const hidratadoRef = useRef(false)

  const bumpVersao = useCallback(() => setDadosVersao((v) => v + 1), [])

  /**
   * Aplica a sessão em todos os lugares de uma vez (localStorage + React +
   * espelho de referência), evitando sessões divergentes entre callbacks.
   * @param {Object|null} novaSessao
   */
  const aplicarSessao = useCallback((novaSessao) => {
    sessaoRef.current = novaSessao
    if (novaSessao) setSession(novaSessao)
    else clearSession()
    setSessionState(novaSessao)
  }, [])

  // Só o administrador com sessão Firebase autenticada E autorizada grava nas
  // coleções administrativas — as Firestore Security Rules exigem
  // request.auth != null e o perfil administrativo (e-mail/claim).
  const podeEscreverCompartilhado =
    session?.tipo === 'admin' && Boolean(session?.uid) && session?.sincronizacaoBanco === true

  const registrarFalhaSync = useCallback((erro, codigo) => {
    setEstadoSync({
      modo: 'local',
      sincronizando: false,
      erro: erro || 'Sem permissão de sincronização.',
      codigo: codigo || '',
      ultimaSync: new Date().toLocaleString('pt-BR'),
    })
  }, [])

  const registrarSucessoSync = useCallback((detalhe = '') => {
    setEstadoSync({
      modo: 'firestore',
      sincronizando: false,
      erro: '',
      codigo: '',
      detalhe,
      ultimaSync: new Date().toLocaleString('pt-BR'),
    })
  }, [])

  /**
   * Espelha um registro no Firestore (assíncrono, sem bloquear a UI).
   * A gravação local já aconteceu antes — o cache nunca fica inconsistente.
   */
  const sincronizarItem = useCallback(
    (colecao, item) => {
      if (!podeEscreverCompartilhado || !item) return
      salvarDocumento(colecao, idDocumento(colecao, item), item).then((resultado) => {
        if (resultado.ok) registrarSucessoSync(`${colecao}: ${idDocumento(colecao, item)}`)
        else registrarFalhaSync(resultado.message, resultado.codigo)
      })
    },
    [podeEscreverCompartilhado, registrarFalhaSync, registrarSucessoSync],
  )

  const sincronizarRemocao = useCallback(
    (colecao, id) => {
      if (!podeEscreverCompartilhado || !id) return
      removerDocumento(colecao, id).then((resultado) => {
        if (!resultado.ok) registrarFalhaSync(resultado.message, resultado.codigo)
      })
    },
    [podeEscreverCompartilhado, registrarFalhaSync],
  )

  // Envia a coleção inteira para o Firestore (usado após operações em lote,
  // como vincular/remover UCs de um cliente).
  const sincronizarColecao = useCallback(
    (colecao) => {
      if (!podeEscreverCompartilhado) return
      sincronizarColecaoRemota(colecao, getStore(colecao)).then((resultado) => {
        if (resultado.ok) registrarSucessoSync(`${colecao}: ${resultado.gravados} registro(s)`)
        else registrarFalhaSync('Falha ao sincronizar com o banco compartilhado.', resultado.falhas?.[0]?.codigo)
      })
    },
    [podeEscreverCompartilhado, registrarFalhaSync, registrarSucessoSync],
  )

  /**
   * Grava o log no cache local E espelha no banco central — o histórico de
   * auditoria é o mesmo em todos os dispositivos.
   * @param {string} acao
   * @param {string} detalhe
   * @param {string} usuario
   */
  const logar = useCallback(
    (acao, detalhe = '', usuario = '') => {
      const novo = salvarLog(montarLog(acao, detalhe, usuario))
      if (novo) sincronizarItem('logs', novo)
      return novo
    },
    [podeEscreverCompartilhado, sincronizarItem],
  )

  /**
   * Aplica no cache local o estado recebido do BANCO CENTRAL.
   * O Firestore vence; exclusões remotas propagam; pendências locais (escritas
   * ainda não confirmadas pelo banco) permanecem.
   * @param {string} colecao
   * @param {Array} dadosRemotos
   */
  const aplicarDadosRemotos = useCallback((colecao, dadosRemotos = []) => {
    const { itens, chavesRemotas, removidos } = reconciliarComRemoto({
      colecao,
      local: getStore(colecao),
      remoto: dadosRemotos,
      chavesConhecidas: indiceSyncRef.current?.[colecao] || [],
      preservarCampos: colecao === 'usuarios' ? ['senha'] : [],
    })

    setStore(colecao, itens)
    indiceSyncRef.current = atualizarIndiceRemoto(
      indiceSyncRef.current,
      colecao,
      chavesRemotas,
    ).indice

    if (removidos.length > 0) {
      salvarLog(
        montarLog(
          'Sincronização',
          `${colecao}: ${removidos.length} registro(s) removido(s) pelo banco central`,
          'Sistema',
        ),
      )
    }
  }, [])

  /**
   * Espelha um cliente no Firestore.
   * Quando o cliente já está vinculado a um UID, o documento gravado é
   * `clientes/{uid}` — a chave que a Área do Cliente e as regras de segurança
   * usam. Caso contrário mantém-se o id local.
   */
  const sincronizarCliente = useCallback(
    (cliente) => {
      if (!podeEscreverCompartilhado || !cliente) return
      const id = idDocumento('clientes', cliente)
      salvarDocumento('clientes', id, cliente).then((resultado) => {
        if (resultado.ok) registrarSucessoSync(`cliente ${cliente.nome || id}`)
        else registrarFalhaSync(resultado.message, resultado.codigo)
      })
    },
    [podeEscreverCompartilhado, registrarFalhaSync, registrarSucessoSync],
  )

  /**
   * Hidrata o cache local com os dados do BANCO CENTRAL (Firestore).
   *
   * O Firestore é a fonte da verdade: o cache é reconciliado com o que veio do
   * banco. Alterações ainda não sincronizadas permanecem (pendência) e
   * registros excluídos em outro dispositivo são removidos deste cache.
   * Uma falha em UMA coleção não impede o carregamento das demais — antes, o
   * primeiro erro abortava tudo e o painel exibia o cache desatualizado.
   */
  const recarregarDadosCompartilhados = useCallback(async () => {
    if (!podeEscreverCompartilhado) {
      setEstadoSync((atual) => ({ ...atual, modo: 'local', sincronizando: false }))
      return { ok: false, message: 'Sessão administrativa sem autenticação no banco compartilhado.' }
    }

    setEstadoSync((atual) => ({ ...atual, sincronizando: true }))

    const falhas = []
    let falhaCritica = null

    for (const colecao of COLECOES_SINCRONIZADAS) {
      const resultado = await listarDocumentos(colecao)
      if (!resultado.ok) {
        falhas.push({ colecao, codigo: resultado.codigo, message: resultado.message })
        if (['clientes', 'unidades', 'faturas', 'preCadastros'].includes(colecao)) {
          falhaCritica = resultado
        }
        continue
      }

      aplicarDadosRemotos(colecao, resultado.data)
    }

    setIndiceSync(indiceSyncRef.current)
    bumpVersao()

    if (falhaCritica) {
      registrarFalhaSync(falhaCritica.message, falhaCritica.codigo)
      return { ok: false, message: falhaCritica.message, falhas }
    }

    registrarSucessoSync('dados compartilhados carregados do Firestore')
    return { ok: true, falhas }
  }, [
    podeEscreverCompartilhado,
    aplicarDadosRemotos,
    bumpVersao,
    registrarFalhaSync,
    registrarSucessoSync,
  ])

  // Hidratação automática ao entrar na Área Administrativa autenticada
  useEffect(() => {
    if (!podeEscreverCompartilhado) {
      hidratadoRef.current = false
      return
    }
    if (hidratadoRef.current) return
    hidratadoRef.current = true
    recarregarDadosCompartilhados()
  }, [podeEscreverCompartilhado, recarregarDadosCompartilhados])

  // ==================== Sincronização em tempo real ====================
  // onSnapshot: quando o banco central muda (alteração feita em outro
  // dispositivo), o cache local é reconciliado e a interface atualiza sozinha.
  useEffect(() => {
    if (!podeEscreverCompartilhado) return undefined

    const desobservar = COLECOES_SINCRONIZADAS.map((colecao) =>
      observarColecao(colecao, (resultado) => {
        if (!resultado.ok) {
          registrarFalhaSync(resultado.message, resultado.codigo)
          return
        }
        aplicarDadosRemotos(colecao, resultado.data)
        setIndiceSync(indiceSyncRef.current)
        bumpVersao()
      }),
    )

    return () => desobservar.forEach((desinscrever) => desinscrever())
  }, [podeEscreverCompartilhado, aplicarDadosRemotos, bumpVersao, registrarFalhaSync])

  /**
   * Vincula um cliente ao UID do Firebase e propaga o vínculo para as suas
   * unidades e faturas.
   *
   * Por que isso é obrigatório: a Área do Cliente lê `faturas`/`unidades`
   * filtrando `clienteId == uid`. O administrador cadastra usando um id local,
   * então sem esta ponte o cliente NUNCA enxergaria as faturas processadas
   * (e os dados antigos do Firestore continuariam prevalecendo).
   *
   * @param {string} uid - UID do Firebase Authentication
   * @param {{email?:string, dadosRemotos?:Object}} contexto
   * @returns {Object|null} Registro do cliente já vinculado
   */
  const vincularClienteAoUid = useCallback(
    (uid, { email = '', dadosRemotos = null } = {}) => {
      if (!uid) return null

      const clientes = getStore('clientes')
      const emailNormalizado = String(email || '').trim().toLowerCase()

      const clienteLocal =
        clientes.find((c) => String(c.uid || '') === String(uid)) ||
        clientes.find(
          (c) =>
            emailNormalizado &&
            String(c.emailAcesso || c.email || '').trim().toLowerCase() === emailNormalizado,
        ) ||
        null

      // Reconcilia o cadastro local com o documento do Firestore (o mais
      // recente vence; nenhum campo é descartado).
      let clienteBase = clienteLocal
      if (dadosRemotos) {
        const mesclado = mesclarColecao({
          colecao: 'clientes',
          local: clienteLocal ? [{ ...clienteLocal, uid }] : [],
          remoto: [{ ...dadosRemotos, id: uid }],
        })
        clienteBase = mesclado[0] || clienteLocal
      } else if (clienteLocal) {
        clienteBase = { ...clienteLocal, uid }
      }

      if (!clienteBase) return null

      const vinculo = propagarVinculoCliente({
        clientes,
        unidades: getStore('unidades'),
        faturas: getStore('faturas'),
        cliente: { ...clienteBase, id: clienteBase.id || uid },
        uid,
      })

      setStore('clientes', vinculo.clientes)
      setStore('unidades', vinculo.unidades)
      setStore('faturas', vinculo.faturas)
      bumpVersao()

      // Espelha o cadastro (com o UID) no banco compartilhado. O próprio cliente
      // autenticado pode gravar o seu documento (isOwner nas security rules).
      salvarDocumento('clientes', uid, { ...vinculo.cliente, uid }).then((resultado) => {
        if (!resultado.ok) registrarFalhaSync(resultado.message, resultado.codigo)
      })

      logar(
        'Vínculo UID',
        `Cliente ${vinculo.cliente.nome || uid} vinculado ao Firebase (${vinculo.propagados} registro(s) propagado(s))`,
        'Sistema',
      )

      return vinculo.cliente
    },
    [bumpVersao, registrarFalhaSync],
  )

  // Observa o estado de autenticação do Firebase
  useEffect(() => {
    const unsubscribe = observarAuth(async (user) => {
      if (user) {
        const uid = user.uid
        const emailUsuario = user.email || ''

        // ===== PROTEÇÃO DA SESSÃO ADMINISTRATIVA =====
        // O login administrativo TAMBÉM autentica no Firebase e dispara este
        // observador. Antes, ele sobrescrevia a sessão do admin com uma sessão
        // de cliente (mesmo uid) — o administrador perdia o perfil e cada
        // dispositivo passava a exibir dados diferentes.
        const sessaoAtual = sessaoRef.current
        if (sessaoAtual?.tipo === 'admin' && String(sessaoAtual.uid || '') === String(uid)) {
          setAuthLoading(false)
          return
        }

        // Conta administrativa autenticada → NUNCA cria sessão de cliente.
        if (ehEmailAdmin(emailUsuario)) {
          setAuthLoading(false)
          return
        }

        // ===== Sessão do CLIENTE =====
        // Busca dados do cliente no Firestore
        const resultado = await getClientePorUid(uid)
        const dadosRemotos = resultado.ok ? resultado.data : null

        // Ponte de identidade: grava o UID no cadastro local e propaga o
        // vínculo para unidades/faturas (sem isso a Área do Cliente não
        // encontra os dados cadastrados pelo administrador).
        const clienteVinculado = vincularClienteAoUid(uid, {
          email: dadosRemotos?.email || emailUsuario,
          dadosRemotos,
        })

        const dadosCliente = clienteVinculado || dadosRemotos || {}

        const novaSessao = {
          tipo: 'cliente',
          clienteId: uid,
          uid,
          nome: dadosCliente.nome || user.displayName || 'Cliente',
          email: dadosCliente.email || emailUsuario,
          loginEm: new Date().toLocaleString('pt-BR'),
        }
        aplicarSessao(novaSessao)
        logar('Login do cliente', `${novaSessao.nome} acessou o portal`, novaSessao.nome)
      } else {
        // Usuário deslogado no Firebase. Só encerra a sessão se ela DEPENDE do
        // Firebase (uid presente). Sessão puramente local (admin offline) não
        // é derrubada por um evento do Firebase.
        if (sessaoRef.current?.uid) aplicarSessao(null)
      }
      setAuthLoading(false)
    })

    return () => unsubscribe()
  }, [vincularClienteAoUid, aplicarSessao, logar])

  const loginAdmin = async (email, senha) => {
    const emailNormalizado = String(email || '').trim().toLowerCase()

    // ===== 1. FONTE DA VERDADE: Firebase Authentication =====
    // A conta administrativa precisa estar provisionada no Firebase (mesmo
    // e-mail e senha). O login administrativo NUNCA é decidido por dados locais.
    const sessaoBanco = await entrarComoSessaoAdmin(emailNormalizado, senha)

    if (sessaoBanco.ok) {
      // A autorização espelha exatamente o isAdmin() das Security Rules:
      // custom claim `admin: true` OU e-mail na lista de administradores.
      // (antes aceitava qualquer usuário local com perfil "administrador",
      // mesmo sem permissão no banco — o frontend achava que gravava e o
      // Firestore negava, deixando cada navegador com o seu próprio dado.)
      const emailFirebase = sessaoBanco.user.email || emailNormalizado
      const autorizado = podeAdministrar({
        email: emailFirebase,
        claimAdmin: sessaoBanco.claimAdmin,
      })

      if (!autorizado) {
        await logoutFirebase()
        return { ok: false, message: 'Esta conta não tem perfil administrativo.' }
      }

      // Garante o registro do administrador na tela de Usuários (sem
      // sobrescrever dados já cadastrados) e espelha no banco central SEM a
      // senha — credenciais vivem no Firebase Authentication.
      const usuarios = getStore('usuarios')
      const existente = usuarios.find(
        (u) => String(u.email).trim().toLowerCase() === emailFirebase.toLowerCase(),
      )
      const nome = existente?.nome || sessaoBanco.user.displayName || 'Administrador'
      const perfil = existente?.perfil || 'administrador'
      const usuarioRegistro = existente
        ? { ...existente, uid: sessaoBanco.user.uid, perfil }
        : {
            id: novoId('usr'),
            nome,
            email: emailFirebase,
            perfil,
            uid: sessaoBanco.user.uid,
            criadoEm: new Date().toLocaleDateString('pt-BR'),
            origem: 'FIREBASE',
          }
      if (!existente) setStore('usuarios', [...usuarios, usuarioRegistro])
      sincronizarItem('usuarios', usuarioParaBanco(usuarioRegistro))

      const novaSessao = {
        tipo: 'admin',
        usuarioId: usuarioRegistro.id,
        uid: sessaoBanco.user.uid,
        nome,
        email: emailFirebase,
        perfil,
        sincronizacaoBanco: true,
        loginEm: new Date().toLocaleString('pt-BR'),
      }

      aplicarSessao(novaSessao)
      logar('Login administrativo', `${nome} (${perfil})`, nome)
      registrarSucessoSync('sessão administrativa autenticada no Firebase')
      return { ok: true, sincronizadoBanco: true }
    }

    // ===== 2. Fallback local (excepcional) =====
    // APENAS quando o Firebase Authentication não pôde ser alcançado (sem
    // internet) OU quando a conta ainda NÃO existe lá. Quando o Firebase
    // REJEITA as credenciais (senha inválida, conta desativada, provedor
    // desligado), o fallback NÃO é aplicado: a decisão do Firebase prevalece —
    // caso contrário uma senha antiga no cache local abriria um banco que o
    // Firebase está negando (falha de segurança).
    const fallbackPermitido =
      sessaoBanco.motivo === 'auth/user-not-found' ||
      sessaoBanco.motivo === 'auth/network-request-failed' ||
      sessaoBanco.motivo === 'auth/erro-desconhecido'

    if (!fallbackPermitido) {
      return { ok: false, message: sessaoBanco.message || 'Credenciais inválidas. Verifique e-mail e senha.' }
    }

    // Mantém o acesso administrativo quando NÃO há sessão no Firebase (ex.: sem
    // internet, ou conta ainda não provisionada). NESTE MODO as alterações
    // ficam restritas a este navegador e o painel avisa explicitamente — nunca
    // é apresentado como se fosse o dado compartilhado.
    const usuarios = getStore('usuarios')
    const usuario = usuarios.find(
      (u) => String(u.email).trim().toLowerCase() === emailNormalizado && u.senha === senha,
    )

    if (!usuario) {
      return {
        ok: false,
        message:
          sessaoBanco.message ||
          'Credenciais inválidas. Verifique e-mail e senha.',
      }
    }

    const novaSessao = {
      tipo: 'admin',
      usuarioId: usuario.id,
      uid: null,
      nome: usuario.nome,
      email: usuario.email,
      perfil: usuario.perfil,
      sincronizacaoBanco: false,
      loginEm: new Date().toLocaleString('pt-BR'),
    }

    aplicarSessao(novaSessao)
    logar('Login administrativo (local)', `${usuario.nome} (${usuario.perfil})`, usuario.nome)
    registrarFalhaSync(
      'Sessão administrativa SEM acesso ao banco compartilhado. As alterações ficam salvas APENAS neste navegador. Para sincronizar: 1) abra o Console do Firebase → Authentication → Sign-in method → ative Email/Password; 2) em Authentication → Users → Add user, crie a conta com este MESMO e-mail e senha; 3) entre novamente.',
      sessaoBanco.motivo || 'admin/sem-sessao-banco',
    )
    return { ok: true, sincronizadoBanco: false }
  }

  const loginCliente = async (email, senha) => {
    // Tenta autenticar no Firebase
    const resultado = await loginComEmail(email, senha)

    if (resultado.ok) {
      const uid = resultado.user.uid

      // Busca dados do cliente no Firestore
      const dadosFirestore = await getClientePorUid(uid)
      const dadosRemotos = dadosFirestore.ok ? dadosFirestore.data : null

      // Vincula o UID ao cadastro local e propaga para unidades/faturas
      const clienteVinculado = vincularClienteAoUid(uid, {
        email: dadosRemotos?.email || resultado.user.email || email,
        dadosRemotos,
      })

      // Se o cliente existe apenas localmente, espelha o cadastro no Firestore.
      // Falha NÃO é silenciosa: o cliente fica sabendo que o cadastro não
      // chegou ao banco central (antes o erro era engolido e o dado ficava
      // preso no cache do navegador).
      const dadosParaEspelhar = dadosRemotos || clienteVinculado
      if (!dadosRemotos && dadosParaEspelhar) {
        const espelho = await salvarCliente(uid, { ...dadosParaEspelhar, uid, ativo: true })
        if (!espelho.ok) {
          registrarFalhaSync(
            'Não foi possível salvar seu cadastro no banco central. Tente novamente.',
            espelho.codigo || 'firestore/erro',
          )
        }
      }

      const dadosCliente = clienteVinculado || dadosRemotos || {}
      const novaSessao = {
        tipo: 'cliente',
        clienteId: uid,
        uid,
        nome: dadosCliente.nome || resultado.user.displayName || 'Cliente',
        email: dadosCliente.email || resultado.user.email || email,
        loginEm: new Date().toLocaleString('pt-BR'),
      }
      aplicarSessao(novaSessao)
      logar('Login do cliente', `${novaSessao.nome} acessou o portal`, novaSessao.nome)
      return { ok: true }
    }

    // Fallback: login local (cliente cadastrado pelo administrador e ainda sem
    // conta no Firebase Authentication). Sessão SEM Firebase — os dados vêm do
    // cache local e as alterações ficam restritas a este navegador.
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

      aplicarSessao(novaSessao)
      logar('Login do cliente (local)', `${cliente.nome} acessou o portal`, cliente.nome)
      return { ok: true }
    }

    return { ok: false, message: 'Credenciais inválidas. Verifique e-mail e senha.' }
  }

  const logout = async () => {
    if (session) {
      logar('Logout', `${session.nome} encerrou a sessão`, session.nome)
    }
    await logoutFirebase()
    hidratadoRef.current = false
    indiceSyncRef.current = {}
    setIndiceSync({})
    aplicarSessao(null)
  }

  // ==================== CRUD Clientes ====================
  //
  // Todas as escritas abaixo seguem o MESMO padrão de persistência:
  //   1. grava no cache local (síncrono) → sobrevive a reload/logout;
  //   2. espelha no Firestore (assíncrono) → chega à Área do Cliente e a outros
  //      navegadores/dispositivos;
  //   3. incrementa a versão dos dados → a tela re-renderiza com o novo valor.

  const getClientes = () => getStore('clientes')

  const addCliente = (dados) => {
    const clientes = getStore('clientes')
    const jaExiste = clientes.some(
      (c) => c.emailAcesso?.toLowerCase() === dados.emailAcesso?.toLowerCase(),
    )
    if (jaExiste) {
      return { ok: false, message: 'Já existe um cliente com este e-mail de acesso.' }
    }

    const agora = new Date()
    const novo = {
      id: novoId('cli'),
      ativo: true,
      dataCadastro: agora.toLocaleDateString('pt-BR'),
      atualizadoEm: agora.toLocaleString('pt-BR'),
      atualizadoEmMs: agora.getTime(),
      ...dados,
    }
    setStore('clientes', [...clientes, novo])
    sincronizarItem('clientes', novo)
    bumpVersao()
    const acao = session?.perfil === 'operador' ? 'Operador cadastrou cliente' : 'Cliente cadastrado'
    logar(acao, `Cliente ${novo.nome} cadastrado`, session?.nome || 'Sistema')
    return { ok: true, cliente: novo }
  }

  const updateCliente = (id, dados) => {
    const clientes = getStore('clientes')
    const agora = new Date()
    const updated = clientes.map((c) =>
      String(c.id) === String(id)
        ? { ...c, ...dados, atualizadoEm: agora.toLocaleString('pt-BR'), atualizadoEmMs: agora.getTime() }
        : c,
    )
    setStore('clientes', updated)
    const cliente = updated.find((c) => String(c.id) === String(id))
    if (cliente) sincronizarCliente(cliente)
    bumpVersao()
    logar('Dados do cliente alterados', `Cliente ${cliente?.nome || id} atualizado`, session?.nome || 'Sistema')
    return { ok: true, cliente }
  }

  const toggleClienteAtivo = (id) => {
    const clientes = getStore('clientes')
    const cliente = clientes.find((c) => String(c.id) === String(id))
    const agora = new Date()
    const updated = clientes.map((c) =>
      String(c.id) === String(id)
        ? { ...c, ativo: !c.ativo, atualizadoEm: agora.toLocaleString('pt-BR'), atualizadoEmMs: agora.getTime() }
        : c,
    )
    setStore('clientes', updated)
    const atualizado = updated.find((c) => String(c.id) === String(id))
    if (atualizado) sincronizarCliente(atualizado)
    bumpVersao()
    logar(
      cliente?.ativo ? 'Cliente desativado' : 'Cliente ativado',
      `Cliente ${cliente?.nome || id}`,
      session?.nome || 'Sistema',
    )
    return { ok: true }
  }

  const removeCliente = (id) => {
    const clientes = getStore('clientes')
    const cliente = clientes.find((c) => String(c.id) === String(id))
    setStore('clientes', clientes.filter((c) => String(c.id) !== String(id)))
    if (cliente) sincronizarRemocao('clientes', idDocumento('clientes', cliente))
    bumpVersao()
    logar('Cliente removido', `Cliente ID ${id} removido`, session?.nome || 'Sistema')
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
    const agora = new Date()
    const nova = {
      id: novoId('uc'),
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
      dataVinculacao: agora.toLocaleDateString('pt-BR'),
      atualizadoEm: agora.toLocaleString('pt-BR'),
      atualizadoEmMs: agora.getTime(),
      ...dados,
      numeroUC, // sobrescreve qualquer numeroUC vindo de dados (normalizado)
    }
    setStore('unidades', [...unidades, nova])
    sincronizarItem('unidades', nova)
    bumpVersao()
    logar('UC vinculada', `UC ${nova.numeroUC} vinculada ao cliente ${nova.clienteId}`, session?.nome || 'Sistema')
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

    const agora = new Date()
    const updated = unidades.map((u) =>
      u.id === id
        ? {
            ...u,
            ...dados,
            numeroUC,
            atualizadoEm: agora.toLocaleString('pt-BR'),
            atualizadoEmMs: agora.getTime(),
          }
        : u,
    )
    setStore('unidades', updated)
    const unidade = updated.find((u) => u.id === id)
    if (unidade) sincronizarItem('unidades', unidade)
    bumpVersao()
    logar('UC atualizada', `UC ${numeroUC} atualizada`, session?.nome || 'Sistema')
    return { ok: true, unidade }
  }

  const removeUnidade = (id) => {
    const unidades = getStore('unidades').filter((u) => u.id !== id)
    setStore('unidades', unidades)
    sincronizarRemocao('unidades', id)
    bumpVersao()
    logar('UC removida', `UC ID ${id} removida`, session?.nome || 'Sistema')
    return { ok: true }
  }

  // ==================== CRUD Faturas ====================

  const getFaturas = () => getStore('faturas')

  const addFatura = (dados) => {
    const faturas = getStore('faturas')
    const agora = new Date()
    const nova = {
      id: dados?.id || novoId('fat'),
      dataUpload: agora.toLocaleDateString('pt-BR'),
      atualizadoEm: agora.toLocaleString('pt-BR'),
      atualizadoEmMs: agora.getTime(),
      status: 'aguardando revisão',
      ...dados,
    }
    setStore('faturas', [...faturas, nova])
    sincronizarItem('faturas', nova)
    bumpVersao()
    logar(
      'Fatura enviada',
      `Fatura ${nova.arquivo} para ${nova.clienteNome || 'cliente desconhecido'}`,
      session?.nome || 'Sistema',
    )
    return { ok: true, fatura: nova }
  }

  const updateFatura = (id, dados) => {
    const faturas = getStore('faturas')
    const agora = new Date()
    const updated = faturas.map((f) =>
      String(f.id) === String(id)
        ? { ...f, ...dados, atualizadoEm: agora.toLocaleString('pt-BR'), atualizadoEmMs: agora.getTime() }
        : f,
    )
    setStore('faturas', updated)
    const fat = updated.find((f) => String(f.id) === String(id))
    if (fat) sincronizarItem('faturas', fat)
    bumpVersao()
    logar('Fatura atualizada', `Fatura ${fat?.arquivo || id} status: ${dados.status || 'alterado'}`, session?.nome || 'Sistema')
    return { ok: true }
  }

  const removeFatura = (id) => {
    const faturas = getStore('faturas').filter((f) => String(f.id) !== String(id))
    setStore('faturas', faturas)
    sincronizarRemocao('faturas', id)
    bumpVersao()
    logar('Fatura removida', `Fatura ID ${id} removida`, session?.nome || 'Sistema')
    return { ok: true }
  }

  /**
   * Associação MANUAL de uma UC (fatura pendente) a um cliente existente.
   * Grava UC → cliente, vincula as faturas daquela UC, remove o pré-cadastro
   * pendente e publica as faturas na Área do Cliente.
   * Nunca cria cliente novo (regra de negócio).
   *
   * @param {string|number} uc
   * @param {string|number} clienteId
   * @returns {{ok:boolean, message?:string, faturasVinculadas?:number, unidade?:Object}}
   */
  const associarUnidadeCliente = (uc, clienteId) => {
    const clientes = getStore('clientes')
    const cliente = clientes.find((c) => String(c.id) === String(clienteId)) || null
    if (!cliente) {
      return { ok: false, message: 'Cliente não encontrado para associar esta UC.' }
    }

    const resultado = associarUCaCliente({
      unidades: getStore('unidades'),
      faturas: getStore('faturas'),
      preCadastros: getStore('preCadastros'),
      uc,
      cliente,
      usuario: session?.nome || 'Sistema',
    })

    if (!resultado.ok) return resultado

    setStore('unidades', resultado.unidades)
    setStore('faturas', resultado.faturas)
    setStore('preCadastros', resultado.preCadastros)

    // Sincroniza o que mudou (unidade nova e faturas publicadas)
    const idsFaturasVinculadas = resultado.faturas
      .filter((f) => f.associadaManualmente)
      .map((f) => f.id)
    resultado.unidades.forEach((u) => sincronizarItem('unidades', u))
    resultado.faturas
      .filter((f) => idsFaturasVinculadas.includes(f.id))
      .forEach((f) => sincronizarItem('faturas', f))
    sincronizarRemocao('preCadastros', resultado.unidade?.id || uc)
    bumpVersao()

    logar(
      'UC_ASSOCIADA_MANUALMENTE',
      `UC ${uc} associada ao cliente ${cliente.nome} (${resultado.faturasVinculadas} fatura(s))`,
      session?.nome || 'Sistema',
    )

    return {
      ok: true,
      unidade: resultado.unidade,
      faturasVinculadas: resultado.faturasVinculadas,
    }
  }

  /**
   * Faturas visíveis para um cliente (isolamento garantido por UID + UCs).
   * @param {{clienteId?:string, uids?:Array<string>, ucs?:Array<string>}} params
   */
  const getFaturasVisiveisDoCliente = ({ clienteId, uids = [], ucs = [] }) =>
    filtrarFaturasDoCliente({ faturas: getStore('faturas'), clienteId, uids, ucs })

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
  //
  // Cada operação abaixo altera coleções administrativas. Depois de gravar no
  // cache local, sincroniza as coleções afetadas com o Firestore — assim a
  // "fatura pendente de associação" continua existindo após reload/logout e
  // pode ser associada de qualquer navegador.

  const getPreCadastros = () => getStore('preCadastros')

  const identificarClientePorUC = (uc) => buscarClientePorUC(uc)

  const addPreCadastro = (dados, contexto) => {
    const resultado = criarPreCadastroService(dados, contexto)
    if (resultado.ok && resultado.preCadastro) {
      sincronizarItem('preCadastros', resultado.preCadastro)
      bumpVersao()
    }
    return resultado
  }

  const confirmarPreCadastro = (id, dadosEditados, contexto) => {
    const resultado = confirmarPreCadastroService(id, dadosEditados, contexto)
    if (resultado.ok) {
      // O pré-cadastro gerou cliente + unidade e reapontou as faturas
      sincronizarColecao('clientes')
      sincronizarColecao('unidades')
      sincronizarColecao('faturas')
      sincronizarColecao('preCadastros')
      bumpVersao()
    }
    return resultado
  }

  const descartarPreCadastro = (id, contexto) => {
    const resultado = descartarPreCadastroService(id, contexto)
    if (resultado.ok) {
      sincronizarColecao('preCadastros')
      sincronizarColecao('faturas')
      bumpVersao()
    }
    return resultado
  }

  const updatePreCadastro = (id, dados, contexto) => {
    const resultado = atualizarPreCadastroService(id, dados, contexto)
    if (resultado.ok && resultado.preCadastro) {
      sincronizarItem('preCadastros', resultado.preCadastro)
      bumpVersao()
    }
    return resultado
  }

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
    // Espelha no banco central SEM a senha (credenciais vivem no Firebase Auth)
    sincronizarItem('usuarios', usuarioParaBanco(novo))
    logar('Usuário administrativo criado', `${novo.nome} (${novo.perfil})`, session?.nome || 'Sistema')
    return { ok: true }
  }

  const removeUsuario = (id) => {
    if (session?.usuarioId === id) {
      return { ok: false, message: 'Você não pode remover o próprio usuário.' }
    }
    const usuarios = getStore('usuarios')
    const removido = usuarios.find((u) => String(u.id) === String(id))
    setStore('usuarios', usuarios.filter((u) => u.id !== id))
    if (removido) sincronizarRemocao('usuarios', idDocumento('usuarios', removido))
    logar('Usuário administrativo removido', `Usuário ID ${id}`, session?.nome || 'Sistema')
    return { ok: true }
  }

  // ==================== Logs ====================

  const getLogs = () => getStore('logs')

  const value = {
    session,
    authLoading,
    // Estado da sincronização com o banco central (exposto para a UI indicar
    // quando as alterações NÃO estão chegando ao Firestore).
    estadoSync,
    dadosVersao,
    recarregarDadosCompartilhados,
    logar,
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