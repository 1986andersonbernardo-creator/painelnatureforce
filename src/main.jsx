import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import './App.css'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext'
import { seedData } from './store/db'

// Inicializa dados de demonstração
seedData()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)