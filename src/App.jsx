import { Navigate, Route, Routes } from 'react-router-dom'
import { LoginCliente, LoginAdmin, ProtectedRoute } from './pages/Login'
import { AdminDashboard } from './pages/admin/AdminDashboard'
import { ClienteDashboard } from './pages/cliente/ClienteDashboard'

function App() {
  return (
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
  )
}

export default App