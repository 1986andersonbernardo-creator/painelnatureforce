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
import {
  loginComEmail,
  logoutFirebase,
  observarAuth,
  entrarComoSessaoAdmin,
  criarContaCliente,
} from '../firebase/auth'
// Autorização administrativa — a MESMA lista usada nas Firestore Security Rules.
import { ehEmailAdmin, podeAdministrar } from '../services/adminAccess'
import {
  getClientePorUid,
  salvarCliente,
  salvarFaturaIdempotente,
  registrarProcessamento,
  atualizarProcessamento,
  criarRevisaoFatura,
  listarDocumentos,
  observarColecao,
  sincronizarColecaoRemota,
  removerDocumento,
  salvarDocumento,
  LIMITE_LOGS,
} from '../firebase/firestore'
import { normalizarReferencia, normalizarVencimento } from '../services/faturaNormalizacao'
import { normalizarUC } from '../services/faturaDedup'
import {
  COLECOES_SINCRONIZADAS,
  associarUCaCliente,
  atualizarIndiceRemoto,
  chaveUnica,
  idDocumento,
  itemParaBanco,
  mesclarColecao,
  normalizarEmail,
  novoId,
  propagarVinculoCliente,
  reconciliarComRemoto,
} from '../services/persistencia'
import {
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

  // Guarda (uid → timestamp) do último login registrado no histórico. Evita
  // registros duplicados do MESMO acesso: `loginCliente` e
  // `onAuthStateChanged` disparam no mesmo fluxo e um reload reautentica.
  const loginsRegistradosRef = useRef({})

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
      // `itemParaBanco` remove credenciais (senha/senhaAcesso) antes de gravar:
      // elas existem apenas no cache local deste navegador.
      const payload = itemParaBanco(colecao, item)
      salvarDocumento(colecao, idDocumento(colecao, payload), payload).then((resultado) => {
        if (resultado.ok) registrarSucessoSync(`${colecao}: ${idDocumento(colecao, payload)}`)
        else registrarFalhaSync(resultado.message, resultado.codigo)
      })
    },
    [podeEscreverCompartilhado, registrarFalhaSync, registrarSucessoSync],
  )

  /**
   * Remove um registro do banco central.
   * Retorna o resultado para que quem chamou possa informar o usuário quando a
   * exclusão NÃO foi aceita — antes a falha era silenciosa e o registro
   * reaparecia na sincronização seguinte.
   * @returns {Promise<{ok:boolean, message?:string, codigo?:string}>}
   */
  const sincronizarRemocao = useCallback(
    (colecao, id) => {
      if (!podeEscreverCompartilhado || !id) return Promise.resolve({ ok: true, ignorado: true })
      return removerDocumento(colecao, id).then((resultado) => {
        if (!resultado.ok) registrarFalhaSync(resultado.message, resultado.codigo)
        return resultado
      })
    },
    [podeEscreverCompartilhado, registrarFalhaSync],
  )

  /**
   * Propaga ao banco central a EXCLUSÃO dos registros que saíram do cache local.
   *
   * `sincronizarColecao` apenas GRAVA: sem esta função, um registro removido
   * localmente (ex.: pré-cadastro confirmado/descartado e suas faturas órfãs)
   * continuava existindo no Firestore e voltava na sincronização seguinte.
   *
   * @param {string} colecao
   * @param {Array} antes Estado da coleção ANTES da operação
   * @param {Array} depois Estado da coleção DEPOIS da operação
   */
  const sincronizarRemocoesPorDiferenca = useCallback(
    (colecao, antes = [], depois = []) => {
      const chavesDepois = new Set(depois.map((item) => chaveUnica(colecao, item)))
      antes
        .filter((item) => !chavesDepois.has(chaveUnica(colecao, item)))
        .forEach((item) => sincronizarRemocao(colecao, idDocumento(colecao, item)))
    },
    [sincronizarRemocao],
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
    [sincronizarItem],
  )

  /**
   * Registra o login do cliente UMA única vez por sessão.
   *
   * Sem isso o histórico recebia "Login do cliente" duas vezes no mesmo acesso
   * (loginCliente + onAuthStateChanged) e novamente a cada recarregamento da
   * página — poluindo a auditoria e gravando no banco sem necessidade.
   * @param {string} uid
   * @param {string} nome
   * @param {boolean} [local] Sessão sem Firebase (fallback offline)
   */
  const registrarLogin = useCallback(
    (uid, nome, local = false) => {
      if (!uid) return
      const agora = Date.now()
      const anterior = loginsRegistradosRef.current[String(uid)]
      if (anterior && agora - anterior < 15000) return
      loginsRegistradosRef.current[String(uid)] = agora
      logar(
        local ? 'Login do cliente (local)' : 'Login do cliente',
        `${nome} acessou o portal`,
        nome,
      )
    },
    [logar],
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
      // `logs` é lido com LIMITE (a coleção cresce continuamente): o que não veio
      // nesta página NÃO foi excluído — por isso não há detecção de remoção.
      // Sem isso, o histórico local seria apagado a cada leitura paginada.
      chavesConhecidas: colecao === 'logs' ? [] : indiceSyncRef.current?.[colecao] || [],
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
      // Nunca espelha senha de acesso (ver itemParaBanco).
      salvarDocumento('clientes', id, itemParaBanco('clientes', cliente)).then((resultado) => {
        if (!resultado.ok) {
          registrarFalhaSync(resultado.message, resultado.codigo)
          return
        }
        registrarSucessoSync(`cliente ${cliente.nome || id}`)

        // Higiene de dados: o cadastro pode ter ficado com DOIS documentos no
        // banco — um com o id local (criado antes do vínculo com o Firebase) e
        // outro com o UID. Sem remover o legado, o painel lia versões
        // diferentes conforme a ordem de retorno do Firestore. A remoção é
        // idempotente (documento inexistente = sucesso) e nunca bloqueia a UI.
        if (cliente.uid && cliente.id && String(cliente.id) !== String(cliente.uid)) {
          removerDocumento('clientes', String(cliente.id)).then(() => {}).catch(() => {})
        }
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
      const resultado = await listarDocumentos(
        colecao,
        // Coleções que crescem continuamente são lidas com limite (paginação
        // simples) — antes o histórico inteiro de logs vinha a cada entrada.
        colecao === 'logs' ? { limite: LIMITE_LOGS } : {},
      )
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
      observarColecao(
        colecao,
        (resultado) => {
          if (!resultado.ok) {
            registrarFalhaSync(resultado.message, resultado.codigo)
            return
          }
          aplicarDadosRemotos(colecao, resultado.data)
          setIndiceSync(indiceSyncRef.current)
          bumpVersao()
        },
        colecao === 'logs' ? { limite: LIMITE_LOGS } : {},
      ),
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
      //
      // A gravação é PULADA quando o vínculo já existe nos dois lados: antes,
      // cada recarregamento de página regravava o cadastro e criava um log —
      // escrita desnecessária no banco e auditoria inflada.
      const jaVinculadoNoBanco = Boolean(
        dadosRemotos && clienteLocal && String(clienteLocal.uid || '') === String(uid),
      )

      if (!jaVinculadoNoBanco) {
        salvarDocumento(
          'clientes',
          uid,
          itemParaBanco('clientes', { ...vinculo.cliente, uid }),
        ).then((resultado) => {
          if (!resultado.ok) registrarFalhaSync(resultado.message, resultado.codigo)
        })

        logar(
          'Vínculo UID',
          `Cliente ${vinculo.cliente.nome || uid} vinculado ao Firebase (${vinculo.propagados} registro(s) propagado(s))`,
          'Sistema',
        )
      }

      return vinculo.cliente
    },
    [bumpVersao, registrarFalhaSync, logar],
  )

  // Observa o estado de autenticação do Firebase
  useEffect(() => {
    const unsubscribe = observarAuth(async (user) => {
      if (user) {
        const uid = user.uid
        const emailUsuario = user.email || ''
        // Recarregar a página restaura a sessão (uid já presente) — isso NÃO é
        // um novo login e não deve gerar registro no histórico.
        const jaEraSessaoDoUsuario = String(sessaoRef.current?.uid || '') === String(uid)

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
        if (!jaEraSessaoDoUsuario) registrarLogin(uid, novaSessao.nome)
      } else {
        // Usuário deslogado no Firebase. Só encerra a sessão se ela DEPENDE do
        // Firebase (uid presente). Sessão puramente local (admin offline) não
        // é derrubada por um evento do Firebase.
        if (sessaoRef.current?.uid) aplicarSessao(null)
      }
      setAuthLoading(false)
    })

    return () => unsubscribe()
  }, [vincularClienteAoUid, aplicarSessao, registrarLogin])

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
      // sincronizarItem remove a senha antes de gravar (ver itemParaBanco).
      sincronizarItem('usuarios', usuarioRegistro)

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
        const espelho = await salvarCliente(
          uid,
          itemParaBanco('clientes', { ...dadosParaEspelhar, uid, ativo: true }),
        )
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
      registrarLogin(uid, novaSessao.nome)
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
      registrarLogin(cliente.id, cliente.nome, true)
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

  /**
   * Remove o cadastro do cliente.
   *
   * O cadastro pode existir em DOIS documentos no banco (id local gerado pelo
   * painel + documento com o UID) — os dois são removidos. Se o banco recusar
   * (ex.: Security Rules antigas sem permissão de delete para o admin), o
   * usuário é AVISADO em vez de acreditar que excluiu.
   * @returns {Promise<{ok:boolean, message?:string}>}
   */
  const removeCliente = async (id) => {
    const clientes = getStore('clientes')
    const cliente = clientes.find((c) => String(c.id) === String(id))
    setStore('clientes', clientes.filter((c) => String(c.id) !== String(id)))

    let falha = null
    if (cliente) {
      const idsParaRemover = new Set([idDocumento('clientes', cliente)])
      if (cliente.id) idsParaRemover.add(String(cliente.id))
      for (const docId of idsParaRemover) {
        const resultado = await sincronizarRemocao('clientes', docId)
        if (!resultado.ok) falha = resultado
      }
    }

    bumpVersao()
    logar('Cliente removido', `Cliente ${cliente?.nome || id} removido`, session?.nome || 'Sistema')

    if (falha) {
      return {
        ok: false,
        message:
          'A exclusão não foi aceita pelo banco central — o cadastro continua sincronizado e pode reaparecer. ' +
          'Publique as Security Rules atualizadas (delete de clientes permitido ao administrador) e tente novamente.',
      }
    }
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

  /**
   * Remove uma unidade consumidora. Aqui o id local É o id do documento no
   * banco, então a remoção remota funciona direto.
   * @returns {Promise<{ok:boolean, message?:string}>}
   */
  const removeUnidade = async (id) => {
    const unidades = getStore('unidades')
    const unidade = unidades.find((u) => String(u.id) === String(id))
    setStore('unidades', unidades.filter((u) => String(u.id) !== String(id)))

    const resultado = await sincronizarRemocao('unidades', id)
    bumpVersao()
    logar('UC removida', `UC ${unidade?.numeroUC || id} removida`, session?.nome || 'Sistema')

    if (!resultado.ok) {
      return {
        ok: false,
        message:
          'A UC foi removida deste navegador, mas o banco central recusou a exclusão. Verifique a conexão e tente novamente.',
      }
    }
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

  /**
   * Remove uma fatura.
   *
   * O registro no cache local usa um id interno, mas o documento no Firestore
   * tem ID DETERMINÍSTICO (`idFatura`, ex.: `fat_ab12cd34`) — a exclusão remota
   * precisa de `idDocumento`. Antes o id interno era enviado ao banco: nada era
   * apagado e a fatura reaparecia na sincronização seguinte.
   * @returns {Promise<{ok:boolean, message?:string}>}
   */
  const removeFatura = async (id) => {
    const faturas = getStore('faturas')
    const fatura = faturas.find((f) => String(f.id) === String(id))
    setStore('faturas', faturas.filter((f) => String(f.id) !== String(id)))

    let falha = null
    if (fatura) {
      const resultado = await sincronizarRemocao('faturas', idDocumento('faturas', fatura))
      if (!resultado.ok) falha = resultado
    }

    bumpVersao()
    logar('Fatura removida', `Fatura ${fatura?.arquivo || id} removida`, session?.nome || 'Sistema')

    if (falha) {
      return {
        ok: false,
        message:
          'A fatura foi removida deste navegador, mas o banco central recusou a exclusão. Verifique a conexão e tente novamente.',
      }
    }
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

    const preCadastrosAntes = getStore('preCadastros')

    const resultado = associarUCaCliente({
      unidades: getStore('unidades'),
      faturas: getStore('faturas'),
      preCadastros: preCadastrosAntes,
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
    // O pré-cadastro daquela UC deixa de existir: a EXCLUSÃO precisa ser
    // propagada ao banco. Antes era enviado o id da UNIDADE/UC e o pré-cadastro
    // reaparecia na sincronização seguinte.
    sincronizarRemocoesPorDiferenca('preCadastros', preCadastrosAntes, resultado.preCadastros)
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
   * Cria a CONTA DE ACESSO do cliente no Firebase Authentication e vincula o
   * UID ao cadastro (propagando para UCs e faturas).
   *
   * Por que existe: o administrador cadastra o cliente com e-mail e senha de
   * acesso, mas a autenticação real acontece no Firebase. Sem esta conta o
   * cliente só conseguia entrar no navegador que tinha o cadastro no cache
   * local (no celular dele o login falhava com "Credenciais inválidas").
   *
   * A conta é criada por uma instância SECUNDÁRIA do Firebase — a sessão do
   * administrador permanece intacta (ver firebase/auth.js).
   *
   * @param {string|number} clienteId
   * @returns {Promise<{ok:boolean, message:string, uid?:string, jaExistia?:boolean}>}
   */
  const provisionarAcessoCliente = async (clienteId) => {
    const clientes = getStore('clientes')
    const cliente = clientes.find((c) => String(c.id) === String(clienteId))
    if (!cliente) return { ok: false, message: 'Cliente não encontrado.' }

    if (cliente.uid) {
      return {
        ok: true,
        jaExistia: true,
        uid: cliente.uid,
        message: 'Este cliente já possui acesso criado.',
      }
    }

    const email = normalizarEmail(cliente.emailAcesso)
    const senha = String(cliente.senhaAcesso || '')
    if (!email || !senha) {
      return {
        ok: false,
        message:
          'Informe o e-mail de acesso e a senha do cliente (Editar) antes de criar o acesso.',
      }
    }

    const conta = await criarContaCliente(email, senha)

    if (!conta.ok && conta.codigo === 'auth/email-already-in-use') {
      // A conta já existe no Firebase (criada no Console ou em outro momento).
      // Sem o SDK Admin não é possível descobrir o UID — orientamos o caminho.
      return {
        ok: false,
        codigo: conta.codigo,
        message:
          'Já existe uma conta com este e-mail no Firebase. O cliente pode entrar com a senha atual; se não lembrar dela, use "Recuperar senha" na tela de login.',
      }
    }
    if (!conta.ok) return { ok: false, codigo: conta.codigo, message: conta.message }

    // Vincula o UID ao cadastro local/banco e propaga para UCs e faturas.
    vincularClienteAoUid(conta.uid, { email })
    updateCliente(clienteId, {
      uid: conta.uid,
      contaFirebase: true,
      acessoCriadoEm: new Date().toLocaleString('pt-BR'),
    })
    logar(
      'Acesso do cliente criado',
      `Conta de acesso criada para ${email}`,
      session?.nome || 'Sistema',
    )

    return {
      ok: true,
      uid: conta.uid,
      message:
        'Acesso criado com sucesso! O cliente já pode entrar com o e-mail e a senha cadastrados.',
    }
  }

  // ==================== Processamento de Faturas (PDF) ====================

  // Processa um PDF de fatura e retorna os dados extraídos e calculados.
  // IMPORTAÇÃO DINÂMICA: o pdf.js (~1,5 MB) só é baixado/carregado no momento
  // em que um administrador importa de fato um PDF — a tela de login e os
  // dashboards não carregam o processador.
  const processarPDF = async (arquivoPDF) => {
    const { processarFatura } = await import('../services/faturaProcessor')
    return await processarFatura(arquivoPDF)
  }

  // Salva uma fatura processada no Firestore de forma IDEMPOTENTE (impede
  // duplicação) — é o único caminho de gravação usado pelo pipeline de PDF.
  const salvarFaturaIdempotenteFirestore = async (dados) => {
    return await salvarFaturaIdempotente(dados)
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

  const addPreCadastro = (dados, contexto) => {
    const resultado = criarPreCadastroService(dados, contexto)
    if (resultado.ok && resultado.preCadastro) {
      sincronizarItem('preCadastros', resultado.preCadastro)
      bumpVersao()
    }
    return resultado
  }

  const confirmarPreCadastro = (id, dadosEditados, contexto) => {
    const antes = {
      faturas: getStore('faturas'),
      preCadastros: getStore('preCadastros'),
    }

    const resultado = confirmarPreCadastroService(id, dadosEditados, contexto)
    if (resultado.ok) {
      // O pré-cadastro gerou cliente + unidade e reapontou as faturas.
      // `sincronizarColecao` GRAVA o estado atual; as EXCLUSÕES (o pré-cadastro
      // confirmado deixa de existir) são propagadas por diferença — sem isso o
      // documento continuava no banco e o pré-cadastro voltava na sincronização.
      sincronizarColecao('clientes')
      sincronizarColecao('unidades')
      sincronizarColecao('faturas')
      sincronizarColecao('preCadastros')
      sincronizarRemocoesPorDiferenca('preCadastros', antes.preCadastros, getStore('preCadastros'))
      sincronizarRemocoesPorDiferenca('faturas', antes.faturas, getStore('faturas'))
      bumpVersao()
    }
    return resultado
  }

  const descartarPreCadastro = (id, contexto) => {
    const antes = {
      faturas: getStore('faturas'),
      preCadastros: getStore('preCadastros'),
    }

    const resultado = descartarPreCadastroService(id, contexto)
    if (resultado.ok) {
      // O descarte remove o pré-cadastro E as faturas órfãs dele: as duas
      // exclusões precisam chegar ao banco central.
      sincronizarColecao('preCadastros')
      sincronizarColecao('faturas')
      sincronizarRemocoesPorDiferenca('preCadastros', antes.preCadastros, getStore('preCadastros'))
      sincronizarRemocoesPorDiferenca('faturas', antes.faturas, getStore('faturas'))
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
    // `sincronizarItem` espelha no banco central SEM a senha (credenciais vivem
    // no Firebase Authentication — ver itemParaBanco).
    sincronizarItem('usuarios', novo)
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
    // Cria a conta de acesso do cliente no Firebase Authentication
    provisionarAcessoCliente,
    getUnidades,
    addUnidade,
    updateUnidade,
    removeUnidade,
    getFaturas,
    addFatura,
    updateFatura,
    removeFatura,
    // Associação manual de uma UC (fatura pendente) a um cliente JÁ cadastrado
    associarUnidadeCliente,
    getUsuarios,
    addUsuario,
    removeUsuario,
    getLogs,
    // Auto-cadastro por fatura
    getPreCadastros,
    addPreCadastro,
    confirmarPreCadastro,
    descartarPreCadastro,
    updatePreCadastro,
    // Processamento de faturas
    processarPDF,
    salvarFaturaIdempotenteFirestore,
    registrarProcessamentoFatura,
    atualizarProcessamentoFatura,
    criarRevisao,
    normalizarRef,
    normalizarVenc,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}