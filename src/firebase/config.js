// ==================== Configuração do Firebase ====================
// Credenciais públicas do SDK Web — seguras para o frontend.
// As permissões de acesso são protegidas pelas Firestore Security Rules.

import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyBLC1hYzeOuQcNfkKWqWDKZQ5ekUTedaYg',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'natureforce-65cdc.firebaseapp.com',
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || 'https://natureforce-65cdc-default-rtdb.firebaseio.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'natureforce-65cdc',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'natureforce-65cdc.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '929576581876',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:929576581876:web:d3768e269d78d9643efca1',
}

// Exportado para permitir uma instância SECUNDÁRIA do Firebase (criação da
// conta do cliente sem encerrar a sessão do administrador — ver auth.js).
export { firebaseConfig }

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)
export default app