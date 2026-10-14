import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import app from './config'

const storage = getStorage(app)

const normalizarSegmento = (valor) => String(valor || '').replace(/[^a-zA-Z0-9_-]/g, '_')

export const caminhoPdfFatura = ({ clienteUid, uc, faturaId }) => {
  const uid = normalizarSegmento(clienteUid)
  const unidade = normalizarSegmento(String(uc || '').replace(/\D/g, '')) || 'sem-uc'
  const id = normalizarSegmento(faturaId)
  if (!uid || !id) throw new Error('UID do cliente e identificador da fatura são obrigatórios.')
  return `faturas/${uid}/${unidade}/${id}.pdf`
}

export const enviarPdfFatura = async ({ clienteUid, uc, faturaId, arquivo }) => {
  try {
    const caminho = caminhoPdfFatura({ clienteUid, uc, faturaId })
    await uploadBytes(ref(storage, caminho), arquivo, {
      contentType: 'application/pdf',
      customMetadata: { faturaId: String(faturaId) },
    })
    return { ok: true, caminho }
  } catch (error) {
    const codigo = error?.code || 'storage/unknown'
    const message =
      codigo === 'storage/unauthorized'
        ? 'O Firebase Storage recusou o envio. Confira se storage.rules foi publicada e se a sessão é administrativa.'
        : codigo === 'storage/bucket-not-found'
          ? 'O bucket do Firebase Storage não foi encontrado. Ative o Storage no projeto Firebase configurado.'
          : error?.message || 'Não foi possível enviar o PDF para o armazenamento compartilhado.'
    return { ok: false, codigo, message }
  }
}

export const obterUrlPdfFatura = async (caminho) =>
  getDownloadURL(ref(storage, String(caminho || '')))
