import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { recuperarSenha } from '../firebase/auth'
import logo from '../assets/logo.png'

export function LoginLayout({ children }) {
  return (
    <div className="login-page">
      <div className="login-visual">
        <div className="brand-block large">
          <img src={logo} alt="Nature Force" className="brand-mark" />
          <div>
            <strong>Nature Force</strong>
            <small>Área do cliente</small>
          </div>
        </div>

        <div className="hero-copy">
          <span className="eyebrow light">Energia inteligente</span>
          <h1>Seu consumo, economia e faturas em um só lugar.</h1>
          <p>
            Acompanhe sua unidade consumidora, monitore a geração e acompanhe cada detalhe da sua conta com clareza.
          </p>
        </div>

        <ul className="feature-list">
          <li>Consumo em tempo real</li>
          <li>Economia detalhada</li>
          <li>Financeiro e faturas</li>
          <li>Atendimento rápido</li>
        </ul>
      </div>

      <div className="login-card-wrap">{children}</div>
    </div>
  )
}

export function LoginCliente() {
  const { loginCliente } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({
    identifier: 'marina@natureforce.com',
    password: '123456',
  })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [recuperandoSenha, setRecuperandoSenha] = useState(false)
  const [mensagemRecuperacao, setMensagemRecuperacao] = useState('')

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setLoading(true)
    const result = await loginCliente(form.identifier, form.password)
    setLoading(false)
    if (result.ok) {
      navigate('/cliente/dashboard')
    } else {
      setError(result.message)
    }
  }

  const handleRecuperarSenha = async () => {
    setError('')
    setMensagemRecuperacao('')
    setRecuperandoSenha(true)

    if (!form.identifier.trim()) {
      setError('Digite seu e-mail para recuperar a senha.')
      setRecuperandoSenha(false)
      return
    }

    const resultado = await recuperarSenha(form.identifier.trim())
    setRecuperandoSenha(false)

    if (resultado.ok) {
      setMensagemRecuperacao(resultado.message)
    } else {
      setError(resultado.message)
    }
  }

  return (
    <LoginLayout>
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="brand-block">
          <img src={logo} alt="Nature Force" className="brand-mark" />
          <div>
            <strong>Nature Force</strong>
            <small>Login do cliente</small>
          </div>
        </div>

        <h2>Bem-vindo de volta</h2>

        <label className="field">
          <span>E-mail de acesso</span>
          <input
            type="text"
            value={form.identifier}
            onChange={(event) =>
              setForm((current) => ({ ...current, identifier: event.target.value }))
            }
            placeholder="Digite seu e-mail"
          />
        </label>

        <label className="field">
          <span>Senha</span>
          <input
            type="password"
            value={form.password}
            onChange={(event) =>
              setForm((current) => ({ ...current, password: event.target.value }))
            }
            placeholder="Digite sua senha"
          />
        </label>

        {error ? <p className="login-error">{error}</p> : null}
        {mensagemRecuperacao ? (
          <p style={{ color: '#166534', background: '#f0fdf4', padding: '10px', borderRadius: '8px' }}>
            {mensagemRecuperacao}
          </p>
        ) : null}

        <button type="submit" className="primary-button large-btn" disabled={loading}>
          {loading ? 'Entrando...' : 'Entrar'}
        </button>

        <button
          type="button"
          className="secondary-button"
          onClick={handleRecuperarSenha}
          disabled={recuperandoSenha}
        >
          {recuperandoSenha ? 'Enviando...' : 'Recuperar senha'}
        </button>

        <Link to="/admin/login" className="auth-switch-link">
          Acessar área administrativa
        </Link>
      </form>
    </LoginLayout>
  )
}

export function LoginAdmin() {
  const { loginAdmin } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({
    email: 'admin@natureforce.com',
    password: 'admin123',
  })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setLoading(true)
    // loginAdmin autentica no Firebase (async) — é obrigatório aguardar.
    const result = await loginAdmin(form.email, form.password)
    setLoading(false)
    if (result.ok) {
      navigate('/admin/dashboard')
    } else {
      setError(result.message || 'Não foi possível entrar. Tente novamente.')
    }
  }

  return (
    <LoginLayout>
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="brand-block">
          <img src={logo} alt="Nature Force" className="brand-mark" />
          <div>
            <strong>Nature Force</strong>
            <small>Administração</small>
          </div>
        </div>

        <h2>Acesso administrativo</h2>

        <label className="field">
          <span>E-mail</span>
          <input
            type="text"
            value={form.email}
            onChange={(event) =>
              setForm((current) => ({ ...current, email: event.target.value }))
            }
            placeholder="admin@natureforce.com"
          />
        </label>

        <label className="field">
          <span>Senha</span>
          <input
            type="password"
            value={form.password}
            onChange={(event) =>
              setForm((current) => ({ ...current, password: event.target.value }))
            }
            placeholder="Digite sua senha"
          />
        </label>

        {error ? <p className="login-error">{error}</p> : null}

        <button type="submit" className="primary-button large-btn" disabled={loading}>
          {loading ? 'Entrando...' : 'Entrar'}
        </button>

        <Link to="/login" className="auth-switch-link">
          Voltar ao login do cliente
        </Link>
      </form>
    </LoginLayout>
  )
}

export function ProtectedRoute({ children, tipo }) {
  const { session, authLoading } = useAuth()

  // Aguarda a verificação da sessão Firebase
  if (authLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center', color: '#64748b' }}>
          <div className="loading-spinner" style={{ margin: '0 auto 16px' }} />
          <p>Verificando sessão...</p>
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="login-card-wrap" style={{ margin: '40px auto' }}>
        <div className="login-card" style={{ minWidth: '320px' }}>
          <h2>Acesso restrito</h2>
          <p style={{ color: '#64748b', margin: '12px 0' }}>
            Você precisa estar logado para acessar esta página.
          </p>
          <Link to={tipo === 'admin' ? '/admin/login' : '/login'} className="primary-button large-btn" style={{ textAlign: 'center', textDecoration: 'none' }}>
            Fazer login
          </Link>
        </div>
      </div>
    )
  }

  if (tipo && session.tipo !== tipo) {
    return (
      <div className="login-card-wrap" style={{ margin: '40px auto' }}>
        <div className="login-card" style={{ minWidth: '320px' }}>
          <h2>Acesso negado</h2>
          <p style={{ color: '#64748b', margin: '12px 0' }}>
            Você não tem permissão para acessar esta área.
          </p>
          <Link
            to={session.tipo === 'admin' ? '/admin/dashboard' : '/cliente/dashboard'}
            className="primary-button large-btn"
            style={{ textAlign: 'center', textDecoration: 'none' }}
          >
            Ir para minha área
          </Link>
        </div>
      </div>
    )
  }

  return children
}