import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import './App.css'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext'
import { migrarCacheLocal } from './store/db'

// Prepara o cache local: remove legados de demonstração (mocks) e normaliza
// campos antigos. NÃO cria dados fictícios — o Firestore é a fonte da verdade
// e, se o banco central estiver vazio, o sistema exibe estado vazio.
migrarCacheLocal()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)