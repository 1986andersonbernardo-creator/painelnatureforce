import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { LoginCliente, LoginAdmin, ProtectedRoute } from './pages/Login'

// Os dois painéis são carregados sob demanda: assim o pdf.js (~1,8 MB) e as
// telas administrativas saem do bundle inicial — quem apenas abre a tela de
// login não baixa o processador de PDF.
const AdminDashboard = lazy(() =>
  import('./pages/admin/AdminDashboard').then((m) => ({ default: m.AdminDashboard })),
)
const ClienteDashboard = lazy(() =>
  import('./pages/cliente/ClienteDashboard').then((m) => ({ default: m.ClienteDashboard })),
)

function Carregando() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <div style={{ textAlign: 'center', color: '#64748b' }}>
        <div className="loading-spinner" style={{ margin: '0 auto 16px' }} />
        <p>Carregando...</p>
      </div>
    </div>
  )
}

function App() {
  return (
    <Suspense fallback={<Carregando />}>
      <Routes>
        {/* Rotas de login */}
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<LoginCliente />} />
        <Route path="/admin/login" element={<LoginAdmin />} />

        {/* Área administrativa */}
        <Route
          path="/admin/dashboard"
          element={
            <ProtectedRoute tipo="admin">
              <AdminDashboard />
            </ProtectedRoute>
          }
        />

        {/* Área do cliente */}
        <Route
          path="/cliente/dashboard"
          element={
            <ProtectedRoute tipo="cliente">
              <ClienteDashboard />
            </ProtectedRoute>
          }
        />

        {/* Rota inexistente */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </Suspense>
  )
}

export default App