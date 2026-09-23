import { useState, useEffect } from 'react'
import { useAuth } from '../../context/AuthContext'
import { obterArquivo, getStore, setStore } from '../../store/db'
import logo from '../../assets/logo.png'
// Isolamento: SOMENTE as faturas deste cliente (id local, UID ou UCs dele).
import { filtrarFaturasDoCliente } from '../../services/persistencia'
import {
  criarChamado,
  atualizarCliente,
  observarFaturasDoCliente,
  observarUnidadesDoCliente,
  observarClientePorUid,
  observarChamadosDoCliente,
} from '../../firebase/firestore'

const formatCurrency = (value) =>
  new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value)

export function ClienteDashboard() {
  const { session, logout, getClientes, getFaturas, getUnidades } = useAuth()
  const [activeMenu, setActiveMenu] = useState('dashboard')
  const [menuOpen, setMenuOpen] = useState(false)
  const [ticket, setTicket] = useState('')
  const [ticketEnviado, setTicketEnviado] = useState(false)
  const [dadosCadastro, setDadosCadastro] = useState(null)
  const [salvo, setSalvo] = useState(false)
  const [loading, setLoading] = useState(true)
  const [erroDados, setErroDados] = useState('')
  const [erroSalvamento, setErroSalvamento] = useState('')
  const [erroTicket, setErroTicket] = useState('')
  const [faturasFirestore, setFaturasFirestore] = useState([])
  const [unidadesFirestore, setUnidadesFirestore] = useState([])
  const [chamadosFirestore, setChamadosFirestore] = useState([])
  const [clienteFirestore, setClienteFirestore] = useState(null)

  const uid = session?.uid || session?.clienteId

  // UID da sessão FIREBASE. Uma sessão local (fallback offline, login contra o
  // cadastro do cache) NÃO tem uid: o Firestore negaria as leituras e a tela
  // viraria "Erro ao buscar faturas" em vez de mostrar o cache local. Por isso
  // os observadores só são iniciados quando há sessão no Firebase.
  const uidFirebase = session?.uid || ''

  // ==================== Sincronização em tempo real ====================
  // onSnapshot: o que o administrador alterar (em qualquer dispositivo) chega
  // aqui automaticamente, sem recarregar a página. O Firestore é a FONTE DA
  // VERDADE; o cache local é fallback apenas para sessões sem Firebase.
  useEffect(() => {
    // Sessão SEM Firebase: usa somente o cache local (fallback offline) e não
    // tenta consultar o banco — antes a tentativa era negada pelas regras e a
    // tela inteira ficava bloqueada em um erro de carregamento.
    if (!uidFirebase) {
      setLoading(false)
      setErroDados('')
      return undefined
    }

    setErroDados('')
    setLoading(true)

    const desobservarFaturas = observarFaturasDoCliente(uidFirebase, (resultado) => {
      if (resultado.ok) setFaturasFirestore(resultado.data)
      else setErroDados(resultado.message || 'Não foi possível carregar suas faturas.')
      setLoading(false)
    })

    const desobservarUnidades = observarUnidadesDoCliente(uidFirebase, (resultado) => {
      if (resultado.ok) setUnidadesFirestore(resultado.data)
    })

    // Perfil: reflete no ato as alterações feitas pelo administrador em outro
    // dispositivo (antes, o cadastro era lido uma única vez no carregamento).
    const desobservarCliente = observarClientePorUid(uidFirebase, (resultado) => {
      if (resultado.ok) setClienteFirestore(resultado.data)
    })

    // Chamados em tempo real: quando o administrador atualiza o status do
    // pedido, o cliente vê a mudança sem recarregar a página.
    const desobservarChamados = observarChamadosDoCliente(uidFirebase, (resultado) => {
      if (resultado.ok) setChamadosFirestore(resultado.data)
    })

    return () => {
      desobservarFaturas()
      desobservarUnidades()
      desobservarCliente()
      desobservarChamados()
    }
  }, [uidFirebase])

  // ===== FONTE DA VERDADE: banco central (Firestore) =====
  // O cache local é usado APENAS quando a sessão não tem Firebase (login
  // local) — nunca é apresentado como se fosse o dado compartilhado.
  const todosClientes = getClientes()
  const todasFaturas = getFaturas()
  const todasUnidades = getUnidades()

  const clientePadrao = {
    id: uid,
    nome: session?.nome || 'Cliente',
    email: session?.email || '',
    emailAcesso: session?.email || '',
    cpfCnpj: '',
    telefone: '',
    endereco: '',
    cidade: '',
    estado: '',
    cep: '',
    whatsapp: '',
  }

  const cliente =
    clienteFirestore ||
    (uid
      ? todosClientes.find(
          (c) => String(c.uid || '') === String(uid) || String(c.id) === String(uid),
        )
      : todosClientes.find((c) => c.id === session?.clienteId)) ||
    clientePadrao

  const faturasBase = uidFirebase ? faturasFirestore : todasFaturas
  const unidadesBase = uidFirebase ? unidadesFirestore : todasUnidades

  // Unidades deste cliente: UID na sessão Firebase, id local na sessão offline
  // (clienteIdLocal cobre o vínculo anterior à ponte de identidade).
  const unidades = unidadesBase.filter(
    (u) => String(u.clienteId) === String(uid) || String(u.clienteIdLocal) === String(uid),
  )

  // Faturas apenas deste cliente (isolamento por id local, UID ou UCs dele) e
  // já PUBLICADAS pelo administrador (status = 'disponivel').
  const faturas = filtrarFaturasDoCliente({
    faturas: faturasBase,
    clienteId: uid,
    uids: uidFirebase ? [uidFirebase] : [],
    ucs: unidades.map((u) => u.numeroUC),
  }).filter((f) => f.status === 'disponivel')

  // Métricas do cliente
  const consumoAtual = faturas[0]?.consumo || 0
  const consumoTotal = faturas.reduce((acc, f) => acc + (f.consumo || 0), 0)
  // Economia = 20% sobre a parcela elegível (energia + TUSD + TE)
  const economiaMes = faturas[0]?.calculo?.valorDesconto || (faturas[0]?.valorTotal || 0) * 0.2
  const economiaTotal = faturas.reduce(
    (acc, f) => acc + (f.calculo?.valorDesconto || (f.valorTotal || 0) * 0.2),
    0,
  )
  const faturaEmAberto = faturas.find((f) => {
    if (!f.vencimento) return false
    const venc = new Date(f.vencimento)
    return venc > new Date()
  })
  const proximoVencimento = faturaEmAberto?.vencimento
    ? new Date(faturaEmAberto.vencimento).toLocaleDateString('pt-BR')
    : 'Nenhuma em aberto'

  // Consumo mensal (últimas 8 faturas)
  const consumoMensal = [...faturas]
    .sort((a, b) => (a.referencia < b.referencia ? 1 : -1))
    .slice(0, 8)
    .reverse()
    .map((f) => ({
      mes: (f.referencia || 'N/A').replace('2026-', '').replace('2025-', ''),
      valor: f.consumo || 0,
    }))

  // Escala do gráfico: relativa ao MAIOR consumo do período. Uma escala fixa
  // (500 kWh) deixava barras invisíveis com consumos baixos e "saturadas" nos
  // altos, sem relação com os dados reais.
  const maiorConsumo = Math.max(1, ...consumoMensal.map((item) => item.valor))

  const menuItems = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'faturas', label: 'Faturas' },
    { id: 'consumo', label: 'Consumo' },
    { id: 'economia', label: 'Economia' },
    { id: 'financeiro', label: 'Financeiro' },
    { id: 'atendimento', label: 'Atendimento' },
    { id: 'cadastro', label: 'Meu Cadastro' },
  ]

  const salvarCadastro = async () => {
    const dados = dadosCadastro || cliente
    setErroSalvamento('')

    const campos = {
      nome: dados.nome,
      telefone: dados.telefone,
      email: dados.email,
      endereco: dados.endereco,
      cidade: dados.cidade,
      estado: dados.estado,
      cep: dados.cep,
      whatsapp: dados.whatsapp,
    }

    // ===== 1. Banco central (fonte da verdade) — apenas com sessão Firebase =====
    // Numa sessão local o Firestore negaria a escrita (não há autenticação).
    if (uidFirebase) {
      const resultado = await atualizarCliente(uidFirebase, campos)
      if (!resultado.ok) {
        setErroSalvamento(
          resultado.message ||
            'Não foi possível salvar no banco central. Verifique sua conexão e tente novamente.',
        )
        setTimeout(() => setErroSalvamento(''), 8000)
        return
      }
      setClienteFirestore((atual) => ({ ...(atual || cliente), ...campos }))
    }

    // ===== 2. Espelha no cache local (sobrevive a reload e cobre a sessão offline) =====
    const clientes = getStore('clientes')
    if (clientes.some((c) => String(c.id) === String(cliente.id))) {
      setStore(
        'clientes',
        clientes.map((c) => (String(c.id) === String(cliente.id) ? { ...c, ...campos } : c)),
      )
    }

    setSalvo(true)
    setTimeout(() => setSalvo(false), 3000)
  }

  const enviarTicket = async (e) => {
    e.preventDefault()
    if (!ticket.trim()) return
    setErroTicket('')

    // Sessão local (sem Firebase): a escrita seria negada pelas regras —
    // avisamos em vez de mostrar um erro genérico depois do envio.
    if (!uidFirebase) {
      setErroTicket(
        'O envio de solicitações exige conexão com o banco central. Entre novamente com acesso à internet.',
      )
      setTimeout(() => setErroTicket(''), 8000)
      return
    }

    // O nome/e-mail vão junto: sem eles o administrador não identificava de
    // quem era a solicitação (só um identificador técnico).
    const resultado = await criarChamado(uidFirebase, {
      assunto: ticket.trim(),
      clienteNome: cliente.nome || session?.nome || '',
      clienteEmail: cliente.email || session?.email || '',
    })
    if (!resultado.ok) {
      // SEM fallback silencioso: o cliente precisa saber que a solicitação
      // NÃO chegou ao banco central.
      setErroTicket(
        resultado.message || 'Não foi possível enviar a solicitação. Tente novamente.',
      )
      setTimeout(() => setErroTicket(''), 8000)
      return
    }

    setTicketEnviado(true)
    setTicket('')
    setTimeout(() => setTicketEnviado(false), 5000)
  }

  const renderContent = () => {
    // Estado de carregamento
    if (loading) {
      return (
        <section className="panel">
          <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
            <div className="loading-spinner" style={{ margin: '0 auto 16px' }} />
            <p>Carregando seus dados...</p>
          </div>
        </section>
      )
    }

    // Estado de erro
    if (erroDados) {
      return (
        <section className="panel">
          <div style={{ padding: '40px', textAlign: 'center' }}>
            <p style={{ color: '#dc2626', marginBottom: '12px' }}>{erroDados}</p>
            <button
              type="button"
              className="primary-button"
              onClick={() => window.location.reload()}
            >
              Tentar novamente
            </button>
          </div>
        </section>
      )
    }

    /* ==================== DASHBOARD ==================== */
    if (activeMenu === 'dashboard') {
      return (
        <>
          <section className="panel highlight-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Resumo da conta</span>
                <h2>Olá, {cliente.nome.split(' ')[0]}</h2>
              </div>
              <span className="status-pill success">Conta em dia</span>
            </div>

            <div className="stats-grid">
              <article className="stat-card primary">
                <span>Consumo atual</span>
                <strong>{consumoAtual} kWh</strong>
                <small>Última fatura disponível</small>
              </article>
              <article className="stat-card success">
                <span>Economia do mês</span>
                <strong>{formatCurrency(economiaMes)}</strong>
                <small>20% de desconto</small>
              </article>
              <article className="stat-card accent">
                <span>Economia acumulada</span>
                <strong>{formatCurrency(economiaTotal)}</strong>
                <small>Desde a contratação</small>
              </article>
              <article className="stat-card warning">
                <span>Próximo vencimento</span>
                <strong>{proximoVencimento}</strong>
                <small>{faturaEmAberto ? 'Fatura em aberto' : 'Tudo quitado'}</small>
              </article>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header compact">
              <div>
                <span className="eyebrow">Consumo</span>
                <h3>Consumo mensal</h3>
              </div>
              <span className="status-pill neutral">Últimas faturas</span>
            </div>

            {consumoMensal.length > 0 ? (
              <div className="bar-chart">
                {consumoMensal.map((item) => (
                  <div key={item.mes} className="bar-group">
                    <span className="bar-value">{item.valor} kWh</span>
                    <div className="bar-track">
                      <span style={{ height: `${Math.min((item.valor / maiorConsumo) * 100, 100)}%` }} />
                    </div>
                    <strong>{item.mes}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ color: '#64748b', padding: '12px 0' }}>
                Nenhuma fatura publicada para você ainda.
              </p>
            )}
          </section>

          <section className="panel">
            <div className="panel-header compact">
              <div>
                <span className="eyebrow">Unidades consumidoras</span>
                <h3>Minhas UCs</h3>
              </div>
            </div>

            {unidades.length > 0 ? (
              <div className="info-grid">
                {unidades.map((uc) => (
                  <article key={uc.id} className="info-card">
                    <span>UC {uc.numeroUC}</span>
                    <strong>{uc.codigoInstalacao}</strong>
                    <small style={{ color: '#64748b' }}>
                      {uc.nomeConcessionaria || '—'} · {uc.tipoFornecimento || '—'}
                    </small>
                  </article>
                ))}
              </div>
            ) : (
              <p style={{ color: '#64748b', padding: '12px 0' }}>
                Nenhuma unidade consumidora vinculada.
              </p>
            )}
          </section>
        </>
      )
    }

    /* ==================== FATURAS ==================== */
    if (activeMenu === 'faturas') {
      return (
        <section className="panel">
          <div className="panel-header compact">
            <div>
              <span className="eyebrow">Cobrança</span>
              <h3>Minhas faturas ({faturas.length})</h3>
            </div>
          </div>

          {faturas.length === 0 ? (
            <p style={{ color: '#64748b', padding: '16px 0' }}>
              Nenhuma fatura disponível no momento.
            </p>
          ) : (
            <div className="invoice-list">
              {[...faturas]
                .sort((a, b) => (a.referencia < b.referencia ? 1 : -1))
                .map((fat) => {
                  const calc = fat.calculo
                  const comp = fat.componentes || {}
                  return (
                    <div key={fat.id} className="invoice-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 24px' }}>
                        <div style={{ flex: 1 }}>
                          <strong>{fat.arquivo}</strong>
                          <small>
                            Referência: {(fat.referencia || 'N/A').replace('2026-', '').replace('2025-', '')}
                          </small>
                          <small>Vencimento: {fat.vencimento ? new Date(fat.vencimento).toLocaleDateString('pt-BR') : '—'}</small>
                          <small>UC: {fat.uc || '—'} · Consumo: {fat.consumo ? `${fat.consumo} kWh` : '—'}</small>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <strong>{formatCurrency(calc?.valorFinal || fat.valorTotal || 0)}</strong>
                          <small className="tag tag-success">Disponível</small>
                        </div>
                        <div className="invoice-actions">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const data = await obterArquivo(fat.id)
                                if (data) {
                                  window.open(data, '_blank')
                                } else {
                                  alert(
                                    'O PDF original não está disponível neste dispositivo. O arquivo é guardado no navegador do computador que importou a fatura (os dados da fatura em si estão no banco central). Solicite o PDF pelo atendimento.',
                                  )
                                }
                              } catch {
                                alert('Arquivo não encontrado neste dispositivo.')
                              }
                            }}
                          >
                            Visualizar PDF
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const data = await obterArquivo(fat.id)
                                if (data) {
                                  const link = document.createElement('a')
                                  link.href = data
                                  link.download = fat.arquivo || 'fatura.pdf'
                                  link.click()
                                } else {
                                  alert(
                                    'O PDF original não está disponível neste dispositivo: ele é guardado no navegador do computador que importou a fatura. Solicite o PDF pelo atendimento.',
                                  )
                                }
                              } catch {
                                alert('Arquivo não encontrado.')
                              }
                            }}
                          >
                            Baixar
                          </button>
                        </div>
                      </div>

                      {/* Detalhamento transparente do cálculo */}
                      {calc && calc.ok ? (
                        <div style={{ background: '#f8fafc', borderRadius: '8px', padding: '12px', border: '1px solid #e2e8f0' }}>
                          <strong style={{ fontSize: '13px', color: '#0f172a', display: 'block', marginBottom: '8px' }}>
                            💡 Como foi calculado
                          </strong>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '8px', fontSize: '13px' }}>
                            <div>
                              <small style={{ color: '#64748b' }}>Valor da energia (elegível)</small>
                              <strong style={{ display: 'block' }}>{formatCurrency(calc.valorElegivel)}</strong>
                              <small style={{ color: '#64748b' }}>
                                Energia: {comp.energia ? formatCurrency(comp.energia) : '—'}
                                {comp.tusd ? ` · TUSD: ${formatCurrency(comp.tusd)}` : ''}
                                {comp.te ? ` · TE: ${formatCurrency(comp.te)}` : ''}
                              </small>
                            </div>
                            <div>
                              <small style={{ color: '#64748b' }}>Desconto Nature Force</small>
                              <strong style={{ display: 'block', color: '#166534' }}>{Math.round(calc.percentualDesconto * 100)}%</strong>
                              <strong style={{ display: 'block', color: '#166534' }}>− {formatCurrency(calc.valorDesconto)}</strong>
                            </div>
                            <div>
                              <small style={{ color: '#64748b' }}>Impostos/tributos/encargos</small>
                              <strong style={{ display: 'block' }}>{formatCurrency(calc.impostosTributosEncargos)}</strong>
                              <small style={{ color: '#64748b' }}>
                                {comp.icms ? `ICMS: ${formatCurrency(comp.icms)}` : ''}
                                {comp.pis ? ` · PIS: ${formatCurrency(comp.pis)}` : ''}
                                {comp.cofins ? ` · COFINS: ${formatCurrency(comp.cofins)}` : ''}
                                {comp.encargos ? ` · Encargos: ${formatCurrency(comp.encargos)}` : ''}
                              </small>
                            </div>
                            <div style={{ background: '#f0fdf4', borderRadius: '6px', padding: '8px' }}>
                              <small style={{ color: '#166534' }}>Valor final devido</small>
                              <strong style={{ display: 'block', color: '#166534', fontSize: '16px' }}>{formatCurrency(calc.valorFinal)}</strong>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div style={{ background: '#fffbeb', borderRadius: '8px', padding: '12px', border: '1px solid #fde68a' }}>
                          <strong style={{ fontSize: '13px', color: '#b45309', display: 'block', marginBottom: '4px' }}>
                            ⚠️ {fat.status === 'requer revisão' ? 'Fatura requer revisão administrativa' : 'Cálculo não disponível'}
                          </strong>
                          {fat.validacao?.erros?.length > 0 && (
                            <small style={{ color: '#b45309' }}>{fat.validacao.erros.join('; ')}</small>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
            </div>
          )}
        </section>
      )
    }

    /* ==================== CONSUMO ==================== */
    if (activeMenu === 'consumo') {
      // Indicadores derivados APENAS de dados reais das faturas. Os números
      // antigos (consumo × 0,62) não tinham base no sistema e apresentavam ao
      // cliente uma grandeza inexistente.
      const mediaPorFatura = faturas.length > 0 ? Math.round(consumoTotal / faturas.length) : 0
      const comparativo = consumoMensal.length >= 2
        ? ((consumoMensal[consumoMensal.length - 1].valor - consumoMensal[consumoMensal.length - 2].valor) /
            consumoMensal[consumoMensal.length - 2].valor) * 100
        : 0

      return (
        <section className="panel">
          <div className="panel-header compact">
            <div>
              <span className="eyebrow">Acompanhamento</span>
              <h3>Consumo</h3>
            </div>
          </div>

          <div className="summary-grid">
            <div className="summary-card">
              <span>Média por fatura</span>
              <strong>{mediaPorFatura} kWh</strong>
            </div>
            <div className="summary-card">
              <span>Consumo total</span>
              <strong>{consumoTotal} kWh</strong>
            </div>
            <div className="summary-card">
              <span>Comparativo</span>
              <strong>{comparativo >= 0 ? '+' : ''}{comparativo.toFixed(1)}%</strong>
            </div>
          </div>

          <div className="line-mockup" aria-label="Gráfico de consumo" />
        </section>
      )
    }

    /* ==================== ECONOMIA ==================== */
    if (activeMenu === 'economia') {
      // Percentual REAL: economia acumulada sobre o total elegível faturado
      // (energia + TUSD + TE, o que de fato recebe 20%). O divisor antigo
      // (consumo × 0,45) era uma constante inventada e o número exibido não
      // correspondia a nenhum valor do sistema.
      const totalElegivel = faturas.reduce((acc, f) => acc + (f.calculo?.valorElegivel || 0), 0)
      const percentual = totalElegivel > 0 ? Math.round((economiaTotal / totalElegivel) * 100) : 0

      return (
        <section className="panel">
          <div className="panel-header compact">
            <div>
              <span className="eyebrow">Indicadores</span>
              <h3>Minha Economia</h3>
            </div>
          </div>

          <div className="summary-grid">
            <div className="summary-card">
              <span>Economia do mês</span>
              <strong>{formatCurrency(economiaMes)}</strong>
            </div>
            <div className="summary-card">
              <span>Economia acumulada</span>
              <strong>{formatCurrency(economiaTotal)}</strong>
            </div>
            <div className="summary-card">
              <span>Percentual</span>
              <strong>{percentual}%</strong>
            </div>
          </div>

          <div className="line-mockup savings" aria-label="Gráfico de economia" />
        </section>
      )
    }

    /* ==================== FINANCEIRO ==================== */
    if (activeMenu === 'financeiro') {
      const ultimaFatura = faturas[0]
      // Não existe integração de pagamentos no sistema: os números abaixo são
      // VALORES FATURADOS (derivados do vencimento), não confirmações de
      // pagamento. Os rótulos dizem exatamente isso — antes aparecia "Total
      // pago", o que sugeria um histórico de recebimentos inexistente.
      const totalVencido = faturas
        .filter((f) => {
          if (!f.vencimento) return false
          return new Date(f.vencimento) < new Date()
        })
        .reduce((acc, f) => acc + (f.valorTotal || 0), 0)

      return (
        <section className="panel">
          <div className="panel-header compact">
            <div>
              <span className="eyebrow">Financeiro</span>
              <h3>Resumo financeiro</h3>
            </div>
          </div>

          <div className="info-grid finance-grid">
            <article className="info-card">
              <span>Última fatura</span>
              <strong>{formatCurrency(ultimaFatura?.valorTotal || 0)}</strong>
            </article>
            <article className="info-card">
              <span>Próximo vencimento</span>
              <strong>{proximoVencimento}</strong>
            </article>
            <article className="info-card">
              <span>Status</span>
              <strong>{faturaEmAberto ? 'Em aberto' : 'Em dia'}</strong>
            </article>
            <article className="info-card">
              <span>Faturas vencidas (soma)</span>
              <strong>{formatCurrency(totalVencido)}</strong>
            </article>
          </div>
        </section>
      )
    }

    /* ==================== ATENDIMENTO ==================== */
    if (activeMenu === 'atendimento') {
      const chamados = chamadosFirestore

      return (
        <section className="panel">
          <div className="panel-header compact">
            <div>
              <span className="eyebrow">Suporte</span>
              <h3>Atendimento</h3>
            </div>
            {/* Só oferece o atalho se o cliente tiver WhatsApp cadastrado:
                antes um número fictício era usado como padrão. */}
            {cliente.whatsapp?.replace(/\D/g, '') && (
              <a
                className="whatsapp-button"
                href={`https://wa.me/${cliente.whatsapp.replace(/\D/g, '')}`}
                target="_blank"
                rel="noreferrer"
              >
                WhatsApp
              </a>
            )}
          </div>

          <form onSubmit={enviarTicket} style={{ marginBottom: '20px' }}>
            <label className="field">
              <span>Assunto da solicitação</span>
              <input
                type="text"
                value={ticket}
                onChange={(e) => setTicket(e.target.value)}
                placeholder="Descreva o que precisa..."
              />
            </label>
            <button type="submit" className="primary-button" style={{ marginTop: '8px' }}>
              Enviar solicitação
            </button>
          </form>

          {erroTicket && (
            <p style={{ padding: '10px', background: '#fef2f2', color: '#b91c1c', borderRadius: '8px', marginBottom: '12px' }}>
              ⚠ {erroTicket}
            </p>
          )}

          {ticketEnviado && (
            <p style={{ padding: '10px', background: '#f0fdf4', color: '#166534', borderRadius: '8px' }}>
              Solicitação enviada! Nossa equipe retornará em breve.
            </p>
          )}

          <div className="support-list">
            {chamados.length > 0 ? (
              chamados.map((item) => (
                <div key={item.id} className="support-card">
                  <div>
                    <strong>{item.assunto}</strong>
                    <small>
                      {item.dataCriacao
                        ? new Date(item.dataCriacao).toLocaleDateString('pt-BR')
                        : 'Data não informada'}
                    </small>
                  </div>
                  <span className={`tag ${(item.status || 'aberto').toLowerCase().replace(/\s+/g, '-')}`}>
                    {item.status || 'aberto'}
                  </span>
                </div>
              ))
            ) : (
              <p style={{ color: '#64748b', padding: '12px 0' }}>
                Nenhum chamado registrado ainda.
              </p>
            )}
          </div>
        </section>
      )
    }

    /* ==================== MEU CADASTRO ==================== */
    if (activeMenu === 'cadastro') {
      const dados = dadosCadastro || cliente

      return (
        <section className="panel">
          <div className="panel-header compact">
            <div>
              <span className="eyebrow">Dados cadastrais</span>
              <h3>Meu Cadastro</h3>
            </div>
          </div>

          {erroSalvamento && (
            <p style={{ padding: '10px', background: '#fef2f2', color: '#b91c1c', borderRadius: '8px', marginBottom: '12px' }}>
              ⚠ {erroSalvamento}
            </p>
          )}

          {salvo && (
            <p style={{ padding: '10px', background: '#f0fdf4', color: '#166534', borderRadius: '8px', marginBottom: '12px' }}>
              Alterações salvas com sucesso!
            </p>
          )}

          <div className="profile-grid">
            <label className="field">
              <span>Nome completo</span>
              <input type="text" value={dados.nome} onChange={(e) => setDadosCadastro((d) => ({ ...(d || cliente), nome: e.target.value }))} />
            </label>
            <label className="field">
              <span>CPF/CNPJ</span>
              <input type="text" value={dados.cpfCnpj} disabled />
            </label>
            <label className="field">
              <span>Telefone</span>
              <input type="text" value={dados.telefone || ''} onChange={(e) => setDadosCadastro((d) => ({ ...(d || cliente), telefone: e.target.value }))} />
            </label>
            <label className="field">
              <span>E-mail</span>
              <input type="email" value={dados.email || ''} onChange={(e) => setDadosCadastro((d) => ({ ...(d || cliente), email: e.target.value }))} />
            </label>
            <label className="field">
              <span>Endereço</span>
              <input type="text" value={dados.endereco || ''} onChange={(e) => setDadosCadastro((d) => ({ ...(d || cliente), endereco: e.target.value }))} />
            </label>
            <label className="field">
              <span>Cidade</span>
              <input type="text" value={dados.cidade || ''} onChange={(e) => setDadosCadastro((d) => ({ ...(d || cliente), cidade: e.target.value }))} />
            </label>
            <label className="field">
              <span>Estado</span>
              <input type="text" value={dados.estado || ''} onChange={(e) => setDadosCadastro((d) => ({ ...(d || cliente), estado: e.target.value }))} />
            </label>
            <label className="field">
              <span>CEP</span>
              <input type="text" value={dados.cep || ''} onChange={(e) => setDadosCadastro((d) => ({ ...(d || cliente), cep: e.target.value }))} />
            </label>
            <label className="field">
              <span>WhatsApp</span>
              <input type="text" value={dados.whatsapp || ''} onChange={(e) => setDadosCadastro((d) => ({ ...(d || cliente), whatsapp: e.target.value }))} />
            </label>
            <label className="field">
              <span>E-mail de acesso (login) — definido pelo administrador</span>
              {/* Somente leitura: o e-mail de acesso é a credencial de entrada no
                  Firebase Authentication. Alterá-lo aqui não muda a conta real e
                  daria a sensação de sucesso sem efeito (campo era editável, mas
                  nunca era salvo). */}
              <input type="email" value={dados.emailAcesso || ''} disabled readOnly />
            </label>
          </div>

          <button type="button" className="primary-button" onClick={salvarCadastro}>
            Salvar alterações
          </button>
        </section>
      )
    }

    return null
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand-block sidebar-brand">
          <img src={logo} alt="Nature Force" className="brand-mark" />
          <div>
            <strong>Nature Force</strong>
            <small>Cliente</small>
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
            <span className="eyebrow">Bem-vindo, {cliente.nome.split(' ')[0]}</span>
            <h2>{menuItems.find((m) => m.id === activeMenu)?.label}</h2>
          </div>

          <button type="button" className="ghost-button" onClick={logout}>
            Sair
          </button>
        </header>

        {renderContent()}
      </main>
    </div>
  )
}