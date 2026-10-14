import { getFunctions, httpsCallable } from 'firebase/functions'
import app from './config'

const functions = getFunctions(app, 'us-central1')

export const convidarAdministrador = async ({ nome, email }) => {
  const result = await httpsCallable(functions, 'gerenciarAdministrador')({
    action: 'create',
    nome: String(nome || '').trim(),
    email: String(email || '').trim().toLowerCase(),
  })
  return result.data
}

export const publicarFaturaValidada = async (payload) => {
  const result = await httpsCallable(functions, 'publicarFaturaValidada')(payload)
  return result.data
}

export const removerFaturaServidor = async (faturaId) => {
  const result = await httpsCallable(functions, 'removerFaturaAdministrativa')({
    faturaId: String(faturaId || ''),
  })
  return result.data
}

export const revogarTokensPdfLegados = async (onProgress = () => {}) => {
  const callable = httpsCallable(functions, 'revogarTokensDownloadLegados')
  const operationId = crypto.randomUUID()
  let pageToken = null
  let filesScanned = 0
  let tokensRevogados = 0

  do {
    const result = await callable({ pageToken, operationId })
    filesScanned += result.data.filesScanned
    tokensRevogados += result.data.tokensRevogados
    pageToken = result.data.nextPageToken
    onProgress({ filesScanned, tokensRevogados })
  } while (pageToken)

  return { filesScanned, tokensRevogados, operationId }
}

export const alterarStatusAdministrador = async ({ action, uid, email, nome }) => {
  const result = await httpsCallable(functions, 'gerenciarAdministrador')({
    action,
    uid: String(uid || ''),
    email: String(email || '').trim().toLowerCase(),
    nome: String(nome || '').trim(),
  })
  return result.data
}
