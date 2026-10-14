import { readFileSync } from 'node:fs'
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, getFirestore, setDoc, updateDoc, collection, getDocs, query, where } from 'firebase/firestore'
import { getBytes, ref, uploadBytes } from 'firebase/storage'

const projectId = 'demo-natureforce'
let environment

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
    },
    storage: {
      rules: readFileSync(new URL('../storage.rules', import.meta.url), 'utf8'),
      host: '127.0.0.1',
      port: 9199,
    },
  })
})

after(async () => {
  await environment.cleanup()
})

beforeEach(async () => {
  await environment.clearFirestore()
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = getFirestore(context)
    await setDoc(doc(db, 'clientes', 'cliente-a'), { nome: 'Cliente A', emailAcesso: 'a@example.com' })
    await setDoc(doc(db, 'clientes', 'cliente-b'), { nome: 'Cliente B', emailAcesso: 'b@example.com' })
    await setDoc(doc(db, 'faturas', 'fatura-a'), {
      clienteId: 'cliente-a',
      uc: '001234',
      status: 'disponivel',
      storagePath: 'faturas/cliente-a/001234/fatura-a.pdf',
    })
    await setDoc(doc(db, 'faturas', 'fatura-b'), {
      clienteId: 'cliente-b',
      uc: '009876',
      status: 'disponivel',
    })
    await setDoc(doc(db, 'faturas', 'fatura-pendente'), {
      clienteId: 'cliente-a',
      uc: '001234',
      status: 'aguardando revisão',
    })
    await setDoc(doc(db, 'unidades', 'uc-a'), { clienteId: 'cliente-a', numeroUC: '001234' })
  })
})

test('cliente só lê suas faturas publicadas e não altera vínculo/permissões', async () => {
  const db = environment.authenticatedContext('cliente-a', { email: 'a@example.com' }).firestore()

  await assertSucceeds(getDoc(doc(db, 'faturas', 'fatura-a')))
  await assertFails(getDoc(doc(db, 'faturas', 'fatura-b')))
  await assertFails(getDoc(doc(db, 'faturas', 'fatura-pendente')))
  await assertSucceeds(updateDoc(doc(db, 'clientes', 'cliente-a'), { telefone: '11999999999' }))
  await assertFails(updateDoc(doc(db, 'clientes', 'cliente-a'), { emailAcesso: 'attacker@example.com' }))
  await assertFails(setDoc(doc(db, 'unidades', 'uc-evil'), { clienteId: 'cliente-a', numeroUC: '009876' }))
  await assertFails(setDoc(doc(db, 'faturas', 'fatura-evil'), { clienteId: 'cliente-a', status: 'disponivel' }))
})

test('consulta do portal precisa restringir status além do UID', async () => {
  const db = environment.authenticatedContext('cliente-a', { email: 'a@example.com' }).firestore()
  const autorizada = query(
    collection(db, 'faturas'),
    where('clienteId', '==', 'cliente-a'),
    where('status', '==', 'disponivel'),
  )
  const semStatus = query(collection(db, 'faturas'), where('clienteId', '==', 'cliente-a'))

  const snapshot = await assertSucceeds(getDocs(autorizada))
  assert.equal(snapshot.size, 1)
  await assertFails(getDocs(semStatus))
})

test('admin pode gerir dados de negócio, mas não perfis nem logs diretamente', async () => {
  const db = environment.authenticatedContext('admin-uid', {
    email: 'admin@example.com',
    admin: true,
  }).firestore()

  await assertSucceeds(setDoc(doc(db, 'faturas', 'admin-fatura'), {
    clienteId: 'cliente-a',
    uc: '001234',
    status: 'aguardando revisão',
  }))
  await assertFails(setDoc(doc(db, 'usuarios', 'novo@example.com'), {
    email: 'novo@example.com',
    perfil: 'administrador',
  }))
  await assertFails(setDoc(doc(db, 'logs', 'falso'), { operation: 'forjado' }))
  await assertFails(getDoc(doc(db, 'chavesFatura', 'chave-privada')))
})

test('master também não altera perfis ou logs fora do backend', async () => {
  const db = environment.authenticatedContext('master-uid', {
    email: 'thyagopatriota2020@gmail.com',
  }).firestore()

  await assertSucceeds(setDoc(doc(db, 'clientes', 'cliente-c'), { nome: 'Cliente C' }))
  await assertFails(setDoc(doc(db, 'usuarios', 'admin@example.com'), { perfil: 'master' }))
  await assertFails(setDoc(doc(db, 'logs', 'falso'), { operation: 'forjado' }))
})

test('claim master em outra conta não concede privilégios de master', async () => {
  const db = environment.authenticatedContext('admin-uid', {
    email: 'admin@example.com',
    role: 'master',
  }).firestore()

  await assertFails(setDoc(doc(db, 'clientes', 'cliente-c'), { nome: 'Cliente C' }))
  await assertFails(setDoc(doc(db, 'usuarios', 'outro@example.com'), { perfil: 'administrador' }))
})

test('perfil administrativo inativo bloqueia token admin ainda válido', async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(getFirestore(context), 'usuarios', 'admin@example.com'), {
      email: 'admin@example.com',
      perfil: 'administrador',
      status: 'inativo',
    })
  })
  const db = environment.authenticatedContext('admin-uid', {
    email: 'admin@example.com',
    admin: true,
  }).firestore()

  await assertFails(setDoc(doc(db, 'clientes', 'cliente-c'), { nome: 'Cliente C' }))
})

test('PDF é privado por UID e só fica disponível com fatura publicada vinculada', async () => {
  const admin = environment.authenticatedContext('admin-uid', {
    email: 'admin@example.com',
    admin: true,
  })
  const clientA = environment.authenticatedContext('cliente-a', { email: 'a@example.com' })
  const clientB = environment.authenticatedContext('cliente-b', { email: 'b@example.com' })
  const path = 'faturas/cliente-a/001234/fatura-a.pdf'
  const file = new Uint8Array([37, 80, 68, 70, 45])

  await assertSucceeds(uploadBytes(ref(admin.storage(), path), file, {
    contentType: 'application/pdf',
    customMetadata: { faturaId: 'fatura-a' },
  }))
  await assertSucceeds(getBytes(ref(clientA.storage(), path)))
  await assertFails(getBytes(ref(clientB.storage(), path)))

  const pendingPath = 'faturas/cliente-a/001234/fatura-pendente.pdf'
  await assertSucceeds(uploadBytes(ref(admin.storage(), pendingPath), file, {
    contentType: 'application/pdf',
    customMetadata: { faturaId: 'fatura-pendente' },
  }))
  await assertFails(getBytes(ref(clientA.storage(), pendingPath)))
  await assertFails(uploadBytes(ref(clientA.storage(), 'faturas/cliente-a/001234/nao-autorizado.pdf'), file, {
    contentType: 'application/pdf',
    customMetadata: { faturaId: 'fatura-a' },
  }))
})
