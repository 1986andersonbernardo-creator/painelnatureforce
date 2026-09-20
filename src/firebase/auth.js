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

// ==================== Sessão Firebase do administrador ====================
// O login administrativo continua validando as credenciais na lista local
// (comportamento existente), mas TENTA obter uma sessão Firebase com as mesmas
// credenciais. Sem sessão Firebase o Firestore nega qualquer escrita
// (request.auth == null) — era essa a causa das alterações administrativas
// serem "salvas" e depois reaparecerem os dados antigos.
//
// Importante: esta função NUNCA cria contas (createUserWithEmailAndPassword);
// apenas entra com uma conta já provisionada no Firebase Authentication.
// @returns {{ok:boolean, user?:Object, claimAdmin?:boolean, motivo?:string, message?:string}}
export const entrarComoSessaoAdmin = async (email, senha) => {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email.trim(), senha)
    const usuario = userCredential.user

    // O perfil administrativo é dado pelo e-mail na lista de administradores
    // (mesma regra usada nas Firestore Security Rules) ou pelo custom claim.
    let claimAdmin = false
    try {
      const token = await usuario.getIdTokenResult()
      claimAdmin = token?.claims?.admin === true
    } catch {
      claimAdmin = false
    }

    return { ok: true, user: usuario, claimAdmin }
  } catch (error) {
    const motivo = error?.code || 'auth/erro-desconhecido'
    // Mensagem PRECISA para cada motivo — o administrador precisa saber o que
    // fazer (especialmente quando a conta ainda não existe no Firebase Auth).
    let message
    switch (motivo) {
      case 'auth/user-not-found':
        message =
          'Esta conta ainda NÃO existe no Firebase Authentication. Crie-a no Console do Firebase (Authentication → Users → Add user) com o MESMO e-mail e senha usados aqui.'
        break
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
        message =
          'A senha não corresponde à conta administrativa do Firebase. Atualize a senha no Console (Authentication → Users → redefinir) para a senha usada aqui.'
        break
      case 'auth/invalid-email':
        message = 'E-mail inválido. Verifique o formato.'
        break
      case 'auth/user-disabled':
        message = 'Esta conta está desativada no Firebase. Reative-a no Console (Authentication → Users).'
        break
      case 'auth/operation-not-allowed':
        message =
          'O provedor E-mail/Senha está DESATIVADO no Firebase. Ative em Authentication → Sign-in method → Email/Password.'
        break
      case 'auth/too-many-requests':
        message = 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
        break
      case 'auth/network-request-failed':
        message = 'Sem conexão com a internet. Verifique sua rede.'
        break
      case 'auth/invalid-api-key':
        message = 'Configuração do Firebase inválida (apiKey). Verifique as variáveis de ambiente.'
        break
      default:
        message = 'Erro ao autenticar no Firebase. Tente novamente.'
    }
    return { ok: false, motivo, message }
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