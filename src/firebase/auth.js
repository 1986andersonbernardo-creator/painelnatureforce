// ==================== Serviços de Autenticação Firebase ====================
import {
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  onAuthStateChanged,
} from 'firebase/auth'
import { auth } from './config'

// Login com e-mail e senha
export const loginComEmail = async (email, senha) => {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, senha)
    return { ok: true, user: userCredential.user }
  } catch (error) {
    let message = 'Erro ao fazer login. Tente novamente.'
    switch (error.code) {
      case 'auth/invalid-credential':
      case 'auth/user-not-found':
      case 'auth/wrong-password':
        message = 'Credenciais inválidas. Verifique e-mail e senha.'
        break
      case 'auth/invalid-email':
        message = 'E-mail inválido. Verifique o formato.'
        break
      case 'auth/user-disabled':
        message = 'Sua conta está desativada. Contate o suporte.'
        break
      case 'auth/too-many-requests':
        message = 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
        break
      case 'auth/network-request-failed':
        message = 'Sem conexão com a internet. Verifique sua rede.'
        break
      default:
        message = error.message || message
    }
    return { ok: false, message }
  }
}

// Logout
export const logoutFirebase = async () => {
  try {
    await signOut(auth)
    return { ok: true }
  } catch {
    return { ok: false, message: 'Erro ao sair da conta.' }
  }
}

// Recuperar senha
export const recuperarSenha = async (email) => {
  try {
    await sendPasswordResetEmail(auth, email)
    return { ok: true, message: 'E-mail de recuperação enviado. Verifique sua caixa de entrada.' }
  } catch (error) {
    let message = 'Erro ao enviar e-mail de recuperação.'
    if (error.code === 'auth/user-not-found') {
      message = 'Nenhuma conta encontrada com este e-mail.'
    } else if (error.code === 'auth/invalid-email') {
      message = 'E-mail inválido.'
    } else if (error.code === 'auth/network-request-failed') {
      message = 'Sem conexão com a internet.'
    }
    return { ok: false, message }
  }
}

// Observador de estado de autenticação
export const observarAuth = (callback) => {
  return onAuthStateChanged(auth, callback)
}

// Usuário atual
export const getUsuarioAtual = () => auth.currentUser