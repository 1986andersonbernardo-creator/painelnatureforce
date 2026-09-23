// ==================== Serviços Firestore ====================
// Todas as consultas são filtradas pelo UID do usuário autenticado.
// A segurança é reforçada pelas Firestore Security Rules.

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  setDoc,
  updateDoc,
  addDoc,
  deleteDoc,
  onSnapshot,
  limit,
  deleteField,
} from 'firebase/firestore'
import { db } from './config'
import { gerarIdFatura, montarChaveIdempotencia } from '../services/faturaDedup'
import { idDocumento, itemParaBanco } from '../services/persistencia'

// Limpeza automática de credenciais legadas: versões anteriores gravaram
// `senha`/`senhaAcesso` no Firestore. Escrevendo `deleteField()` nesses campos a
// cada espelhamento, qualquer senha antiga que ainda exista no banco é REMOVIDA
// no próximo salvamento (só limpar o cache local não bastava: o dado já estava lá).
const camposSensiveis = (colecao) =>
  colecao === 'usuarios'
    ? { senha: deleteField() }
    : colecao === 'clientes'
      ? { senha: deleteField(), senhaAcesso: deleteField() }
      : null

// Limites de leitura das coleções que crescem continuamente (`logs` de
// auditoria e `atendimento`). Sem limite, cada entrada do painel lia a coleção
// INTEIRA — custo e tempo de resposta crescendo para sempre.
export const LIMITE_LOGS = 400
export const LIMITE_CHAMADOS = 300

// ==================== CLIENTES ====================

// Busca o documento do cliente pelo UID (o UID é o ID do documento)
export const getClientePorUid = async (uid) => {
  try {
    const docRef = doc(db, 'clientes', uid)
    const docSnap = await getDoc(docRef)
    if (docSnap.exists()) {
      return { ok: true, data: { id: docSnap.id, ...docSnap.data() } }
    }
    return { ok: false, message: 'Cliente não encontrado.' }
  } catch {
    return { ok: false, message: 'Erro ao buscar dados do cliente.' }
  }
}

// Cria/atualiza o documento do cliente (UID = ID do documento)
export const salvarCliente = async (uid, dados) => {
  try {
    await setDoc(doc(db, 'clientes', uid), dados, { merge: true })
    return { ok: true }
  } catch {
    return { ok: false, message: 'Erro ao salvar dados do cliente.' }
  }
}

// Atualiza campos específicos do cliente
export const atualizarCliente = async (uid, dados) => {
  try {
    await updateDoc(doc(db, 'clientes', uid), dados)
    return { ok: true }
  } catch {
    return { ok: false, message: 'Erro ao atualizar dados do cliente.' }
  }
}

// ==================== FATURAS ====================

// Observa faturas do cliente em tempo real
export const observarFaturasDoCliente = (uid, callback) => {
  const q = query(collection(db, 'faturas'), where('clienteId', '==', uid))
  return onSnapshot(
    q,
    (snapshot) => {
      const faturas = []
      snapshot.forEach((docSnap) => {
        faturas.push({ id: docSnap.id, ...docSnap.data() })
      })
      callback({ ok: true, data: dedupeFaturas(faturas) })
    },
    () => {
      callback({ ok: false, message: 'Erro ao buscar faturas.' })
    },
  )
}

// Salva uma fatura de forma IDEMPOTENTE no Firestore.
// Usa um ID determinístico derivado de (UC|referencia|nota#hashArquivo).
// Se o documento já existir, retorna DUPLICADA — a mesma fatura nunca é
// cadastrada duas vezes, mesmo sob concorrência ou re-upload do arquivo.
export const salvarFaturaIdempotente = async (dados) => {
  try {
    const id = gerarIdFatura({
      uc: dados.numeroUC ?? dados.uc,
      referencia: dados.referencia,
      numeroNota: dados.numeroNota,
      hashArquivo: dados.hashArquivo,
    })
    const chaveIdempotencia = montarChaveIdempotencia({
      uc: dados.numeroUC ?? dados.uc,
      referencia: dados.referencia,
      numeroNota: dados.numeroNota,
      hashArquivo: dados.hashArquivo,
    })

    const ref = doc(db, 'faturas', id)
    const existente = await getDoc(ref)
    if (existente.exists()) {
      return { ok: false, duplicada: true, id, data: { id, ...existente.data() } }
    }

    await setDoc(ref, {
      ...dados,
      id,
      chaveIdempotencia,
      criadoEm: new Date().toISOString(),
    })
    return { ok: true, id }
  } catch {
    return { ok: false, message: 'Erro ao salvar fatura processada.' }
  }
}

// ==================== PROCESSAMENTO DE FATURAS ====================

// Registra o processamento de uma fatura
export const registrarProcessamento = async (dados) => {
  try {
    const docRef = await addDoc(collection(db, 'processamentoFaturas'), {
      ...dados,
      criadoEm: new Date().toISOString(),
    })
    return { ok: true, id: docRef.id }
  } catch {
    return { ok: false, message: 'Erro ao registrar processamento.' }
  }
}

// Atualiza o status do processamento
export const atualizarProcessamento = async (processamentoId, dados) => {
  try {
    await updateDoc(doc(db, 'processamentoFaturas', processamentoId), {
      ...dados,
      concluidoEm: new Date().toISOString(),
    })
    return { ok: true }
  } catch {
    return { ok: false, message: 'Erro ao atualizar processamento.' }
  }
}

// ==================== REVISÕES DE FATURAS ====================

// Cria uma revisão para fatura que requer análise
export const criarRevisaoFatura = async (dados) => {
  try {
    const docRef = await addDoc(collection(db, 'revisoesFaturas'), {
      ...dados,
      status: 'pendente',
      criadoEm: new Date().toISOString(),
    })
    return { ok: true, id: docRef.id }
  } catch {
    return { ok: false, message: 'Erro ao criar revisão.' }
  }
}

// ==================== UNIDADES CONSUMIDORAS ====================

// Observa unidades do cliente em tempo real
export const observarUnidadesDoCliente = (uid, callback) => {
  const q = query(collection(db, 'unidades'), where('clienteId', '==', uid))
  return onSnapshot(
    q,
    (snapshot) => {
      const unidades = []
      snapshot.forEach((docSnap) => {
        unidades.push({ id: docSnap.id, ...docSnap.data() })
      })
      callback({ ok: true, data: unidades })
    },
    () => {
      callback({ ok: false, message: 'Erro ao buscar unidades consumidoras.' })
    },
  )
}

// ==================== ATENDIMENTO ====================

// Observa os chamados do cliente autenticado em tempo real. O status muda
// quando o administrador atende — o cliente vê a atualização sem recarregar.
export const observarChamadosDoCliente = (uid, callback) =>
  onSnapshot(
    query(collection(db, 'atendimento'), where('clienteId', '==', uid)),
    (snapshot) => {
      const chamados = []
      snapshot.forEach((docSnap) => {
        chamados.push({ id: docSnap.id, ...docSnap.data() })
      })
      callback({ ok: true, data: chamados })
    },
    (error) => {
      callback({
        ok: false,
        data: [],
        codigo: error?.code || 'firestore/erro',
        message: 'Não foi possível carregar seus chamados.',
      })
    },
  )

// Observa TODOS os chamados (painel administrativo). A leitura é autorizada
// pelo `isAdmin()` das Security Rules — sem isso os pedidos dos clientes
// ficavam gravados no banco e invisíveis para a equipe.
export const observarTodosChamados = (callback) =>
  onSnapshot(
    query(collection(db, 'atendimento'), limit(LIMITE_CHAMADOS)),
    (snapshot) => {
      const chamados = []
      snapshot.forEach((docSnap) => {
        chamados.push({ id: docSnap.id, ...docSnap.data() })
      })
      callback({ ok: true, data: chamados })
    },
    (error) => {
      callback({
        ok: false,
        data: [],
        codigo: error?.code || 'firestore/erro',
        message: 'Não foi possível carregar as solicitações de atendimento.',
      })
    },
  )

// Atualiza um chamado (usado pelo administrador para responder/mudar o status)
export const atualizarChamado = async (chamadoId, dados) => {
  try {
    await updateDoc(doc(db, 'atendimento', chamadoId), {
      ...dados,
      atualizadoEm: new Date().toISOString(),
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      codigo: error?.code || 'firestore/erro',
      message: 'Não foi possível atualizar a solicitação.',
    }
  }
}

// Cria um novo chamado de atendimento
export const criarChamado = async (uid, dados) => {
  try {
    const novo = {
      clienteId: uid,
      ...dados,
      status: 'aberto',
      dataCriacao: new Date().toISOString(),
    }
    const docRef = await addDoc(collection(db, 'atendimento'), novo)
    return { ok: true, id: docRef.id }
  } catch {
    return { ok: false, message: 'Erro ao enviar solicitação.' }
  }
}

// ==================== SINCRONIZAÇÃO GENÉRICA (cache local ↔ Firestore) ====================
// Usada pela camada de persistência (services/persistencia.js) para espelhar
// toda alteração administrativa no Firestore — que é a fonte de verdade
// compartilhada com a Área do Cliente e com outros navegadores/dispositivos.
//
// Requer sessão autenticada: as regras de segurança autorizam o próprio cliente
// (uid) e o administrador (token admin OU e-mail na lista de administradores).

// Lista os documentos de uma coleção.
// `limite` é usado pelas coleções que crescem continuamente (`logs`) — sem ele
// cada leitura trazia o histórico INTEIRO para a memória do navegador.
export const listarDocumentos = async (colecao, { limite } = {}) => {
  try {
    const referencia = collection(db, colecao)
    const snapshot = await getDocs(limite ? query(referencia, limit(limite)) : referencia)
    const documentos = []
    snapshot.forEach((docSnap) => {
      documentos.push({ id: docSnap.id, ...docSnap.data() })
    })
    return { ok: true, data: documentos }
  } catch (error) {
    return {
      ok: false,
      data: [],
      codigo: error?.code || 'firestore/erro',
      message: 'Não foi possível ler os dados compartilhados.',
    }
  }
}

// Grava (cria ou atualiza) um documento. `merge` preserva campos não enviados.
export const salvarDocumento = async (colecao, id, dados, { merge = true } = {}) => {
  try {
    const limpeza = camposSensiveis(colecao)
    const payload = limpeza ? { ...itemParaBanco(colecao, dados), ...limpeza } : dados
    await setDoc(doc(db, colecao, String(id)), payload, { merge })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      codigo: error?.code || 'firestore/erro',
      message: 'Não foi possível salvar no banco compartilhado.',
    }
  }
}

// Remove um documento
export const removerDocumento = async (colecao, id) => {
  try {
    await deleteDoc(doc(db, colecao, String(id)))
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      codigo: error?.code || 'firestore/erro',
      message: 'Não foi possível remover no banco compartilhado.',
    }
  }
}

// Grava uma coleção inteira (espelhamento do cache local para o Firestore).
// O id de cada documento é resolvido por `idDocumento` (clientes usam o UID);
// credenciais são removidas/limpas dentro de `salvarDocumento` (itemParaBanco +
// deleteField para senhas legadas já gravadas).
export const sincronizarColecaoRemota = async (colecao, itens = []) => {
  const resultados = await Promise.allSettled(
    itens.map((item) => salvarDocumento(colecao, idDocumento(colecao, item), item)),
  )

  const falhas = []
  resultados.forEach((resultado, indice) => {
    const retorno = resultado.status === 'fulfilled' ? resultado.value : { ok: false }
    if (!retorno?.ok) {
      falhas.push({
        id: idDocumento(colecao, itens[indice]),
        codigo: retorno?.codigo || 'firestore/erro',
      })
    }
  })

  return { ok: falhas.length === 0, gravados: itens.length - falhas.length, falhas }
}

// ==================== SINCRONIZAÇÃO EM TEMPO REAL ====================
// onSnapshot: quando o banco central muda (alteração feita em outro
// dispositivo), o callback entrega a lista atualizada — a interface reflete a
// alteração sem depender de recarregar a página.

/**
 * Remove faturas duplicadas do MESMO registro lógico.
 * Antes da correção, a mesma fatura podia gravar dois documentos no Firestore
 * (id determinístico + id local). A chave de idempotência identifica o
 * registro canônico — o documento legado restante não deve aparecer na UI.
 * @param {Array} faturas
 * @returns {Array}
 */
export const dedupeFaturas = (faturas = []) => {
  const vistos = new Set()
  return faturas.filter((f) => {
    const chave = f?.chaveIdempotencia
      ? `idem:${f.chaveIdempotencia}`
      : f?.hashArquivo
        ? `hash:${f.hashArquivo}`
        : `id:${f?.id ?? ''}`
    if (vistos.has(chave)) return false
    vistos.add(chave)
    return true
  })
}

/**
 * Observa uma coleção em tempo real.
 * `limite` é usado pelas coleções que crescem continuamente (`logs`).
 * @param {string} colecao
 * @param {(resultado:{ok:boolean, data?:Array, codigo?:string, message?:string}) => void} callback
 * @param {{limite?:number}} [opcoes]
 * @returns {() => void} unsubscribe
 */
export const observarColecao = (colecao, callback, { limite } = {}) =>
  onSnapshot(
    limite ? query(collection(db, colecao), limit(limite)) : collection(db, colecao),
    (snapshot) => {
      const documentos = []
      snapshot.forEach((docSnap) => {
        documentos.push({ id: docSnap.id, ...docSnap.data() })
      })
      callback({ ok: true, data: documentos })
    },
    (error) => {
      callback({
        ok: false,
        data: [],
        codigo: error?.code || 'firestore/erro',
        message: 'Não foi possível acompanhar as alterações do banco compartilhado.',
      })
    },
  )

/**
 * Observa o documento do cliente em tempo real (perfil atualiza em qualquer
 * dispositivo quando o administrador altera o cadastro).
 * @param {string} uid
 * @param {(resultado:{ok:boolean, data?:Object|null, message?:string}) => void} callback
 * @returns {() => void} unsubscribe
 */
export const observarClientePorUid = (uid, callback) =>
  onSnapshot(
    doc(db, 'clientes', uid),
    (snapshot) => {
      callback({
        ok: true,
        data: snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null,
      })
    },
    (error) => {
      callback({
        ok: false,
        data: null,
        codigo: error?.code || 'firestore/erro',
        message: 'Não foi possível acompanhar os dados do cliente.',
      })
    },
  )