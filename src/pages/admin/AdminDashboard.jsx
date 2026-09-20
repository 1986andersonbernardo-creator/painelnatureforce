import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { salvarArquivo as salvarArquivoDB } from '../../store/db'
import logo from '../../assets/logo.png'
import { calcularHashArquivo, gerarChaveDedupe, encontrarFaturaDuplicada, normalizarUC, montarChaveIdempotencia, gerarIdFatura } from '../../services/faturaDedup'
import { identificarFatura, DECISAO } from '../../services/faturaIdentificacao'
import { STATUS_FATURA, MOTIVO_REVISAO, ROTULO_MOTIVO_REVISAO } from '../../services/faturaStatus'
// Validação por CONTEÚDO (assinatura "%PDF-") — não por MIME.
import { validarArquivoPDF } from '../../services/pdfValidacao'

const formatCurrency = (value) =>
  new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value)

/**
 * Mantém o estado local da seção em sincronia com o cache que recebe as
 * atualizações do BANCO CENTRAL (onSnapshot → dadosVersao).
 *
 * As seções mantêm uma cópia em estado para não travar formulários abertos;
 * esta cópia é atualizada automaticamente sempre que o Firestore entrega dados
 * novos (alteração feita em outro dispositivo) — antes, a seção ficava
 * congelada no valor lido no primeiro render.
 * @param {() => any} ler Leitor do cache local (getStore)
 * @param {any} inicial Valor lido no primeiro render
 * @returns {[any, (v:any) => void, () => void]}
 */
function useDadosSincronizados(ler, inicial) {
  const { dadosVersao } = useAuth()
  const [dados, setDados] = useState(inicial)
  const versaoRef = useRef(dadosVersao)

  useEffect(() => {
    if (versaoRef.current === dadosVersao) return
    versaoRef.current = dadosVersao
    setDados(ler())
  }, [dadosVersao, ler])

  return [dados, setDados, () => setDados(ler())]
}

// Limites de validação de arquivo
const TAMANHO_MAX_PDF_MB = 20
const TAMANHO_MAX_PDF_BYTES = TAMANHO_MAX_PDF_MB * 1024 * 1024

export function AdminDashboard() {
  const { session, logout, getClientes, getFaturas, getUnidades, getUsuarios, getLogs, getPreCadastros, estadoSync, recarregarDadosCompartilhados, dadosVersao } = useAuth()
  const [activeMenu, setActiveMenu] = useState('dashboard')
  const [busca, setBusca] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  const clientes = getClientes()
  const faturas = getFaturas()
  const unidades = getUnidades()
  const usuarios = getUsuarios()
  const preCadastros = getPreCadastros()

  // ==================== Métricas do dashboard ====================
  const clientesAtivos = clientes.filter((c) => c.ativo).length
  const clientesInativos = clientes.length - clientesAtivos
  const faturasPendentes = faturas.filter((f) => f.status === 'aguardando revisão').length
  const faturasDisponiveis = faturas.filter((f) => f.status === 'disponivel').length
  const faturasRequerRevisao = faturas.filter((f) => f.status === 'requer revisão').length
  const faturasComErro = faturas.filter((f) => f.status === 'erro').length
  const faturasProcessadas = faturas.filter((f) => f.calculo && f.calculo.ok).length
  const faturasVinculadas = faturas.filter((f) => f.vinculadaAutomaticamente).length
  const preCadastrosPendentes = preCadastros.filter((p) => p.status === 'PENDING_REVIEW').length
  const consumoTotal = faturas.filter((f) => f.status === 'disponivel').reduce((acc, f) => acc + (f.consumo || 0), 0)
  const economiaGerada = faturas
    .filter((f) => f.status === 'disponivel' && f.calculo)
    .reduce((acc, f) => acc + (f.calculo.valorDesconto || 0), 0)

  // Clientes sem fatura no mês atual
  const mesAtual = new Date().toISOString().slice(0, 7)
  const clientesComFaturaMes = new Set(
    faturas
      .filter((f) => f.referencia === mesAtual && f.status !== 'aguardando revisão')
      .map((f) => f.clienteId),
  )
  const clientesSemFatura = clientes.filter((c) => !clientesComFaturaMes.has(c.id))

  // ==================== Busca global ====================
  const termoBusca = busca.trim().toLowerCase()
  const resultadosBusca = termoBusca
    ? {
        clientes: clientes.filter(
          (c) =>
            c.nome.toLowerCase().includes(termoBusca) ||
            c.cpfCnpj.toLowerCase().includes(termoBusca) ||
            c.email.toLowerCase().includes(termoBusca),
        ),
        faturas: faturas.filter(
          (f) =>
            f.arquivo.toLowerCase().includes(termoBusca) ||
            (f.clienteNome || '').toLowerCase().includes(termoBusca) ||
            (f.uc || '').toLowerCase().includes(termoBusca),
        ),
      }
    : null

  // ==================== Menu ====================
  const menuItems = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'clientes', label: 'Clientes' },
    { id: 'faturas', label: 'Faturas' },
    { id: 'precadastros', label: `Pré-cadastros${preCadastrosPendentes > 0 ? ` (${preCadastrosPendentes})` : ''}` },
    { id: 'revisoes', label: 'Revisões' },
    { id: 'usuarios', label: 'Usuários' },
    { id: 'logs', label: 'Logs' },
    { id: 'relatorios', label: 'Relatórios' },
  ]

  const renderContent = () => {
    /* ============================ DASHBOARD ============================ */
    if (activeMenu === 'dashboard') {
      return (
        <>
          <section className="panel highlight-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Visão geral</span>
                <h2>Painel administrativo</h2>
              </div>
              <span className="status-pill success">
                {session.perfil === 'administrador' ? 'Administrador' : 'Operador'}
              </span>
            </div>

            <div className="stats-grid">
              <article className="stat-card primary">
                <span>Total de clientes</span>
                <strong>{clientes.length}</strong>
                <small>{clientesAtivos} ativos · {clientesInativos} inativos</small>
              </article>
              <article className="stat-card success">
                <span>Faturas processadas</span>
                <strong>{faturasProcessadas}</strong>
                <small>{faturasDisponiveis} disponíveis p/ clientes</small>
              </article>
              <article className="stat-card warning">
                <span>Faturas pendentes</span>
                <strong>{faturasPendentes}</strong>
                <small>Aguardando revisão</small>
              </article>
              <article className="stat-card accent">
                <span>Consumo total</span>
                <strong>{consumoTotal} kWh</strong>
                <small>Faturas disponíveis</small>
              </article>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header compact">
              <div>
                <span className="eyebrow">Resumo financeiro</span>
                <h3>Indicadores</h3>
              </div>
            </div>
            <div className="summary-grid">
              <div className="summary-card">
                <span>Economia gerada (20%)</span>
                <strong>{formatCurrency(economiaGerada)}</strong>
              </div>
              <div className="summary-card">
                <span>Unidades consumidoras</span>
                <strong>{unidades.length}</strong>
              </div>
              <div className="summary-card">
                <span>Usuários administrativos</span>
                <strong>{usuarios.length}</strong>
              </div>
              <div className="summary-card">
                <span>Faturas vinculadas automaticamente</span>
                <strong>{faturasVinculadas}</strong>
              </div>
            </div>
          </section>

          {/* Alertas */}
          <section className="panel">
            <div className="panel-header compact">
              <div>
                <span className="eyebrow">🔔 Central de alertas</span>
                <h3>Pendências e atenção</h3>
              </div>
            </div>

            <div className="support-list">
              {preCadastrosPendentes > 0 && (
                <div className="support-card">
                  <div>
                    <strong>{preCadastrosPendentes} novo(s) cliente(s) identificado(s) por fatura</strong>
                    <small>Aguardando revisão e confirmação do cadastro</small>
                  </div>
                  <button
                    type="button"
                    className="tag tag-warning"
                    onClick={() => setActiveMenu('precadastros')}
                    style={{ border: 'none', cursor: 'pointer' }}
                  >
                    Revisar
                  </button>
                </div>
              )}
              {clientesSemFatura.length > 0 && (
                <div className="support-card">
                  <div>
                    <strong>{clientesSemFatura.length} cliente(s) sem fatura no mês atual</strong>
                    <small>{clientesSemFatura.map((c) => c.nome).join(', ')}</small>
                  </div>
                  <button
                    type="button"
                    className="tag tag-warning"
                    onClick={() => setActiveMenu('faturas')}
                    style={{ border: 'none', cursor: 'pointer' }}
                  >
                    Enviar faturas
                  </button>
                </div>
              )}
              {faturasPendentes > 0 && (
                <div className="support-card">
                  <div>
                    <strong>{faturasPendentes} fatura(s) aguardando revisão</strong>
                    <small>Vinculadas a cliente mas não publicadas</small>
                  </div>
                  <button
                    type="button"
                    className="tag tag-warning"
                    onClick={() => setActiveMenu('faturas')}
                    style={{ border: 'none', cursor: 'pointer' }}
                  >
                    Revisar
                  </button>
                </div>
              )}
              {faturasRequerRevisao > 0 && (
                <div className="support-card">
                  <div>
                    <strong>{faturasRequerRevisao} fatura(s) requerem revisão</strong>
                    <small>Componentes não identificados com segurança</small>
                  </div>
                  <button
                    type="button"
                    className="tag tag-error"
                    onClick={() => setActiveMenu('revisoes')}
                    style={{ border: 'none', cursor: 'pointer' }}
                  >
                    Analisar
                  </button>
                </div>
              )}
              {faturasComErro > 0 && (
                <div className="support-card">
                  <div>
                    <strong>{faturasComErro} fatura(s) com erro</strong>
                    <small>Falha no processamento do PDF</small>
                  </div>
                  <button
                    type="button"
                    className="tag tag-error"
                    onClick={() => setActiveMenu('faturas')}
                    style={{ border: 'none', cursor: 'pointer' }}
                  >
                    Ver erros
                  </button>
                </div>
              )}
              {preCadastrosPendentes === 0 && clientesSemFatura.length === 0 && faturasPendentes === 0 && faturasRequerRevisao === 0 && faturasComErro === 0 && (
                <div className="support-card">
                  <div>
                    <strong>Tudo em dia ✅</strong>
                    <small>Nenhuma pendência identificada.</small>
                  </div>
                </div>
              )}
            </div>
          </section>
        </>
      )
    }

    /* ============================ CLIENTES ============================ */
    if (activeMenu === 'clientes') {
      return <ClientesSection />
    }

    /* ============================ FATURAS ============================ */
    if (activeMenu === 'faturas') {
      return <FaturasSection />
    }

    /* ============================ PRÉ-CADASTROS ============================ */
    if (activeMenu === 'precadastros') {
      return <PreCadastrosSection />
    }

    /* ============================ REVISÕES ============================ */
    if (activeMenu === 'revisoes') {
      return <RevisoesSection />
    }

    /* ============================ USUÁRIOS ============================ */
    if (activeMenu === 'usuarios') {
      return <UsuariosSection />
    }

    /* ============================ LOGS ============================ */
    if (activeMenu === 'logs') {
      return <LogsSection />
    }

    /* ============================ RELATÓRIOS ============================ */
    if (activeMenu === 'relatorios') {
      return <RelatoriosSection />
    }

    return null
  }

  return (
    <div className="app-shell admin-shell">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand-block sidebar-brand">
          <img src={logo} alt="Nature Force" className="brand-mark" />
          <div>
            <strong>Nature Force</strong>
            <small>Administração</small>
          </div>
        </div>

        <nav className="nav-menu">
          {menuItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === activeMenu ? 'nav-item active' : 'nav-item'}
              onClick={() => {
                setActiveMenu(item.id)
                setMenuOpen(false)
              }}
            >
              {item.label}
            </button>
          ))}

          <button type="button" className="nav-item logout-item" onClick={logout}>
            Sair
          </button>
        </nav>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <button type="button" className="menu-toggle" onClick={() => setMenuOpen((state) => !state)}>
            ☰
          </button>

          <div className="topbar-copy">
            <span className="eyebrow">Bem-vindo, {session?.perfil === 'administrador' ? 'Administrador' : 'Operador'}</span>
            <h2>{menuItems.find((m) => m.id === activeMenu)?.label}</h2>
          </div>

          <button type="button" className="ghost-button" onClick={logout}>
            Sair
          </button>
        </header>

        {/* Busca global */}
        <div style={{ marginBottom: '16px' }}>
          <input
            type="search"
            placeholder="🔎 Buscar por cliente, CPF, fatura, UC..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            style={{ width: '100%', padding: '10px 14px', borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '14px' }}
          />
          {resultadosBusca && (
            <div className="panel" style={{ marginTop: '8px', padding: '12px' }}>
              <strong>
                {resultadosBusca.clientes.length + resultadosBusca.faturas.length} resultado(s) para "{busca}"
              </strong>
              {resultadosBusca.clientes.map((c) => (
                <div key={c.id} style={{ padding: '8px 0', borderBottom: '1px solid #f1f5f9' }}>
                  <Link to="#" onClick={() => setActiveMenu('clientes')} style={{ fontWeight: 600, color: '#0f172a' }}>
                    {c.nome}
                  </Link>
                  <small style={{ color: '#64748b', marginLeft: '8px' }}>{c.cpfCnpj} · {c.email}</small>
                </div>
              ))}
              {resultadosBusca.faturas.map((f) => (
                <div key={f.id} style={{ padding: '8px 0', borderBottom: '1px solid #f1f5f9' }}>
                  <strong>{f.arquivo}</strong>
                  <small style={{ color: '#64748b', marginLeft: '8px' }}>
                    {f.clienteNome} · UC {f.uc} · {f.referencia}
                  </small>
                </div>
              ))}
              {resultadosBusca.clientes.length + resultadosBusca.faturas.length === 0 && (
                <small style={{ color: '#64748b' }}>Nenhum resultado encontrado.</small>
              )}
            </div>
          )}
        </div>

        {/* ==================== Estado da sincronização com o BANCO CENTRAL ==================== */}
        {/* Avisa explicitamente quando as alterações NÃO estão chegando ao
            Firestore — sem isso o administrador acha que salvou e o dado fica
            preso no cache local deste navegador (celular ≠ computador). */}
        {(estadoSync.erro || estadoSync.modo !== 'firestore' || estadoSync.sincronizando) && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '8px 16px',
              padding: '10px 14px',
              marginBottom: '16px',
              borderRadius: '10px',
              background: estadoSync.erro ? '#fef2f2' : '#f0fdf4',
              border: `1px solid ${estadoSync.erro ? '#fecaca' : '#bbf7d0'}`,
            }}
          >
            <span
              className={`status-pill ${estadoSync.erro ? 'error' : 'success'}`}
              style={{ background: 'transparent', border: 'none' }}
            >
              {estadoSync.erro
                ? '⚠ Sem sincronização com o banco central'
                : estadoSync.sincronizando
                  ? 'Sincronizando com o banco central...'
                  : '✓ Sincronizado com o banco central'}
            </span>
            {estadoSync.erro && (
              <small style={{ color: '#b91c1c', flex: 1, minWidth: '220px' }}>{estadoSync.erro}</small>
            )}
            <button
              type="button"
              className="ghost-button"
              onClick={() => recarregarDadosCompartilhados()}
              disabled={estadoSync.sincronizando}
            >
              Sincronizar agora
            </button>
          </div>
        )}

        {renderContent()}
      </main>
    </div>
  )
}

/* ======================== SEÇÃO CLIENTES ======================== */
function ClientesSection() {
  const {
    getClientes,
    addCliente,
    updateCliente,
    toggleClienteAtivo,
    removeCliente,
    getUnidades,
    getFaturas,
    addUnidade,
    updateUnidade,
    removeUnidade,
  } = useAuth()
  const [clientes, setClientes] = useDadosSincronizados(getClientes, getClientes())
  const [showForm, setShowForm] = useState(false)
  const [editandoId, setEditandoId] = useState(null)
  const [mensagem, setMensagem] = useState('')
  // UCs do cliente em edição (carregadas no form; persistidas no submit)
  const [formUcs, setFormUcs] = useState([])
  // UCs originais carregadas (para detectar remoções)
  const [origUcs, setOrigUcs] = useState([])
  // UC em edição dentro do form (novo ou existente)
  const [ucEditando, setUcEditando] = useState(null)
  const [showUcForm, setShowUcForm] = useState(false)
  const [ucMsg, setUcMsg] = useState('')
  const [ucForm, setUcForm] = useState({
    numeroUC: '',
    codigoInstalacao: '',
    distribuidora: '',
    titularNome: '',
    titularCpfCnpj: '',
    endereco: '',
    numero: '',
    complemento: '',
    bairro: '',
    cidade: '',
    estado: '',
    cep: '',
    numeroMedidor: '',
    status: 'ativo',
  })
  const [form, setForm] = useState({
    nome: '',
    cpfCnpj: '',
    telefone: '',
    email: '',
    endereco: '',
    cidade: '',
    estado: '',
    cep: '',
    whatsapp: '',
    emailAcesso: '',
    senhaAcesso: '',
  })

  const unidades = getUnidades()
  const faturas = getFaturas()

  const refresh = () => setClientes(getClientes())

  const handleSubmit = (e) => {
    e.preventDefault()
    const result = editandoId
      ? updateCliente(editandoId, form)
      : addCliente(form)

    if (result.ok) {
      // Persiste as UCs associadas ao cliente
      const clienteId = editandoId || result.cliente?.id
      let erroUc = ''
      if (clienteId) {
        formUcs.forEach((uc) => {
          const payload = { ...uc, clienteId }
          // Remove flags internas de origem antes de salvar
          delete payload._origId
          delete payload._novo
          delete payload._tempId
          const res = uc._origId ? updateUnidade(uc._origId, payload) : addUnidade(payload)
          if (!res.ok) erroUc = erroUc || res.message
        })
        // Remove UCs que existiam e foram excluídas no form
        origUcs.forEach((uc) => {
          const aindaExiste = formUcs.some((f) => f._origId === uc.id)
          if (!aindaExiste) removeUnidade(uc.id)
        })
      }
      setMensagem(
        (editandoId ? 'Cliente atualizado com sucesso!' : 'Cliente cadastrado com sucesso!') +
          (erroUc ? ` (UC: ${erroUc})` : ''),
      )
      setShowForm(false)
      setEditandoId(null)
      setFormUcs([])
      setOrigUcs([])
      setUcEditando(null)
      setShowUcForm(false)
      setUcMsg('')
      setForm({
        nome: '',
        cpfCnpj: '',
        telefone: '',
        email: '',
        endereco: '',
        cidade: '',
        estado: '',
        cep: '',
        whatsapp: '',
        emailAcesso: '',
        senhaAcesso: '',
      })
      refresh()
      setTimeout(() => setMensagem(''), 3000)
    } else {
      setMensagem(result.message)
      setTimeout(() => setMensagem(''), 3000)
    }
  }

  const handleEdit = (cliente) => {
    setEditandoId(cliente.id)
    const clienteUcs = getUnidades()
      .filter((u) => String(u.clienteId) === String(cliente.id))
      .map((u) => ({ ...u, _origId: u.id }))
    setFormUcs(clienteUcs)
    setOrigUcs(clienteUcs.map((u) => ({ ...u })))
    setForm({
      nome: cliente.nome,
      cpfCnpj: cliente.cpfCnpj,
      telefone: cliente.telefone || '',
      email: cliente.email || '',
      endereco: cliente.endereco || '',
      cidade: cliente.cidade || '',
      estado: cliente.estado || '',
      cep: cliente.cep || '',
      whatsapp: cliente.whatsapp || '',
      emailAcesso: cliente.emailAcesso || '',
      senhaAcesso: cliente.senhaAcesso || '',
    })
    setShowForm(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Manipuladores das UCs no formulário
  const iniciarNovaUc = () => {
    setUcForm({
      numeroUC: '', codigoInstalacao: '', distribuidora: '', titularNome: '',
      titularCpfCnpj: '', endereco: '', numero: '', complemento: '', bairro: '',
      cidade: '', estado: '', cep: '', numeroMedidor: '', status: 'ativo',
    })
    setUcEditando(null)
    setUcMsg('')
    setShowUcForm(true)
  }

  const editarUc = (uc) => {
    setUcForm(uc)
    setUcEditando(uc)
    setUcMsg('')
    setShowUcForm(true)
  }

  const salvarUcNoForm = (e) => {
    e.preventDefault()
    const numeroUC = String(ucForm.numeroUC || '').replace(/\D/g, '')
    if (!numeroUC) {
      setUcMsg('O número da UC é obrigatório.')
      return
    }
    // Impede UC duplicada dentro do próprio formulário
    const duplicada = formUcs.some(
      (uc) => uc._origId !== ucEditando?._origId &&
        String(uc.numeroUC).replace(/\D/g, '') === numeroUC,
    )
    if (duplicada) {
      setUcMsg(`Já existe uma UC com o número ${numeroUC} nesta lista.`)
      return
    }

    const payload = { ...ucForm, numeroUC }
    if (ucEditando) {
      const origem = ucEditando._origId
      setFormUcs((prev) =>
        prev.map((uc) =>
          uc._origId === origem ? { ...payload, _origId: origem } : uc,
        ),
      )
    } else {
      setFormUcs((prev) => [...prev, { ...payload, _novo: true, _tempId: Date.now() + Math.random() }])
    }
    setUcMsg('')
    setShowUcForm(false)
    setUcEditando(null)
  }

  const removerUcDoForm = (uc) => {
    if (window.confirm(`Remover a UC ${uc.numeroUC}?`)) {
      if (uc._origId) {
        setFormUcs((prev) => prev.filter((x) => x._origId !== uc._origId))
      } else {
        setFormUcs((prev) => prev.filter((x) => x._tempId !== uc._tempId))
      }
    }
  }

  return (
    <section className="panel">
      <div className="panel-header compact">
        <div>
          <span className="eyebrow">Gestão de clientes</span>
          <h3>Clientes Nature Force ({clientes.length})</h3>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            setShowForm((s) => !s)
            setEditandoId(null)
            setFormUcs([])
            setOrigUcs([])
            setUcEditando(null)
            setShowUcForm(false)
            setUcMsg('')
            setForm({ nome: '', cpfCnpj: '', telefone: '', email: '', endereco: '', cidade: '', estado: '', cep: '', whatsapp: '', emailAcesso: '', senhaAcesso: '' })
          }}
        >
          {showForm && !editandoId ? 'Fechar formulário' : '+ Novo cliente'}
        </button>
      </div>

      {mensagem && (
        <p style={{ padding: '10px', background: '#f0fdf4', color: '#166534', borderRadius: '8px', marginBottom: '12px' }}>
          {mensagem}
        </p>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} style={{ background: '#f8fafc', padding: '16px', borderRadius: '12px', marginBottom: '20px' }}>
          <div className="profile-grid">
            <div className="field">
              <span>Nome completo *</span>
              <input type="text" required value={form.nome} placeholder="Nome do cliente" onChange={(e) => setForm((f) => ({ ...f, nome: e.target.value }))} />
            </div>
            <div className="field">
              <span>CPF/CNPJ *</span>
              <input type="text" required value={form.cpfCnpj} placeholder="000.000.000-00" onChange={(e) => setForm((f) => ({ ...f, cpfCnpj: e.target.value }))} />
            </div>
            <div className="field">
              <span>Telefone</span>
              <input type="text" value={form.telefone} placeholder="(81) 9 9999-9999" onChange={(e) => setForm((f) => ({ ...f, telefone: e.target.value }))} />
            </div>
            <div className="field">
              <span>E-mail</span>
              <input type="email" value={form.email} placeholder="cliente@exemplo.com" onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div className="field">
              <span>Endereço</span>
              <input type="text" value={form.endereco} placeholder="Rua ex, 123" onChange={(e) => setForm((f) => ({ ...f, endereco: e.target.value }))} />
            </div>
            <div className="field">
              <span>Cidade</span>
              <input type="text" value={form.cidade} placeholder="Recife" onChange={(e) => setForm((f) => ({ ...f, cidade: e.target.value }))} />
            </div>
            <div className="field">
              <span>Estado</span>
              <input type="text" value={form.estado} placeholder="PE" onChange={(e) => setForm((f) => ({ ...f, estado: e.target.value }))} />
            </div>
            <div className="field">
              <span>CEP</span>
              <input type="text" value={form.cep} placeholder="50000-000" onChange={(e) => setForm((f) => ({ ...f, cep: e.target.value }))} />
            </div>
            <div className="field">
              <span>WhatsApp</span>
              <input type="text" value={form.whatsapp} placeholder="81 9 9999-9999" onChange={(e) => setForm((f) => ({ ...f, whatsapp: e.target.value }))} />
            </div>
            <div className="field">
              <span>E-mail de acesso (login) *</span>
              <input type="email" required value={form.emailAcesso} placeholder="email@acesso.com" onChange={(e) => setForm((f) => ({ ...f, emailAcesso: e.target.value }))} />
            </div>
            <div className="field">
              <span>Senha de acesso *</span>
              <input type="text" required value={form.senhaAcesso} placeholder="senha do cliente" onChange={(e) => setForm((f) => ({ ...f, senhaAcesso: e.target.value }))} />
            </div>
          </div>
          {/* ==================== UNIDADES CONSUMIDORAS ==================== */}
          <div style={{ marginTop: '16px', padding: '14px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div>
                <strong>Unidades Consumidoras</strong>
                <small style={{ display: 'block', color: '#64748b' }}>
                  A UC é o principal identificador das faturas. O titular da conta pode diferir do cliente Nature Force.
                </small>
              </div>
              <button type="button" className="primary-button" onClick={iniciarNovaUc}>
                + Adicionar Unidade Consumidora
              </button>
            </div>

            {ucMsg && (
              <p style={{ padding: '8px', background: '#fef2f2', color: '#dc2626', borderRadius: '8px', margin: '10px 0 0' }}>
                {ucMsg}
              </p>
            )}

            {showUcForm && (
              <form onSubmit={salvarUcNoForm} style={{ background: '#f8fafc', padding: '12px', borderRadius: '10px', marginTop: '12px' }}>
                <div className="profile-grid">
                  <div className="field">
                    <span>Número da UC *</span>
                    <input type="text" required value={ucForm.numeroUC} placeholder="123456789" onChange={(e) => setUcForm((f) => ({ ...f, numeroUC: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span>Código da instalação</span>
                    <input type="text" value={ucForm.codigoInstalacao} onChange={(e) => setUcForm((f) => ({ ...f, codigoInstalacao: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span>Distribuidora</span>
                    <input type="text" value={ucForm.distribuidora} placeholder="Neoenergia" onChange={(e) => setUcForm((f) => ({ ...f, distribuidora: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span>Titular da conta</span>
                    <input type="text" value={ucForm.titularNome} placeholder="Nome do titular (pode ≠ cliente)" onChange={(e) => setUcForm((f) => ({ ...f, titularNome: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span>CPF/CNPJ do titular</span>
                    <input type="text" value={ucForm.titularCpfCnpj} onChange={(e) => setUcForm((f) => ({ ...f, titularCpfCnpj: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span>Endereço</span>
                    <input type="text" value={ucForm.endereco} onChange={(e) => setUcForm((f) => ({ ...f, endereco: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span>Número</span>
                    <input type="text" value={ucForm.numero} onChange={(e) => setUcForm((f) => ({ ...f, numero: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span>Complemento</span>
                    <input type="text" value={ucForm.complemento} onChange={(e) => setUcForm((f) => ({ ...f, complemento: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span>Bairro</span>
                    <input type="text" value={ucForm.bairro} onChange={(e) => setUcForm((f) => ({ ...f, bairro: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span>Cidade</span>
                    <input type="text" value={ucForm.cidade} onChange={(e) => setUcForm((f) => ({ ...f, cidade: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span>Estado</span>
                    <input type="text" value={ucForm.estado} onChange={(e) => setUcForm((f) => ({ ...f, estado: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span>CEP</span>
                    <input type="text" value={ucForm.cep} onChange={(e) => setUcForm((f) => ({ ...f, cep: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span>Número do medidor</span>
                    <input type="text" value={ucForm.numeroMedidor} onChange={(e) => setUcForm((f) => ({ ...f, numeroMedidor: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span>Status</span>
                    <select value={ucForm.status} onChange={(e) => setUcForm((f) => ({ ...f, status: e.target.value }))}>
                      <option value="ativo">Ativo</option>
                      <option value="inativo">Inativo</option>
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                  <button type="submit" className="primary-button">
                    {ucEditando ? 'Salvar UC' : 'Adicionar UC'}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => { setShowUcForm(false); setUcEditando(null); setUcMsg(''); }}>
                    Cancelar
                  </button>
                </div>
              </form>
            )}

            {formUcs.length === 0 ? (
              <p style={{ color: '#94a3b8', marginTop: '10px' }}>Nenhuma unidade consumidora cadastrada.</p>
            ) : (
              <div style={{ marginTop: '12px', display: 'grid', gap: '8px' }}>
                {formUcs.map((uc, idx) => (
                  <div key={uc._origId || `new-${idx}`} className="invoice-item" style={{ padding: '10px 12px', background: '#f8fafc', borderRadius: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                      <div>
                        <strong>UC {uc.numeroUC}</strong>
                        <span className={uc.status === 'ativo' ? 'tag tag-success' : 'tag tag-error'} style={{ marginLeft: '6px' }}>
                          {uc.status === 'ativo' ? 'Ativo' : 'Inativo'}
                        </span>
                        {uc._origId && <span className="tag tag-success" style={{ marginLeft: '6px' }}>salva</span>}
                        {uc._novo && <span className="tag tag-warning" style={{ marginLeft: '6px' }}>nova</span>}
                        <small style={{ display: 'block', color: '#475569' }}>
                          Titular: {uc.titularNome || '—'} · {uc.titularCpfCnpj || ''}
                        </small>
                        <small style={{ display: 'block', color: '#64748b' }}>
                          {uc.endereco || '—'}
                          {uc.numero ? `, ${uc.numero}` : ''}
                          {uc.complemento ? ` (${uc.complemento})` : ''}
                          {uc.bairro ? ` · ${uc.bairro}` : ''}
                          {uc.cidade ? ` · ${uc.cidade}` : ''}
                          {uc.cep ? ` · ${uc.cep}` : ''}
                        </small>
                        {uc.numeroMedidor && (
                          <small style={{ display: 'block', color: '#64748b' }}>Medidor: {uc.numeroMedidor}</small>
                        )}
                      </div>
                      <div className="invoice-actions" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <button type="button" onClick={() => editarUc(uc)}>Editar</button>
                        <button type="button" onClick={() => removerUcDoForm(uc)}>Remover</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button type="submit" className="primary-button" style={{ marginTop: '12px' }}>
            {editandoId ? 'Salvar alterações' : 'Cadastrar cliente'}
          </button>
        </form>
      )}

      <div style={{ maxHeight: '600px', overflowY: 'auto' }}>
        {clientes.map((cliente) => {
          const clienteFaturas = faturas.filter((f) => f.clienteId === cliente.id)
          const clienteUnidades = unidades.filter((u) => u.clienteId === cliente.id)
          return (
            <div key={cliente.id} className="invoice-item" style={{ marginBottom: '12px', padding: '12px', background: '#f8fafc', borderRadius: '12px' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 24px' }}>
                <div>
                  <strong>{cliente.nome}</strong>
                  {cliente.ativo ? (
                    <span className="tag tag-success">Ativo</span>
                  ) : (
                    <span className="tag tag-error">Inativo</span>
                  )}
                  {cliente.source === 'PDF_IMPORT' && <span className="tag tag-neutral">Via PDF</span>}
                  <small style={{ display: 'block', color: '#64748b' }}>
                    CPF: {cliente.cpfCnpj} · Tel: {cliente.telefone || '—'} · E-mail: {cliente.email || '—'}
                  </small>
                  <small style={{ display: 'block', color: '#64748b' }}>
                    Acesso: {cliente.emailAcesso || '—'} · {clienteUnidades.length} UC(s) · {clienteFaturas.length} fatura(s)
                  </small>
                </div>
                <div className="invoice-actions" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => handleEdit(cliente)}>Editar</button>
                  <button type="button" onClick={() => { toggleClienteAtivo(cliente.id); refresh(); }}>
                    {cliente.ativo ? 'Desativar' : 'Ativar'}
                  </button>
                  <button type="button" onClick={() => { if (window.confirm(`Remover cliente ${cliente.nome}?`)) { removeCliente(cliente.id); refresh(); } }}>
                    Remover
                  </button>
                </div>
              </div>

              {clienteUnidades.length > 0 && (
                <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #e2e8f0' }}>
                  {clienteUnidades.map((uc) => (
                    <small key={uc.id} style={{ display: 'inline-block', marginRight: '16px', color: '#475569' }}>
                      ⚡ UC: {uc.numeroUC} · Instalação: {uc.codigoInstalacao || '—'}
                    </small>
                  ))}
                </div>
              )}

              {clienteFaturas.length > 0 && (
                <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #e2e8f0' }}>
                  {clienteFaturas.slice(0, 3).map((fat) => (
                    <small key={fat.id} style={{ display: 'inline-block', marginRight: '16px', color: '#475569' }}>
                      📄 {fat.referencia} · {fat.status}
                    </small>
                  ))}
                  {clienteFaturas.length > 3 && (
                    <small style={{ color: '#64748b' }}>+{clienteFaturas.length - 3} outras...</small>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/* ======================== SEÇÃO FATURAS (pipeline de importação) ======================== */
function FaturasSection() {
  const {
    getFaturas,
    addFatura,
    updateFatura,
    removeFatura,
    getClientes,
    getUnidades,
    processarPDF,
    salvarFaturaIdempotenteFirestore,
    registrarProcessamentoFatura,
    atualizarProcessamentoFatura,
    criarRevisao,
    normalizarRef,
    normalizarVenc,
    addPreCadastro,
    session,
    logar,
  } = useAuth()

  const [faturas, setFaturas] = useDadosSincronizados(getFaturas, getFaturas())
  const [mensagem, setMensagem] = useState('')
  const [mensagemErro, setMensagemErro] = useState('')
  const [processando, setProcessando] = useState(false)
  // Fila de progresso em tempo real (um item por arquivo)
  const [fila, setFila] = useState([])

  const refresh = () => setFaturas(getFaturas())

  // Garante que o estado "processando" seja resetado ao desmontar o componente
  useEffect(() => {
    return () => setProcessando(false)
  }, [])

  // Status da fila conforme o motivo da revisão (a UC pode ter sido lida
  // corretamente e simplesmente não estar cadastrada — é diferente de
  // "UC não identificada no PDF").
  const statusPorMotivo = {
    [MOTIVO_REVISAO.UC_NAO_ENCONTRADA]: 'UC_NAO_CADASTRADA',
    [MOTIVO_REVISAO.UC_SEM_CLIENTE]: 'UC_SEM_CLIENTE',
    [MOTIVO_REVISAO.MULTIPLAS_UCS]: 'MULTIPLAS_UCS',
    [MOTIVO_REVISAO.CLIENTE_INCOMPATIVEL]: 'CLIENTE_INCOMPATIVEL',
    [MOTIVO_REVISAO.UC_AUSENTE_NO_PDF]: 'UC_NAO_IDENTIFICADA',
    [MOTIVO_REVISAO.SEM_DADOS_IDENTIFICACAO]: 'UC_NAO_IDENTIFICADA',
  }

  /**
   * Explica em linguagem clara por que a fatura foi para revisão manual.
   * @param {string} motivo - MOTIVO_REVISAO
   * @param {string} uc - UC lida do PDF (quando houver)
   * @returns {string}
   */
  const explicacaoMotivo = (motivo, uc) => {
    switch (motivo) {
      case MOTIVO_REVISAO.UC_NAO_ENCONTRADA:
        return `UC ${uc || '—'} lida no PDF, mas não cadastrada no sistema. Cadastre a unidade para vincular a fatura.`
      case MOTIVO_REVISAO.UC_AUSENTE_NO_PDF:
        return 'O número da UC não foi localizado no texto do PDF. Se o arquivo for digitalizado (imagem), não há texto extraível — envie o PDF original da distribuidora.'
      case MOTIVO_REVISAO.MULTIPLAS_UCS:
        return `Mais de uma unidade cadastrada corresponde à UC ${uc || '—'}. Confirme manualmente qual é a correta.`
      case MOTIVO_REVISAO.UC_SEM_CLIENTE:
        return `A UC ${uc || '—'} existe, mas não tem cliente vinculado. Vincule um cliente para liberar a fatura.`
      case MOTIVO_REVISAO.CLIENTE_INCOMPATIVEL:
        return `Os dados do titular (CPF/CNPJ) não conferem com a UC ${uc || '—'}. Confirme manualmente antes de vincular.`
      case MOTIVO_REVISAO.SEM_DADOS_IDENTIFICACAO:
        return 'Nenhum dado de identificação (UC, titular, medidor ou endereço) foi encontrado no texto do PDF.'
      default:
        return 'Identificação pendente de conferência manual.'
    }
  }

  // Helper: aplica timeout em promises que podem ficar pendentes (ex: Firestore sem permissão)
  const comTimeout = (promise, ms = 8000, mensagem = 'Operação demorou demais.') =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(mensagem)), ms)),
    ])

  // Atualiza um item da fila de progresso
  const atualizarItem = (key, patch) => {
    setFila((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }
  const adicionarPasso = (key, passo) => {
    setFila((prev) =>
      prev.map((item) => (item.key === key ? { ...item, passos: [...item.passos, passo] } : item)),
    )
  }

  const handleUpload = async (files) => {
    const lista = Array.from(files)
    if (lista.length === 0) return

    setProcessando(true)
    setMensagem('')
    setMensagemErro('')

    // Cria itens na fila
    const itens = lista.map((file) => ({
      key: `${file.name}-${Date.now()}-${Math.random()}`,
      arquivo: file.name,
      status: 'PROCESSANDO',
      uc: null,
      cliente: null,
      passos: ['✓ Arquivo recebido'],
    }))
    setFila((prev) => [...itens, ...prev])

    for (let idx = 0; idx < lista.length; idx++) {
      const file = lista[idx]
      const item = itens[idx]
      const { key } = item

      try {
        // ===== 1. Validação do arquivo (por CONTEÚDO, não por MIME) =====
        // `file.type` é não confiável: vem vazio, 'application/octet-stream'
        // ou MIME errado em vários navegadores/SO — e um .txt renomeado para
        // .pdf passa com type 'application/pdf'. A assinatura "%PDF-" resolve.
        const validacaoArquivo = await validarArquivoPDF(file)
        if (!validacaoArquivo.ok) {
          atualizarItem(key, { status: 'ERRO', erro: validacaoArquivo.mensagem })
          logar(
            'ARQUIVO_INVALIDO',
            `${file.name} (${validacaoArquivo.codigo}): ${validacaoArquivo.mensagem}`,
            session?.nome || 'Sistema',
          )
          continue
        }
        if (file.size > TAMANHO_MAX_PDF_BYTES) {
          atualizarItem(key, {
            status: 'ERRO',
            erro: `Arquivo maior que ${TAMANHO_MAX_PDF_MB}MB.`,
          })
          continue
        }
        if (file.size === 0) {
          atualizarItem(key, { status: 'ERRO', erro: 'Arquivo vazio.' })
          continue
        }

        // ===== 2. Hash do arquivo (deduplicação) =====
        const hashArquivo = await calcularHashArquivo(file)

        // ===== 3. Processa o PDF (timeout de segurança de 60s) =====
        const resultado = await comTimeout(
          processarPDF(file),
          60000,
          'Tempo limite excedido no processamento do PDF.',
        )
        adicionarPasso(key, '✓ PDF processado')

        // ===== 3.1 Falha de LEITURA do PDF → mensagem real para o usuário =====
        // Sem isso, um PDF escaneado (sem camada de texto), corrompido ou
        // protegido por senha caía no ramo de "UC não identificada" e o motivo
        // real nunca aparecia para o admin.
        if (resultado.status === 'erro' || !resultado.componentes) {
          const motivoLeitura = resultado.erro || 'Não foi possível extrair o texto da fatura.'
          atualizarItem(key, { status: 'ERRO', erro: motivoLeitura })
          adicionarPasso(key, '✗ Leitura do PDF não concluída')
          logar(
            'ERRO_EXTRACAO_PDF',
            `Fatura ${file.name}: ${motivoLeitura}`,
            session?.nome || 'Sistema',
          )
          // Registra a revisão para o admin ter rastreabilidade do arquivo.
          try {
            await comTimeout(
              criarRevisao({
                faturaId: null,
                arquivo: file.name,
                clienteId: null,
                clienteNome: null,
                motivo: motivoLeitura,
                camposFaltantes: resultado.completude?.faltantes || ['Leitura do PDF'],
              }),
              8000,
            )
          } catch (e) {
            console.warn('Firestore indisponível — revisão não registrada:', e.message)
          }
          continue
        }

        const componentes = resultado.componentes || {}
        const calculo = resultado.calculo || null
        const validacao = resultado.validacao || { valido: false, erros: [] }

        // ===== 4. Identifica a UC =====
        const ucExtraida = normalizarUC(componentes.uc)
        if (ucExtraida) {
          atualizarItem(key, { uc: ucExtraida })
          adicionarPasso(key, `✓ UC identificada: ${ucExtraida}`)
        }

        // ===== 5. Verifica duplicidade da fatura =====
        const chaveDedupe = gerarChaveDedupe({
          uc: ucExtraida,
          referencia: normalizarRef(componentes.referencia),
          numeroNota: componentes.numeroNota,
        })
        const faturasAtuais = getFaturas()
        const duplicada = encontrarFaturaDuplicada(faturasAtuais, { hashArquivo, chaveDedupe })
        if (duplicada) {
          atualizarItem(key, {
            status: 'DUPLICADA',
            cliente: duplicada.clienteNome || '—',
            erro: `Fatura já existe no sistema (${duplicada.arquivo}).`,
          })
          logar(
            'FATURA_DUPLICADA',
            `Fatura ${file.name} duplicada de ${duplicada.arquivo}`,
            session?.nome || 'Sistema',
          )
          continue
        }

        // ===== 6. Identifica UC e cliente (prioridade: UC → cliente vinculado) =====
        let clienteDestino = null
        let unidadeDestino = null
        const decisao = identificarFatura({
          componentes,
          unidades: getUnidades(),
          clientes: getClientes(),
        })
        if (decisao.decisao === DECISAO.PROCESSADO) {
          clienteDestino = decisao.cliente
          unidadeDestino = decisao.unidade
        }

        // ===== 7. Registra o processamento no Firestore (não bloqueia) =====
        let processamentoId = { ok: false }
        try {
          processamentoId = await comTimeout(
            registrarProcessamentoFatura({
              arquivo: file.name,
              clienteId: clienteDestino?.id || null,
              status: resultado.ok ? 'concluido' : resultado.status,
              etapa: 'processando',
            }),
            8000,
          )
        } catch (e) {
          console.warn('Firestore indisponível — seguindo com dados locais:', e.message)
        }

        // ===== 8. Salva o PDF no IndexedDB =====
        // A leitura é aguardada corretamente e possui tratamento de erro:
        // antes, sem `onerror`, a Promise nunca resolvia se a leitura falhasse.
        let dataUrl = null
        try {
          dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result)
            reader.onerror = () =>
              reject(reader.error || new Error('Falha ao ler o arquivo para armazenamento local.'))
            reader.onabort = () => reject(new Error('Leitura do arquivo cancelada.'))
            reader.readAsDataURL(file)
          })
        } catch (e) {
          console.warn('Falha ao preparar o arquivo para armazenamento local:', e.message)
        }

        const id = Date.now() + Math.random()
        if (dataUrl) {
          try {
            await salvarArquivoDB(id, dataUrl)
          } catch (e) {
            // Não bloqueia o registro da fatura: o arquivo é um extra.
            console.warn('Falha ao salvar o PDF no IndexedDB:', e.message)
          }
        }

        // ===== 9. Monta os dados da fatura =====
        const dadosFatura = {
          id,
          clienteId: clienteDestino?.id || null,
          ucId: unidadeDestino?.id || null,
          arquivo: file.name,
          clienteNome: clienteDestino?.nome || componentes.cliente || null,
          uc: unidadeDestino?.numeroUC || ucExtraida || componentes.uc || null,
          referencia: normalizarRef(componentes.referencia) || null,
          vencimento: normalizarVenc(componentes.vencimento) || '',
          consumo: componentes.consumo || null,
          status: resultado.status || 'erro',
          componentes,
          calculo,
          validacao,
          valorTotal: calculo?.valorFinal || null,
          dataUpload: new Date().toLocaleDateString('pt-BR'),
          processamentoId: processamentoId.ok ? processamentoId.id : null,
          // Deduplicação
          hashArquivo,
          chaveDedupe,
          numeroNota: componentes.numeroNota || null,
          // Idempotência forte (UC|referencia|nota#hash) — impede duplicação no Firestore
          chaveIdempotencia: montarChaveIdempotencia({
            uc: unidadeDestino?.numeroUC || ucExtraida || componentes.uc,
            referencia: normalizarRef(componentes.referencia),
            numeroNota: componentes.numeroNota,
            hashArquivo,
          }),
          idFatura: gerarIdFatura({
            uc: unidadeDestino?.numeroUC || ucExtraida || componentes.uc,
            referencia: normalizarRef(componentes.referencia),
            numeroNota: componentes.numeroNota,
            hashArquivo,
          }),
          statusProcessamento:
            decisao.decisao === DECISAO.PROCESSADO
              ? STATUS_FATURA.PROCESSADO
              : decisao.decisao === DECISAO.ERRO_EXTRACAO
                ? STATUS_FATURA.ERRO_EXTRACAO
                : STATUS_FATURA.REVISAO_MANUAL,
          motivoIdentificacao: decisao.motivo || null,
          // Rastreio do pipeline
          vinculadaAutomaticamente: Boolean(clienteDestino),
          pendenteVinculacao: !clienteDestino,
        }

        // ===== 10. Salva no Firestore (não bloqueia) e no localStorage =====
        try {
          const resultadoFirestore = await comTimeout(salvarFaturaIdempotenteFirestore(dadosFatura), 8000)
          if (resultadoFirestore.ok) {
            dadosFatura.firestoreId = resultadoFirestore.id
          }
        } catch (e) {
          console.warn('Firestore indisponível — fatura salva apenas localmente:', e.message)
        }

        const resultadoLocal = addFatura(dadosFatura)

        // ===== 11. Atualiza o processamento (não bloqueia) =====
        if (processamentoId.ok) {
          try {
            await comTimeout(
              atualizarProcessamentoFatura(processamentoId.id, {
                status: resultado.ok ? 'concluido' : resultado.status,
                etapa: 'concluido',
                faturaId: resultadoLocal.ok ? resultadoLocal.fatura.id : null,
                erros: validacao.erros || [],
              }),
              8000,
            )
          } catch (e) {
            console.warn('Firestore indisponível — processamento não atualizado:', e.message)
          }
        }

        // ===== 12. Roteamento por identificação da UC =====
        if (clienteDestino) {
          // UC encontrada → fatura vinculada automaticamente
          adicionarPasso(key, `✓ Cliente encontrado: ${clienteDestino.nome}`)
          adicionarPasso(key, '✓ Fatura vinculada')
          atualizarItem(key, {
            status: 'VINCULADA',
            cliente: clienteDestino.nome,
            faturaId: resultadoLocal.ok ? resultadoLocal.fatura.id : null,
          })
          logar(
            'UC_IDENTIFICADA',
            `Fatura ${file.name} vinculada automaticamente ao cliente ${clienteDestino.nome} (UC ${ucExtraida})`,
            session?.nome || 'Sistema',
          )
        } else if (
          ucExtraida &&
          (decisao.motivo === MOTIVO_REVISAO.UC_SEM_CLIENTE ||
            decisao.motivo === MOTIVO_REVISAO.UC_NAO_ENCONTRADA)
        ) {
          // UC não encontrada → pré-cadastro pendente de revisão
          const pre = addPreCadastro(
            {
              uc: ucExtraida,
              nome: componentes.cliente || null,
              cpfCnpj: componentes.cpfCnpj || null,
              numeroInstalacao: componentes.numeroInstalacao || null,
              numeroCliente: componentes.numeroCliente || null,
              numeroMedidor: componentes.numeroMedidor || null,
              endereco: componentes.endereco || null,
              cidade: componentes.cidade || null,
              estado: componentes.estado || null,
              cep: componentes.cep || null,
              confiancas: componentes.confiancas || {},
              errosExtracao: validacao.erros || [],
            },
            {
              arquivo: file.name,
              hashArquivo,
              faturaId: resultadoLocal.ok ? resultadoLocal.fatura.id : null,
              usuario: session?.nome || 'Sistema',
            },
          )

          if (pre.ok) {
            adicionarPasso(
              key,
              `⚠ UC ${ucExtraida} não cadastrada — pré-cadastro criado para revisão`,
            )
            atualizarItem(key, {
              status: 'NOVO_CLIENTE',
              cliente: componentes.cliente || `UC ${ucExtraida}`,
              erro: explicacaoMotivo(decisao.motivo, ucExtraida),
            })
          } else if (pre.duplicado && pre.duplicado.nome) {
            // Já existe pré-cadastro pendente para essa UC — vincula a fatura a ele
            if (resultadoLocal.ok) {
              updateFatura(resultadoLocal.fatura.id, {
                clienteId: pre.duplicado.id,
                pendenteVinculacao: true,
              })
            }
            adicionarPasso(key, '⚠ Pré-cadastro já existente — fatura anexada a ele')
            atualizarItem(key, {
              status: 'PENDENTE_REVISÃO',
              cliente: pre.duplicado.nome || `UC ${ucExtraida}`,
            })
          } else {
            atualizarItem(key, { status: 'ERRO', erro: pre.message })
          }
        } else {
          // Revisão manual obrigatória: múltiplas UCs possíveis, cliente incompatível,
          // UC ausente ou não identificada.
          // NUNCA criar/associar cliente automaticamente nesses casos.
          const motivo = ROTULO_MOTIVO_REVISAO[decisao.motivo] || 'identificação pendente'
          adicionarPasso(key, `⚠ ${motivo} — enviado para revisão manual`)
          atualizarItem(key, {
            // Distingue "UC lida mas não cadastrada" de "UC não identificada no PDF"
            status: statusPorMotivo[decisao.motivo] || 'UC_NAO_IDENTIFICADA',
            cliente: null,
            erro: explicacaoMotivo(decisao.motivo, ucExtraida),
          })
          logar(
            'ERRO_PROCESSAMENTO',
            `Fatura ${file.name} enviada para revisão manual (${decisao.motivo || 'UC ausente no PDF'})`,
            session?.nome || 'Sistema',
          )
        }

        // ===== 13. Se requer revisão, cria registro de revisão (não bloqueia) =====
        if (resultado.status === 'requer revisão' || resultado.status === 'erro') {
          try {
            await comTimeout(
              criarRevisao({
                faturaId: resultadoLocal.ok ? resultadoLocal.fatura.id : null,
                arquivo: file.name,
                clienteId: clienteDestino?.id || null,
                clienteNome: clienteDestino?.nome || componentes.cliente || null,
                motivo: resultado.erro || (validacao.erros || []).join('; ') || 'Componentes não identificados',
                camposFaltantes: resultado.completude?.faltantes || [],
              }),
              8000,
            )
          } catch (e) {
            console.warn('Firestore indisponível — revisão não registrada:', e.message)
          }
        }
      } catch (error) {
        console.error('Erro ao processar fatura:', error)
        atualizarItem(key, { status: 'ERRO', erro: error.message })
      }
    }

    setProcessando(false)
    refresh()
    setTimeout(() => {
      setMensagem('')
      setMensagemErro('')
    }, 5000)
  }

  const publicarFatura = (id) => {
    updateFatura(id, { status: 'disponivel' })
    setMensagem('Fatura publicada e disponível para o cliente.')
    setTimeout(() => setMensagem(''), 3000)
    refresh()
  }

  const faturasPendentes = faturas.filter((f) => f.status === 'aguardando revisão')
  const faturasPublicadas = faturas.filter((f) => f.status === 'disponivel')
  const faturasRequerRevisao = faturas.filter((f) => f.status === 'requer revisão')
  const faturasComErro = faturas.filter((f) => f.status === 'erro')

  // Rótulos amigáveis por status da fila
  const rotuloStatus = {
    PROCESSANDO: { texto: 'Processando', classe: 'tag tag-neutral' },
    VINCULADA: { texto: 'Vinculada', classe: 'tag tag-success' },
    NOVO_CLIENTE: { texto: 'Novo cliente', classe: 'tag tag-warning' },
    PENDENTE_REVISÃO: { texto: 'Pendente revisão', classe: 'tag tag-warning' },
    DUPLICADA: { texto: 'Duplicada', classe: 'tag tag-error' },
    // Motivos distintos de revisão — antes todos apareciam como
    // "UC não identificada", mesmo quando a UC havia sido lida corretamente.
    UC_NAO_CADASTRADA: { texto: 'UC não cadastrada', classe: 'tag tag-warning' },
    UC_SEM_CLIENTE: { texto: 'UC sem cliente vinculado', classe: 'tag tag-warning' },
    MULTIPLAS_UCS: { texto: 'Múltiplas UCs possíveis', classe: 'tag tag-warning' },
    CLIENTE_INCOMPATIVEL: { texto: 'Cliente incompatível', classe: 'tag tag-error' },
    UC_NAO_IDENTIFICADA: { texto: 'UC não identificada', classe: 'tag tag-error' },
    ERRO: { texto: 'Erro', classe: 'tag tag-error' },
  }

  return (
    <>
      <section className="panel">
        <div className="panel-header compact">
          <div>
            <span className="eyebrow">Upload de faturas</span>
            <h3>Importação automática (identifica UC, cliente e vincula a fatura)</h3>
          </div>
        </div>

        {mensagem && (
          <p style={{ padding: '10px', background: '#f0fdf4', color: '#166534', borderRadius: '8px', marginBottom: '12px' }}>
            {mensagem}
          </p>
        )}
        {mensagemErro && (
          <p style={{ padding: '10px', background: '#fef2f2', color: '#dc2626', borderRadius: '8px', marginBottom: '12px' }}>
            {mensagemErro}
          </p>
        )}

        <label className="upload-area" style={{ display: 'block' }}>
          <input
            type="file"
            accept=".pdf,application/pdf"
            multiple
            style={{ display: 'none' }}
            disabled={processando}
            onChange={(e) => {
              handleUpload(e.target.files)
              e.target.value = ''
            }}
          />
          <div
            style={{
              border: '2px dashed #cbd5e1',
              borderRadius: '12px',
              padding: '24px',
              textAlign: 'center',
              cursor: processando ? 'not-allowed' : 'pointer',
              color: '#64748b',
            }}
          >
            📄 <strong>Selecione um ou mais PDFs</strong>
            <br />
            {processando ? 'Processando...' : 'Clique aqui para escolher os arquivos de fatura'}
            <br />
            <small style={{ color: '#94a3b8' }}>
              O sistema identifica automaticamente a UC, vincula ao cliente existente ou cria um pré-cadastro para revisão. Máx. {TAMANHO_MAX_PDF_MB}MB por arquivo.
            </small>
          </div>
        </label>

        {/* Fila de progresso em tempo real */}
        {fila.length > 0 && (
          <div style={{ marginTop: '16px' }}>
            <strong style={{ fontSize: '14px' }}>Processamento</strong>
            <div style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
              {fila.map((item) => {
                const rot = rotuloStatus[item.status] || rotuloStatus.PROCESSANDO
                return (
                  <div
                    key={item.key}
                    style={{
                      background: '#f8fafc',
                      border: '1px solid #e2e8f0',
                      borderRadius: '10px',
                      padding: '10px 12px',
                      fontSize: '13px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                      <strong>📄 {item.arquivo}</strong>
                      <span className={rot.classe} style={{ marginTop: 0 }}>{rot.texto}</span>
                    </div>
                    {item.uc && (
                      <small style={{ display: 'block', color: '#475569' }}>UC: {item.uc}</small>
                    )}
                    {item.cliente && (
                      <small style={{ display: 'block', color: '#475569' }}>Cliente: {item.cliente}</small>
                    )}
                    {item.erro && (
                      <small style={{ display: 'block', color: '#dc2626' }}>{item.erro}</small>
                    )}
                    {item.passos?.length > 0 && (
                      <small style={{ display: 'block', color: '#64748b', marginTop: '4px' }}>
                        {item.passos.join(' · ')}
                      </small>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header compact">
          <div>
            <span className="eyebrow">Aguardando revisão</span>
            <h3>Pendentes ({faturasPendentes.length})</h3>
          </div>
        </div>

        {faturasPendentes.length === 0 ? (
          <p style={{ color: '#64748b', padding: '12px 0' }}>Nenhuma fatura aguardando revisão.</p>
        ) : (
          faturasPendentes.map((fat) => (
            <div key={fat.id} className="invoice-item" style={{ marginBottom: '10px', padding: '8px', background: '#f8fafc', borderRadius: '8px' }}>
              <div>
                <strong>{fat.arquivo}</strong>
                <small>Cliente: {fat.clienteNome || '—'} · UC: {fat.uc || '—'}</small>
                <small>Ref: {fat.referencia || '—'} · {fat.dataUpload}</small>
                {fat.pendenteVinculacao && (
                  <small style={{ display: 'block', color: '#b45309' }}>
                    ⚠ Aguardando confirmação de pré-cadastro
                  </small>
                )}
                {fat.calculo && (
                  <small style={{ display: 'block', color: '#166534' }}>
                    💰 Desconto: {formatCurrency(fat.calculo.valorDesconto)} · Final: {formatCurrency(fat.calculo.valorFinal)}
                  </small>
                )}
              </div>
              <div className="invoice-actions">
                <button type="button" onClick={() => publicarFatura(fat.id)}>Publicar p/ cliente</button>
                <button type="button" onClick={() => { removeFatura(fat.id); refresh(); }}>Remover</button>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="panel">
        <div className="panel-header compact">
          <div>
            <span className="eyebrow">Requerem revisão</span>
            <h3>Requer revisão ({faturasRequerRevisao.length})</h3>
          </div>
        </div>

        {faturasRequerRevisao.length === 0 ? (
          <p style={{ color: '#64748b', padding: '12px 0' }}>Nenhuma fatura requerendo revisão.</p>
        ) : (
          faturasRequerRevisao.map((fat) => (
            <div key={fat.id} className="invoice-item" style={{ marginBottom: '10px', padding: '8px', background: '#fef2f2', borderRadius: '8px' }}>
              <div>
                <strong>{fat.arquivo}</strong>
                <small>Cliente: {fat.clienteNome || '—'} · UC: {fat.uc || '—'}</small>
                <small>Ref: {fat.referencia || '—'} · {fat.dataUpload}</small>
                {fat.validacao?.erros?.length > 0 && (
                  <small style={{ display: 'block', color: '#dc2626' }}>
                    ⚠️ {fat.validacao.erros.join('; ')}
                  </small>
                )}
              </div>
              <div className="invoice-actions">
                <button type="button" onClick={() => { removeFatura(fat.id); refresh(); }}>Remover</button>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="panel">
        <div className="panel-header compact">
          <div>
            <span className="eyebrow">Com erro</span>
            <h3>Erros ({faturasComErro.length})</h3>
          </div>
        </div>

        {faturasComErro.length === 0 ? (
          <p style={{ color: '#64748b', padding: '12px 0' }}>Nenhuma fatura com erro.</p>
        ) : (
          faturasComErro.map((fat) => (
            <div key={fat.id} className="invoice-item" style={{ marginBottom: '10px', padding: '8px', background: '#fef2f2', borderRadius: '8px' }}>
              <div>
                <strong>{fat.arquivo}</strong>
                <small>Cliente: {fat.clienteNome || '—'} · UC: {fat.uc || '—'}</small>
                <small>Ref: {fat.referencia || '—'} · {fat.dataUpload}</small>
                {fat.validacao?.erros?.length > 0 && (
                  <small style={{ display: 'block', color: '#dc2626' }}>
                    ❌ {fat.validacao.erros.join('; ')}
                  </small>
                )}
              </div>
              <div className="invoice-actions">
                <button type="button" onClick={() => { removeFatura(fat.id); refresh(); }}>Remover</button>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="panel">
        <div className="panel-header compact">
          <div>
            <span className="eyebrow">Publicadas</span>
            <h3>Disponíveis para clientes ({faturasPublicadas.length})</h3>
          </div>
        </div>

        {faturasPublicadas.length === 0 ? (
          <p style={{ color: '#64748b', padding: '12px 0' }}>Nenhuma fatura publicada.</p>
        ) : (
          faturasPublicadas.map((fat) => (
            <div key={fat.id} className="invoice-item" style={{ marginBottom: '10px', padding: '8px', background: '#f8fafc', borderRadius: '8px' }}>
              <div>
                <strong>{fat.arquivo}</strong>
                <small>Cliente: {fat.clienteNome || '—'} · UC: {fat.uc || '—'}</small>
                <small>Ref: {fat.referencia || '—'} · {fat.valorTotal ? formatCurrency(fat.valorTotal) : '—'} · {fat.consumo ? `${fat.consumo} kWh` : '—'}</small>
                {fat.calculo && (
                  <small style={{ display: 'block', color: '#166534' }}>
                    💰 Energia: {formatCurrency(fat.calculo.valorElegivel)} · Desconto 20%: {formatCurrency(fat.calculo.valorDesconto)} · Impostos: {formatCurrency(fat.calculo.impostosTributosEncargos)} · Final: {formatCurrency(fat.calculo.valorFinal)}
                  </small>
                )}
              </div>
              <div className="invoice-actions">
                <button type="button" onClick={() => { removeFatura(fat.id); refresh(); }}>Remover</button>
              </div>
            </div>
          ))
        )}
      </section>
    </>
  )
}

/* ======================== SEÇÃO PRÉ-CADASTROS ======================== */
function PreCadastrosSection() {
  const {
    getPreCadastros,
    confirmarPreCadastro,
    descartarPreCadastro,
    updatePreCadastro,
    session,
  } = useAuth()
  const [preCadastros, setPreCadastros] = useDadosSincronizados(getPreCadastros, getPreCadastros())
  const [emRevisao, setEmRevisao] = useState(null) // pré-cadastro aberto no modal
  const [mensagem, setMensagem] = useState('')

  const refresh = () => setPreCadastros(getPreCadastros())

  const pendentes = preCadastros.filter((p) => p.status === 'PENDING_REVIEW')

  const handleConfirmar = (dadosEditados) => {
    const resultado = confirmarPreCadastro(emRevisao.id, dadosEditados, {
      usuario: session?.nome || 'Sistema',
    })
    if (resultado.ok) {
      setMensagem(
        resultado.message?.includes('já existia')
          ? 'UC já existia — faturas vinculadas ao cliente existente.'
          : `Cliente ${resultado.cliente?.nome} confirmado e faturas vinculadas!`,
      )
      setEmRevisao(null)
      refresh()
    } else {
      setMensagem(resultado.message)
    }
    setTimeout(() => setMensagem(''), 6000)
  }

  const handleDescartar = (pre) => {
    if (window.confirm(`Descartar o pré-cadastro da UC ${pre.uc || '—'} e suas faturas?`)) {
      descartarPreCadastro(pre.id, { usuario: session?.nome || 'Sistema' })
      refresh()
    }
  }

  return (
    <section className="panel">
      <div className="panel-header compact">
        <div>
          <span className="eyebrow">Novos clientes identificados por fatura</span>
          <h3>Pré-cadastros pendentes ({pendentes.length})</h3>
        </div>
      </div>

      {mensagem && (
        <p style={{ padding: '10px', background: '#f0fdf4', color: '#166534', borderRadius: '8px', marginBottom: '12px' }}>
          {mensagem}
        </p>
      )}

      {pendentes.length === 0 ? (
        <p style={{ color: '#64748b', padding: '12px 0' }}>
          Nenhum pré-cadastro pendente. 🎉
        </p>
      ) : (
        pendentes.map((pre) => (
          <div key={pre.id} className="invoice-item" style={{ marginBottom: '12px', padding: '12px', background: '#fffbeb', borderRadius: '12px', flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <div>
                <strong>{pre.nome || 'Nome não identificado'}</strong>
                <span className="tag tag-warning">Pendente de revisão</span>
                <small style={{ display: 'block', color: '#64748b' }}>
                  UC: {pre.uc || '—'} · Instalação: {pre.numeroInstalacao || '—'} · CPF/CNPJ: {pre.cpfCnpj || '—'}
                </small>
                <small style={{ display: 'block', color: '#64748b' }}>
                  Endereço: {pre.endereco || '—'} · {pre.cidade || '—'}/{pre.estado || '—'} · CEP: {pre.cep || '—'}
                </small>
                <small style={{ display: 'block', color: '#64748b' }}>
                  Arquivo: {pre.arquivo || '—'} · Upload: {pre.criadoEm} · Por: {pre.usuario}
                </small>
                {pre.errosExtracao?.length > 0 && (
                  <small style={{ display: 'block', color: '#b45309' }}>
                    ⚠ {pre.errosExtracao.join('; ')}
                  </small>
                )}
              </div>
              <div className="invoice-actions">
                <button type="button" onClick={() => setEmRevisao(pre)}>Revisar e confirmar</button>
                <button type="button" onClick={() => handleDescartar(pre)}>Descartar</button>
              </div>
            </div>
          </div>
        ))
      )}

      {/* Modal de revisão */}
      {emRevisao && (
        <ModalRevisaoPreCadastro
          preCadastro={emRevisao}
          onCancelar={() => setEmRevisao(null)}
          onSalvarPendente={(dados) => {
            updatePreCadastro(emRevisao.id, dados, { usuario: session?.nome || 'Sistema' })
            setMensagem('Pré-cadastro salvo como pendente.')
            setEmRevisao(null)
            refresh()
            setTimeout(() => setMensagem(''), 4000)
          }}
          onConfirmar={handleConfirmar}
        />
      )}
    </section>
  )
}

/* ======================== MODAL DE REVISÃO DE PRÉ-CADASTRO ======================== */
function ModalRevisaoPreCadastro({ preCadastro, onCancelar, onSalvarPendente, onConfirmar }) {
  const [form, setForm] = useState({
    nome: preCadastro.nome || '',
    cpfCnpj: preCadastro.cpfCnpj || '',
    uc: preCadastro.uc || '',
    numeroInstalacao: preCadastro.numeroInstalacao || '',
    endereco: preCadastro.endereco || '',
    cidade: preCadastro.cidade || '',
    estado: preCadastro.estado || '',
    cep: preCadastro.cep || '',
  })
  const [erro, setErro] = useState('')

  const conf = preCadastro.confiancas || {}
  const seloConfianca = (campo) => {
    const status = conf[campo]
    if (status === 'CONFIRMADO') return <span className="tag tag-success" style={{ marginTop: 0, marginLeft: '6px' }}>✓ Confirmado</span>
    if (status === 'REVISAR') return <span className="tag tag-warning" style={{ marginTop: 0, marginLeft: '6px' }}>⚠ Revisar</span>
    return <span className="tag tag-error" style={{ marginTop: 0, marginLeft: '6px' }}>Não identificado</span>
  }

  const handleConfirmar = () => {
    if (!form.uc?.trim()) {
      setErro('A UC é obrigatória para confirmar o cadastro.')
      return
    }
    if (!form.nome?.trim()) {
      setErro('O nome do cliente é obrigatório.')
      return
    }
    setErro('')
    onConfirmar(form)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: '16px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancelar()
      }}
    >
      <div
        className="panel"
        style={{
          width: 'min(100%, 640px)',
          maxHeight: '90vh',
          overflowY: 'auto',
          margin: 0,
          background: '#fff',
        }}
      >
        <div className="panel-header compact">
          <div>
            <span className="eyebrow">Novo cliente identificado pela fatura</span>
            <h3>Revisar dados extraídos</h3>
          </div>
        </div>

        <p style={{ color: '#64748b', fontSize: '13px', marginTop: 0 }}>
          Arquivo: <strong>{preCadastro.arquivo || '—'}</strong> · Confira e edite os dados antes de confirmar.
        </p>

        {erro && (
          <p style={{ padding: '10px', background: '#fef2f2', color: '#dc2626', borderRadius: '8px', marginBottom: '12px' }}>
            {erro}
          </p>
        )}

        <div className="profile-grid">
          <div className="field">
            <span>Nome completo * {seloConfianca('cliente')}</span>
            <input
              type="text"
              value={form.nome}
              onChange={(e) => setForm((f) => ({ ...f, nome: e.target.value }))}
              placeholder="Nome do cliente"
            />
          </div>
          <div className="field">
            <span>CPF/CNPJ {seloConfianca('cpfCnpj')}</span>
            <input
              type="text"
              value={form.cpfCnpj}
              onChange={(e) => setForm((f) => ({ ...f, cpfCnpj: e.target.value }))}
              placeholder="000.000.000-00"
            />
          </div>
          <div className="field">
            <span>UC (unidade consumidora) *</span>
            <input
              type="text"
              value={form.uc}
              onChange={(e) => setForm((f) => ({ ...f, uc: e.target.value }))}
              placeholder="Número da UC"
            />
          </div>
          <div className="field">
            <span>Código da instalação</span>
            <input
              type="text"
              value={form.numeroInstalacao}
              onChange={(e) => setForm((f) => ({ ...f, numeroInstalacao: e.target.value }))}
              placeholder="Código da instalação"
            />
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <span>Endereço</span>
            <input
              type="text"
              value={form.endereco}
              onChange={(e) => setForm((f) => ({ ...f, endereco: e.target.value }))}
              placeholder="Endereço completo"
            />
          </div>
          <div className="field">
            <span>Cidade</span>
            <input
              type="text"
              value={form.cidade}
              onChange={(e) => setForm((f) => ({ ...f, cidade: e.target.value }))}
              placeholder="Cidade"
            />
          </div>
          <div className="field">
            <span>Estado</span>
            <input
              type="text"
              value={form.estado}
              onChange={(e) => setForm((f) => ({ ...f, estado: e.target.value }))}
              placeholder="UF"
            />
          </div>
          <div className="field">
            <span>CEP</span>
            <input
              type="text"
              value={form.cep}
              onChange={(e) => setForm((f) => ({ ...f, cep: e.target.value }))}
              placeholder="00000-000"
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '16px' }}>
          <button type="button" className="ghost-button" onClick={onCancelar} style={{ flex: 1 }}>
            Cancelar
          </button>
          <button
            type="button"
            className="secondary-button"
            style={{ flex: 1, marginTop: 0 }}
            onClick={() => onSalvarPendente(form)}
          >
            Salvar como pendente
          </button>
          <button type="button" className="primary-button" style={{ flex: 1 }} onClick={handleConfirmar}>
            Confirmar cadastro
          </button>
        </div>
      </div>
    </div>
  )
}

/* ======================== SEÇÃO REVISÕES ======================== */
function RevisoesSection() {
  const { getFaturas, updateFatura, removeFatura } = useAuth()
  const [faturas, setFaturas] = useDadosSincronizados(getFaturas, getFaturas())
  const [mensagem, setMensagem] = useState('')

  const refresh = () => setFaturas(getFaturas())

  const faturasRequerRevisao = faturas.filter((f) => f.status === 'requer revisão' || f.status === 'erro')

  const aprovarFatura = (id) => {
    updateFatura(id, { status: 'disponivel' })
    setMensagem('Fatura aprovada e publicada para o cliente.')
    setTimeout(() => setMensagem(''), 3000)
    refresh()
  }

  const rejeitarFatura = (id) => {
    removeFatura(id)
    setMensagem('Fatura removida do sistema.')
    setTimeout(() => setMensagem(''), 3000)
    refresh()
  }

  return (
    <section className="panel">
      <div className="panel-header compact">
        <div>
          <span className="eyebrow">Análise administrativa</span>
          <h3>Faturas que requerem revisão ({faturasRequerRevisao.length})</h3>
        </div>
      </div>

      {mensagem && (
        <p style={{ padding: '10px', background: '#f0fdf4', color: '#166534', borderRadius: '8px', marginBottom: '12px' }}>
          {mensagem}
        </p>
      )}

      {faturasRequerRevisao.length === 0 ? (
        <p style={{ color: '#64748b', padding: '12px 0' }}>
          Nenhuma fatura requerendo revisão. 🎉
        </p>
      ) : (
        faturasRequerRevisao.map((fat) => (
          <div key={fat.id} className="invoice-item" style={{ marginBottom: '12px', padding: '12px', background: '#f8fafc', borderRadius: '12px' }}>
            <div>
              <strong>{fat.arquivo}</strong>
              <span className="tag tag-error">{fat.status}</span>
              <small style={{ display: 'block', color: '#64748b' }}>
                Cliente: {fat.clienteNome || '—'} · UC: {fat.uc || '—'} · Ref: {fat.referencia || '—'}
              </small>
              {fat.validacao?.erros?.length > 0 && (
                <div style={{ marginTop: '8px', padding: '8px', background: '#fef2f2', borderRadius: '8px' }}>
                  <strong style={{ color: '#dc2626', fontSize: '13px' }}>Motivos da revisão:</strong>
                  <ul style={{ margin: '4px 0 0 20px', color: '#dc2626', fontSize: '13px' }}>
                    {fat.validacao.erros.map((erro, i) => (
                      <li key={i}>{erro}</li>
                    ))}
                  </ul>
                </div>
              )}
              {fat.completude?.faltantes?.length > 0 && (
                <div style={{ marginTop: '8px', padding: '8px', background: '#fffbeb', borderRadius: '8px' }}>
                  <strong style={{ color: '#b45309', fontSize: '13px' }}>Campos não identificados:</strong>
                  <small style={{ display: 'block', color: '#b45309' }}>
                    {fat.completude.faltantes.join(', ')}
                  </small>
                </div>
              )}
              {fat.componentes && (
                <div style={{ marginTop: '8px', padding: '8px', background: '#f0fdf4', borderRadius: '8px' }}>
                  <strong style={{ color: '#166534', fontSize: '13px' }}>Componentes identificados:</strong>
                  <small style={{ display: 'block', color: '#166534' }}>
                    Energia: {fat.componentes.energia ? formatCurrency(fat.componentes.energia) : '—'} · 
                    TUSD: {fat.componentes.tusd ? formatCurrency(fat.componentes.tusd) : '—'} · 
                    TE: {fat.componentes.te ? formatCurrency(fat.componentes.te) : '—'} · 
                    ICMS: {fat.componentes.icms ? formatCurrency(fat.componentes.icms) : '—'} · 
                    PIS: {fat.componentes.pis ? formatCurrency(fat.componentes.pis) : '—'} · 
                    COFINS: {fat.componentes.cofins ? formatCurrency(fat.componentes.cofins) : '—'}
                  </small>
                </div>
              )}
            </div>
            <div className="invoice-actions">
              <button type="button" onClick={() => aprovarFatura(fat.id)}>✅ Aprovar e publicar</button>
              <button type="button" onClick={() => rejeitarFatura(fat.id)}>🗑️ Remover</button>
            </div>
          </div>
        ))
      )}
    </section>
  )
}

/* ======================== SEÇÃO USUÁRIOS ======================== */
function UsuariosSection() {
  const { getUsuarios, addUsuario, removeUsuario, session } = useAuth()
  const [usuarios, setUsuarios] = useDadosSincronizados(getUsuarios, getUsuarios())
  const [showForm, setShowForm] = useState(false)
  const [mensagem, setMensagem] = useState('')
  const [form, setForm] = useState({ nome: '', email: '', senha: '', perfil: 'operador' })

  const refresh = () => setUsuarios(getUsuarios())

  const handleSubmit = (e) => {
    e.preventDefault()
    const result = addUsuario(form)
    setMensagem(result.ok ? 'Usuário criado com sucesso!' : result.message)
    if (result.ok) {
      setShowForm(false)
      setForm({ nome: '', email: '', senha: '', perfil: 'operador' })
      refresh()
    }
    setTimeout(() => setMensagem(''), 3000)
  }

  return (
    <section className="panel">
      <div className="panel-header compact">
        <div>
          <span className="eyebrow">Perfis de acesso</span>
          <h3>Usuários administrativos ({usuarios.length})</h3>
        </div>
        {session?.perfil === 'administrador' && (
          <button type="button" className="primary-button" onClick={() => setShowForm((s) => !s)}>
            {showForm ? 'Fechar' : '+ Novo usuário'}
          </button>
        )}
      </div>

      {session?.perfil !== 'administrador' && (
        <p style={{ color: '#b45309', background: '#fef3c7', padding: '10px', borderRadius: '8px', marginBottom: '12px' }}>
          Somente administradores podem gerenciar usuários.
        </p>
      )}

      {mensagem && (
        <p style={{ padding: '10px', background: '#f0fdf4', color: '#166534', borderRadius: '8px', marginBottom: '12px' }}>
          {mensagem}
        </p>
      )}

      {showForm && session?.perfil === 'administrador' && (
        <form onSubmit={handleSubmit} style={{ background: '#f8fafc', padding: '16px', borderRadius: '12px', marginBottom: '16px' }}>
          <div className="profile-grid">
            <div className="field">
              <span>Nome completo *</span>
              <input type="text" required value={form.nome} onChange={(e) => setForm((f) => ({ ...f, nome: e.target.value }))} />
            </div>
            <div className="field">
              <span>E-mail *</span>
              <input type="email" required value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div className="field">
              <span>Senha *</span>
              <input type="text" required value={form.senha} onChange={(e) => setForm((f) => ({ ...f, senha: e.target.value }))} />
            </div>
            <div className="field">
              <span>Perfil *</span>
              <select value={form.perfil} onChange={(e) => setForm((f) => ({ ...f, perfil: e.target.value }))}>
                <option value="operador">Operador</option>
                <option value="administrador">Administrador</option>
              </select>
            </div>
          </div>
          <button type="submit" className="primary-button" style={{ marginTop: '12px' }}>
            Criar usuário
          </button>
        </form>
      )}

      {usuarios.map((u) => (
        <div key={u.id} className="invoice-item" style={{ marginBottom: '8px', padding: '10px', background: '#f8fafc', borderRadius: '8px' }}>
          <div>
            <strong>{u.nome}</strong>
            {u.perfil === 'administrador' ? <span className="tag tag-success">Admin</span> : <span className="tag tag-neutral">Operador</span>}
            <small style={{ display: 'block', color: '#64748b' }}>{u.email} · Criado em {u.criadoEm}</small>
          </div>
          {session?.perfil === 'administrador' && u.id !== session?.usuarioId && (
            <button type="button" onClick={() => { removeUsuario(u.id); refresh(); }}>
              Remover
            </button>
          )}
        </div>
      ))}
    </section>
  )
}

/* ======================== SEÇÃO LOGS ======================== */
function LogsSection() {
  const { getLogs } = useAuth()
  const logs = getLogs()

  return (
    <section className="panel">
      <div className="panel-header compact">
        <div>
          <span className="eyebrow">Auditoria</span>
          <h3>Histórico de ações ({logs.length})</h3>
        </div>
      </div>

      <div style={{ maxHeight: '600px', overflowY: 'auto' }}>
        {logs.map((log) => (
          <div key={log.id} className="invoice-item" style={{ marginBottom: '6px', padding: '8px', background: '#f8fafc', borderRadius: '8px' }}>
            <div>
              <strong>{log.acao}</strong>
              <small style={{ display: 'block', color: '#64748b' }}>{log.detalhe}</small>
            </div>
            <small style={{ color: '#94a3b8', whiteSpace: 'nowrap' }}>
              {log.usuario} · {log.data}
            </small>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ======================== SEÇÃO RELATÓRIOS ======================== */
function RelatoriosSection() {
  const { getClientes, getFaturas } = useAuth()
  const clientes = getClientes()
  const faturas = getFaturas()

  const dadosCSV = () => {
    const header = 'Cliente;CPF/CNPJ;Referência;UC;Valor Original;Energia;Desconto 20%;Impostos;Valor Final;Consumo (kWh);Status;Vencimento'
    const rows = faturas.map((f) => {
      const cliente = clientes.find((c) => c.id === f.clienteId)
      const calc = f.calculo || {}
      return [
        cliente?.nome || f.clienteNome || '',
        cliente?.cpfCnpj || '',
        f.referencia || '',
        f.uc || '',
        f.valorTotal || '',
        calc.valorElegivel || '',
        calc.valorDesconto || '',
        calc.impostosTributosEncargos || '',
        calc.valorFinal || '',
        f.consumo || '',
        f.status || '',
        f.vencimento || '',
      ].join(';')
    })
    return [header, ...rows].join('\n')
  }

  const exportarCSV = () => {
    const blob = new Blob([dadosCSV()], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `relatorio-faturas-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
  }

  // Resumo por mês
  const porReferencia = faturas.reduce((acc, f) => {
    const key = f.referencia || 'N/A'
    if (!acc[key]) acc[key] = { total: 0, valor: 0, consumo: 0, desconto: 0 }
    acc[key].total++
    acc[key].valor += f.valorTotal || 0
    acc[key].consumo += f.consumo || 0
    acc[key].desconto += f.calculo?.valorDesconto || 0
    return acc
  }, {})

  return (
    <section className="panel">
      <div className="panel-header compact">
        <div>
          <span className="eyebrow">Relatórios</span>
          <h3>Resumo por competência</h3>
        </div>
        <button type="button" className="primary-button" onClick={exportarCSV}>
          ⬇ Exportar CSV
        </button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
              <th style={{ padding: '8px' }}>Competência</th>
              <th style={{ padding: '8px' }}>Faturas</th>
              <th style={{ padding: '8px' }}>Valor total</th>
              <th style={{ padding: '8px' }}>Desconto 20%</th>
              <th style={{ padding: '8px' }}>Consumo total (kWh)</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(porReferencia)
              .sort()
              .reverse()
              .map(([ref, data]) => (
                <tr key={ref} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '8px' }}>{ref}</td>
                  <td style={{ padding: '8px' }}>{data.total}</td>
                  <td style={{ padding: '8px' }}>{formatCurrency(data.valor)}</td>
                  <td style={{ padding: '8px' }}>{formatCurrency(data.desconto)}</td>
                  <td style={{ padding: '8px' }}>{data.consumo} kWh</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: '24px' }}>
        <h4>Resumo geral</h4>
        <div className="summary-grid">
          <div className="summary-card">
            <span>Clientes cadastrados</span>
            <strong>{clientes.length}</strong>
          </div>
          <div className="summary-card">
            <span>Faturas no sistema</span>
            <strong>{faturas.length}</strong>
          </div>
          <div className="summary-card">
            <span>Valor total</span>
            <strong>{formatCurrency(faturas.reduce((a, f) => a + (f.valorTotal || 0), 0))}</strong>
          </div>
          <div className="summary-card">
            <span>Desconto total (20%)</span>
            <strong>{formatCurrency(faturas.reduce((a, f) => a + (f.calculo?.valorDesconto || 0), 0))}</strong>
          </div>
        </div>
      </div>
    </section>
  )
}