const { randomUUID } = require('node:crypto')
const { initializeApp } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
const { FieldValue, getFirestore } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')
const { onDocumentWritten } = require('firebase-functions/v2/firestore')
const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { defineSecret } = require('firebase-functions/params')
const nodemailer = require('nodemailer')

initializeApp()

const db = getFirestore()
const auth = getAuth()
const smtpHost = defineSecret('SMTP_HOST')
const smtpPort = defineSecret('SMTP_PORT')
const smtpUser = defineSecret('SMTP_USER')
const smtpPassword = defineSecret('SMTP_PASSWORD')
const smtpFrom = defineSecret('SMTP_FROM')
const masterEmail = 'thyagopatriota2020@gmail.com'

const authenticated = (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Faça login para continuar.')
  }
  return request.auth
}

const requireMaster = (request) => {
  const actor = authenticated(request)
  const email = String(actor.token.email || '').toLowerCase()
  if (email !== masterEmail) {
    throw new HttpsError('permission-denied', 'Somente o administrador master pode executar esta ação.')
  }
  return actor
}

const registrarAuditoria = async ({
  actorUid,
  actorEmail,
  actorRole,
  operation,
  entity,
  entityId,
  clienteId = null,
  uc = null,
  before = null,
  after = null,
  operationId = randomUUID(),
  result = 'success',
  logId = randomUUID(),
}) => {
  await db.collection('logs').doc(logId).set({
    actorUid: actorUid || null,
    actorEmail: actorEmail || null,
    actorRole: actorRole || 'unknown',
    operation,
    entity,
    entityId: entityId || null,
    clienteId,
    uc,
    before,
    after,
    operationId,
    result,
    createdAt: FieldValue.serverTimestamp(),
  })
}

const escaparHtml = (value) =>
  String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char])

const enviarConvite = async ({ email, nome, link }) => {
  const host = smtpHost.value()
  const port = Number(smtpPort.value())
  const user = smtpUser.value()
  const password = smtpPassword.value()
  const from = smtpFrom.value()
  if (!host || !Number.isInteger(port) || !user || !password || !from) {
    throw new HttpsError('failed-precondition', 'O serviço de e-mail do Firebase ainda não está configurado.')
  }

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass: password },
  })
  await transport.sendMail({
    from,
    to: email,
    subject: 'Convite de acesso administrativo — Nature Force',
    text: `Olá ${nome}. Defina sua senha e ative o acesso administrativo por este link: ${link}`,
    html: `<p>Olá ${escaparHtml(nome)}.</p><p>Defina sua senha e ative seu acesso administrativo:</p><p><a href="${escaparHtml(link)}">Ativar acesso</a></p>`,
  })
}

exports.gerenciarAdministrador = onCall(
  { secrets: [smtpHost, smtpPort, smtpUser, smtpPassword, smtpFrom] },
  async (request) => {
    let actor
    try {
      actor = requireMaster(request)
    } catch (error) {
      await registrarAuditoria({
        actorUid: request.auth?.uid || null,
        actorEmail: request.auth?.token?.email || null,
        actorRole: request.auth?.token?.role || 'unknown',
        operation: 'ADMIN_MANAGEMENT_DENIED',
        entity: 'usuarios',
        result: 'denied',
      })
      throw error
    }
    const action = String(request.data?.action || '')
    const actorEmail = String(actor.token.email || '').toLowerCase()
    const actorRole = 'master'
    const operationId = randomUUID()

    if (action === 'create') {
      const email = String(request.data?.email || '').trim().toLowerCase()
      const nome = String(request.data?.nome || '').trim()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !nome) {
        throw new HttpsError('invalid-argument', 'Informe nome e e-mail válidos.')
      }
      if (email === masterEmail) {
        throw new HttpsError('already-exists', 'A conta master não pode ser recriada.')
      }
      const smtpValues = [smtpHost.value(), smtpPort.value(), smtpUser.value(), smtpPassword.value(), smtpFrom.value()]
      if (smtpValues.some((value) => !value)) {
        throw new HttpsError('failed-precondition', 'O serviço de e-mail ainda não está configurado.')
      }

      const profileRef = db.collection('usuarios').doc(email)
      const existingProfile = await profileRef.get()
      if (existingProfile.exists) {
        throw new HttpsError('already-exists', 'Já existe um perfil administrativo com este e-mail.')
      }

      let createdUser
      let profileCreated = false
      try {
        createdUser = await auth.createUser({ email, displayName: nome, emailVerified: false })
        const link = await auth.generatePasswordResetLink(email)
        await enviarConvite({ email, nome, link })
        await auth.setCustomUserClaims(createdUser.uid, { role: 'admin', admin: true })
        await profileRef.set({
          uid: createdUser.uid,
          nome,
          email,
          perfil: 'administrador',
          status: 'ativo',
          criadoEm: FieldValue.serverTimestamp(),
        })
        profileCreated = true
        await registrarAuditoria({
          actorUid: actor.uid,
          actorEmail,
          actorRole,
          operation: 'ADMIN_CREATED_AND_INVITED',
          entity: 'usuarios',
          entityId: createdUser.uid,
          after: { email, nome, perfil: 'administrador', status: 'ativo' },
          operationId,
        })
      } catch (error) {
        if (createdUser) {
          if (profileCreated) await profileRef.delete()
          await auth.deleteUser(createdUser.uid)
        }
        if (error instanceof HttpsError) throw error
        if (error.code === 'auth/email-already-exists') {
          throw new HttpsError('already-exists', 'Já existe uma conta com este e-mail.')
        }
        throw new HttpsError('internal', 'Não foi possível criar e enviar o convite administrativo.')
      }

      return { ok: true, uid: createdUser.uid, email, operationId }
    }

    const requestedUid = String(request.data?.uid || '').trim()
    const requestedEmail = String(request.data?.email || '').trim().toLowerCase()
    if ((!requestedUid && !requestedEmail) || requestedUid === actor.uid || requestedEmail === actorEmail) {
      throw new HttpsError('invalid-argument', 'Informe uma conta administrativa diferente da sua.')
    }
    const target = requestedUid
      ? await auth.getUser(requestedUid)
      : await auth.getUserByEmail(requestedEmail)
    const uid = target.uid
    const targetEmail = String(target.email || '').toLowerCase()
    if (targetEmail === masterEmail || target.customClaims?.role === 'master') {
      throw new HttpsError('permission-denied', 'A conta master não pode ser desativada ou excluída.')
    }
    const profileRef = db.collection('usuarios').doc(targetEmail)
    const profileSnap = await profileRef.get()
    const isAdminProfile = target.customClaims?.role === 'admin' ||
      target.customClaims?.admin === true ||
      ['guladpizza@gmail.com', '1986.andersonbernardo@gmail.com'].includes(targetEmail) ||
      (profileSnap.exists && profileSnap.get('perfil') === 'administrador')
    if (!isAdminProfile) {
      throw new HttpsError('failed-precondition', 'A conta informada não possui perfil administrativo.')
    }
    const before = profileSnap.exists
      ? {
          email: profileSnap.get('email'),
          nome: profileSnap.get('nome'),
          perfil: profileSnap.get('perfil'),
          status: profileSnap.get('status'),
        }
      : { email: targetEmail, perfil: 'administrador', status: 'desconhecido' }

    if (action === 'update') {
      const nome = String(request.data?.nome || '').trim()
      if (!nome) throw new HttpsError('invalid-argument', 'Informe o nome do administrador.')
      await auth.updateUser(uid, { displayName: nome })
      await profileRef.set(
        { uid, email: targetEmail, nome, perfil: 'administrador', atualizadoEm: FieldValue.serverTimestamp() },
        { merge: true },
      )
      await registrarAuditoria({
        actorUid: actor.uid,
        actorEmail,
        actorRole,
        operation: 'ADMIN_UPDATED',
        entity: 'usuarios',
        entityId: uid,
        before,
        after: { ...before, email: targetEmail, nome, perfil: 'administrador' },
        operationId,
      })
      return { ok: true, operationId }
    }

    if (action === 'activate') {
      if (
        !profileSnap.exists ||
        profileSnap.get('perfil') !== 'administrador' ||
        profileSnap.get('status') !== 'inativo'
      ) {
        throw new HttpsError('failed-precondition', 'Somente uma conta administrativa desativada pode ser reativada.')
      }
      await auth.updateUser(uid, { disabled: false })
      await auth.setCustomUserClaims(uid, { ...(target.customClaims || {}), role: 'admin', admin: true })
      await profileRef.set(
        { uid, email: targetEmail, perfil: 'administrador', status: 'ativo', atualizadoEm: FieldValue.serverTimestamp() },
        { merge: true },
      )
      await registrarAuditoria({
        actorUid: actor.uid,
        actorEmail,
        actorRole,
        operation: 'ADMIN_ACTIVATED',
        entity: 'usuarios',
        entityId: uid,
        before,
        after: { ...before, email: targetEmail, perfil: 'administrador', status: 'ativo' },
        operationId,
      })
      return { ok: true, operationId }
    }

    if (action !== 'deactivate' && action !== 'delete') {
      throw new HttpsError('invalid-argument', 'Operação administrativa inválida.')
    }

    await profileRef.set(
      { uid, email: targetEmail, status: 'inativo', atualizadoEm: FieldValue.serverTimestamp() },
      { merge: true },
    )
    await auth.updateUser(uid, { disabled: true })
    await auth.setCustomUserClaims(uid, { ...(target.customClaims || {}), role: 'client', admin: null })
    if (action === 'delete') await auth.deleteUser(uid)

    await registrarAuditoria({
      actorUid: actor.uid,
      actorEmail,
      actorRole,
      operation: action === 'delete' ? 'ADMIN_DELETED' : 'ADMIN_DEACTIVATED',
      entity: 'usuarios',
      entityId: uid,
      before,
      after: action === 'delete'
        ? { email: targetEmail, perfil: 'administrador', status: 'inativo', deleted: true }
        : { email: targetEmail, perfil: 'administrador', status: 'inativo' },
      operationId,
    })
    if (action === 'delete') await profileRef.delete()
    return { ok: true, operationId }
  },
)

const normalizarUC = (value) => String(value ?? '').replace(/\D/g, '')
const normalizarReferencia = (value) => String(value ?? '').trim()

exports.publicarFaturaValidada = onCall(async (request) => {
  const actor = authenticated(request)
  const actorEmail = String(actor.token.email || '').toLowerCase()
  const profile = actorEmail
    ? await db.collection('usuarios').doc(actorEmail).get()
    : null
  const profileInactive = profile?.exists && profile.get('status') === 'inativo'
  const isAdmin = actor.token.admin === true ||
    actor.token.role === 'admin' ||
    actorEmail === masterEmail ||
    ['guladpizza@gmail.com', '1986.andersonbernardo@gmail.com'].includes(actorEmail)
  if (!isAdmin || profileInactive) {
    await registrarAuditoria({
      actorUid: actor.uid,
      actorEmail,
      actorRole: actor.token.role || 'unknown',
      operation: 'INVOICE_PUBLICATION_DENIED',
      entity: 'faturas',
      entityId: request.data?.faturaId || null,
      result: 'denied',
    })
    throw new HttpsError('permission-denied', 'A conta não está autorizada a publicar faturas.')
  }

  const data = request.data || {}
  const faturaId = String(data.faturaId || '').trim()
  const uc = normalizarUC(data.uc)
  const ucExtraida = normalizarUC(data.ucExtraida)
  const referencia = normalizarReferencia(data.referencia)
  const referenciaKey = referencia.replace(/\s/g, '')
  const storagePath = String(data.storagePath || '')
  const operationId = randomUUID()
  const bucket = getStorage().bucket()
  const file = bucket.file(storagePath)
  const rejeitarPublicacao = async (error) => {
    let arquivoLimpo = false
    try {
      if (storagePath.startsWith('faturas/')) {
        const references = await db.collection('faturas')
          .where('storagePath', '==', storagePath)
          .limit(1)
          .get()
        if (references.empty) {
          await file.delete({ ignoreNotFound: true })
          arquivoLimpo = true
        }
      }
    } catch (cleanupError) {
      await registrarAuditoria({
        actorUid: actor.uid,
        actorEmail,
        actorRole: actor.token.role || (actorEmail === masterEmail ? 'master' : 'admin'),
        operation: 'INVOICE_UPLOAD_CLEANUP_FAILED',
        entity: 'faturas',
        entityId: faturaId || null,
        uc: uc || null,
        operationId,
        result: cleanupError.code || 'cleanup-failed',
      })
    }
    await registrarAuditoria({
      actorUid: actor.uid,
      actorEmail,
      actorRole: actor.token.role || (actorEmail === masterEmail ? 'master' : 'admin'),
      operation: 'INVOICE_PUBLICATION_FAILED',
      entity: 'faturas',
      entityId: faturaId || null,
      uc: uc || null,
      operationId,
      after: { uploadCleanup: arquivoLimpo ? 'removed' : 'referenced-or-not-applicable' },
      result: error.code || 'failed',
    })
    throw error
  }
  if (!/^fat_[a-zA-Z0-9_-]{1,100}$/.test(faturaId) || !uc || !referencia) {
    return rejeitarPublicacao(new HttpsError('invalid-argument', 'Identificador, UC e competência são obrigatórios.'))
  }
  if (!ucExtraida) {
    return rejeitarPublicacao(new HttpsError('failed-precondition', 'A UC extraída precisa ser confirmada antes da publicação.'))
  }

  const expectedPrefix = `faturas/`
  if (!storagePath.startsWith(expectedPrefix) || !storagePath.endsWith(`/${uc}/${faturaId}.pdf`)) {
    return rejeitarPublicacao(new HttpsError('invalid-argument', 'O caminho do PDF não corresponde à UC e fatura informadas.'))
  }
  let metadata
  let bytes
  try {
    ;[metadata] = await file.getMetadata()
    if (metadata.contentType !== 'application/pdf' || Number(metadata.size) > 20 * 1024 * 1024) {
      throw new HttpsError('failed-precondition', 'O arquivo precisa ser um PDF válido de até 20 MB.')
    }
    if (metadata.metadata?.faturaId !== faturaId) {
      throw new HttpsError('failed-precondition', 'Os metadados do PDF não correspondem à fatura.')
    }
    if (metadata.metadata?.firebaseStorageDownloadTokens) {
      const customMetadata = { ...metadata.metadata }
      delete customMetadata.firebaseStorageDownloadTokens
      await file.setMetadata({ metadata: customMetadata })
    }
    ;[bytes] = await file.download()
  } catch (error) {
    if (error instanceof HttpsError) return rejeitarPublicacao(error)
    return rejeitarPublicacao(new HttpsError('failed-precondition', 'O PDF não foi encontrado no Storage; a fatura não foi publicada.'))
  }

  if (!Buffer.from(bytes).subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    return rejeitarPublicacao(new HttpsError('failed-precondition', 'O arquivo enviado não contém uma assinatura PDF válida.'))
  }

  const hashArquivo = require('node:crypto').createHash('sha256').update(bytes).digest('hex')
  const faturaRef = db.collection('faturas').doc(faturaId)
  const chaveCompetenciaId = require('node:crypto')
    .createHash('sha256')
    .update(`${uc}|${referenciaKey}`)
    .digest('hex')
  const chaveCompetenciaRef = db.collection('chavesFatura').doc(chaveCompetenciaId)
  let resultado
  try {
    resultado = await db.runTransaction(async (transaction) => {
      const [unidadesSnap, clientesSnap, faturasSnap, faturaAtualSnap, chaveCompetenciaSnap] = await Promise.all([
        transaction.get(db.collection('unidades')),
        transaction.get(db.collection('clientes')),
        transaction.get(db.collection('faturas')),
        transaction.get(faturaRef),
        transaction.get(chaveCompetenciaRef),
      ])
      if (
        chaveCompetenciaSnap.exists &&
        (chaveCompetenciaSnap.get('uc') !== uc ||
         chaveCompetenciaSnap.get('referenciaKey') !== referenciaKey)
      ) {
        throw new HttpsError('data-loss', 'A chave de controle da competência está inconsistente.')
      }
      const existingInvoice = faturaAtualSnap.exists ? faturaAtualSnap.data() : null
      if (existingInvoice && ['disponivel', 'historico'].includes(existingInvoice.status)) {
        throw new HttpsError('already-exists', 'Esta fatura já foi publicada. Nenhuma versão foi sobrescrita.')
      }

      const unidades = unidadesSnap.docs
        .map((document) => ({ id: document.id, ...document.data() }))
        .filter((unidade) =>
          normalizarUC(unidade.numeroUC) === uc ||
          normalizarUC(unidade.numeroUC) === ucExtraida ||
          normalizarUC(unidade.codigoInstalacao) === ucExtraida,
        )
      if (unidades.length !== 1) {
        throw new HttpsError(
          'failed-precondition',
          unidades.length
            ? 'Há mais de um cadastro para esta UC. Corrija a ambiguidade antes de publicar.'
            : 'UC não cadastrada. Cadastre ou corrija a unidade consumidora antes de publicar.',
        )
      }

      const unidade = unidades[0]
      if (
        normalizarUC(unidade.numeroUC) !== uc ||
        (normalizarUC(unidade.numeroUC) !== ucExtraida &&
         normalizarUC(unidade.codigoInstalacao) !== ucExtraida)
      ) {
        throw new HttpsError('failed-precondition', 'A UC extraída diverge da UC canônica cadastrada.')
      }
      const cliente = clientesSnap.docs
        .map((document) => ({ id: document.id, ...document.data() }))
        .find((item) =>
          String(item.uid || '') === String(unidade.clienteId) ||
          String(item.id) === String(unidade.clienteId),
        )
      if (!cliente?.uid || cliente.contaFirebase === false) {
        throw new HttpsError(
          'failed-precondition',
          'A UC precisa estar vinculada a um cadastro de cliente com acesso autenticado.',
        )
      }
      if (!storagePath.startsWith(`faturas/${cliente.uid}/${uc}/`)) {
        throw new HttpsError('permission-denied', 'O PDF não está no caminho privado do cliente vinculado à UC.')
      }

      const periodo = faturasSnap.docs
        .map((document) => ({
          ...document.data(),
          ref: document.ref,
          documentId: document.id,
        }))
        .filter((fatura) =>
          fatura.documentId !== faturaId &&
          normalizarUC(fatura.uc) === uc &&
          String(fatura.referenciaKey || String(fatura.referencia || '').replace(/\s/g, '')) === referenciaKey,
        )
      if (periodo.some((fatura) => fatura.hashArquivo === hashArquivo)) {
        throw new HttpsError('already-exists', 'Este mesmo PDF já foi enviado para a UC e competência.')
      }

      const versao = Math.max(0, ...periodo.map((fatura) => Number(fatura.versao) || 0)) + 1
      const now = FieldValue.serverTimestamp()
      const safeInvoice = {
        ...(existingInvoice || {}),
        ...data.fatura,
        id: faturaId,
        idFatura: faturaId,
        clienteId: cliente.uid,
        clienteIdLocal: cliente.id === cliente.uid ? null : cliente.id,
        ucId: unidade.id,
        uc,
        ucKey: uc,
        referencia,
        referenciaKey,
        storagePath,
        hashArquivo,
        status: 'disponivel',
        versao,
        versaoAtual: true,
        criadoEm: now,
        publicadoEm: now,
        administradorUid: actor.uid,
        administradorEmail: actorEmail,
        operationId,
      }
      delete safeInvoice.statusProcessamento
      delete safeInvoice.pendenteVinculacao

      const auditRef = db.collection('logs').doc(randomUUID())
      for (const anterior of periodo) {
        transaction.update(anterior.ref, {
          status: 'historico',
          versaoAtual: false,
          substituidaPor: faturaId,
          substituidaEm: now,
          operationId,
        })
      }
      transaction.set(faturaRef, safeInvoice, { merge: Boolean(existingInvoice) })
      transaction.set(chaveCompetenciaRef, {
        uc,
        referenciaKey,
        ultimaFaturaId: faturaId,
        versao,
        atualizadoEm: now,
        operationId,
      }, { merge: true })
      transaction.set(auditRef, {
        actorUid: actor.uid,
        actorEmail,
        actorRole: actor.token.role || (actorEmail === masterEmail ? 'master' : 'admin'),
        operation: periodo.length ? 'INVOICE_VERSION_PUBLISHED' : 'INVOICE_PUBLISHED',
        entity: 'faturas',
        entityId: faturaId,
        clienteId: cliente.uid,
        uc,
        before: periodo.map((item) => ({
          id: item.documentId,
          versao: item.versao || 1,
          status: item.status,
        })),
        after: { id: faturaId, versao, status: 'disponivel', referencia },
        operationId,
        result: 'success',
        createdAt: now,
      })
      return {
        version: versao,
        clienteId: cliente.uid,
        clienteIdLocal: cliente.id,
        faturaId,
      }
    })
  } catch (error) {
    if (error instanceof HttpsError) return rejeitarPublicacao(error)
    return rejeitarPublicacao(new HttpsError('internal', 'Não foi possível concluir a publicação da fatura.'))
  }
  return { ok: true, ...resultado, operationId }
})

exports.removerFaturaAdministrativa = onCall(async (request) => {
  const actor = authenticated(request)
  const actorEmail = String(actor.token.email || '').toLowerCase()
  const profile = actorEmail
    ? await db.collection('usuarios').doc(actorEmail).get()
    : null
  const isAdmin = actor.token.admin === true ||
    actor.token.role === 'admin' ||
    actorEmail === masterEmail ||
    ['guladpizza@gmail.com', '1986.andersonbernardo@gmail.com'].includes(actorEmail)
  if (!isAdmin || (profile?.exists && profile.get('status') === 'inativo')) {
    await registrarAuditoria({
      actorUid: actor.uid,
      actorEmail,
      actorRole: actor.token.role || 'unknown',
      operation: 'INVOICE_DELETE_DENIED',
      entity: 'faturas',
      entityId: request.data?.faturaId || null,
      result: 'denied',
    })
    throw new HttpsError('permission-denied', 'A conta não está autorizada a remover faturas.')
  }

  const faturaId = String(request.data?.faturaId || '').trim()
  if (!faturaId) throw new HttpsError('invalid-argument', 'Identificador da fatura obrigatório.')
  const faturaRef = db.collection('faturas').doc(faturaId)
  const faturaSnap = await faturaRef.get()
  if (!faturaSnap.exists) throw new HttpsError('not-found', 'Fatura não encontrada.')
  const fatura = faturaSnap.data()
  const operationId = randomUUID()
  const storagePath = String(fatura.storagePath || '')
  if (
    storagePath &&
    !storagePath.startsWith(`faturas/${fatura.clienteId}/${normalizarUC(fatura.uc)}/`)
  ) {
    throw new HttpsError('failed-precondition', 'O caminho do PDF não corresponde ao vínculo da fatura.')
  }

  await db.runTransaction(async (transaction) => {
    const current = await transaction.get(faturaRef)
    if (!current.exists) throw new HttpsError('not-found', 'Fatura não encontrada.')
    transaction.update(faturaRef, {
      status: 'excluindo',
      versaoAtual: false,
      administradorUid: actor.uid,
      operationId,
    })
    transaction.set(db.collection('logs').doc(randomUUID()), {
      actorUid: actor.uid,
      actorEmail,
      actorRole: actor.token.role || (actorEmail === masterEmail ? 'master' : 'admin'),
      operation: 'INVOICE_DELETE_STARTED',
      entity: 'faturas',
      entityId: faturaId,
      clienteId: fatura.clienteId || null,
      uc: fatura.uc || null,
      before: { status: fatura.status, storagePath: Boolean(storagePath) },
      after: { status: 'excluindo' },
      operationId,
      result: 'started',
      createdAt: FieldValue.serverTimestamp(),
    })
  })

  try {
    if (storagePath) await getStorage().bucket().file(storagePath).delete({ ignoreNotFound: true })
  } catch (error) {
    await faturaRef.update({ status: 'erro_exclusao', atualizadoEm: FieldValue.serverTimestamp() })
    await registrarAuditoria({
      actorUid: actor.uid,
      actorEmail,
      actorRole: actor.token.role || (actorEmail === masterEmail ? 'master' : 'admin'),
      operation: 'INVOICE_DELETE_FAILED',
      entity: 'faturas',
      entityId: faturaId,
      clienteId: fatura.clienteId || null,
      uc: fatura.uc || null,
      operationId,
      result: error.code || 'storage-error',
    })
    throw new HttpsError('internal', 'A fatura foi retirada do portal, mas o PDF não pôde ser removido.')
  }

  await faturaRef.update({
    status: 'removida',
    removidaEm: FieldValue.serverTimestamp(),
    atualizadoEm: FieldValue.serverTimestamp(),
  })
  await registrarAuditoria({
    actorUid: actor.uid,
    actorEmail,
    actorRole: actor.token.role || (actorEmail === masterEmail ? 'master' : 'admin'),
    operation: 'INVOICE_DELETED',
    entity: 'faturas',
    entityId: faturaId,
    clienteId: fatura.clienteId || null,
    uc: fatura.uc || null,
    before: { status: fatura.status, storagePath: Boolean(storagePath) },
    after: { status: 'removida' },
    operationId,
  })
  return { ok: true, operationId }
})

exports.registrarSolicitacaoAcessoFatura = onCall(async (request) => {
  const actor = authenticated(request)
  const faturaId = String(request.data?.faturaId || '').trim()
  if (!faturaId) throw new HttpsError('invalid-argument', 'Fatura inválida.')

  const invoiceSnap = await db.collection('faturas').doc(faturaId).get()
  if (!invoiceSnap.exists) throw new HttpsError('not-found', 'Fatura não encontrada.')
  const invoice = invoiceSnap.data()
  const actorEmail = String(actor.token.email || '').toLowerCase()
  const profile = actorEmail ? await db.collection('usuarios').doc(actorEmail).get() : null
  const isAdmin = actor.token.admin === true ||
    actor.token.role === 'admin' ||
    actorEmail === masterEmail ||
    ['guladpizza@gmail.com', '1986.andersonbernardo@gmail.com'].includes(actorEmail)
  const adminInactive = profile?.exists && profile.get('status') === 'inativo'
  if (adminInactive || (!isAdmin && (invoice.clienteId !== actor.uid || invoice.status !== 'disponivel'))) {
    await registrarAuditoria({
      actorUid: actor.uid,
      actorEmail: actorEmail || null,
      actorRole: actorEmail === masterEmail ? 'master' : isAdmin ? 'admin' : 'cliente',
      operation: 'PDF_ACCESS_DENIED',
      entity: 'faturas',
      entityId: faturaId,
      clienteId: invoice.clienteId || null,
      uc: invoice.uc || null,
      result: 'denied',
    })
    throw new HttpsError('permission-denied', 'Você não tem acesso a esta fatura.')
  }

  const role = actor.token.role ||
    (actorEmail === masterEmail ? 'master' : isAdmin ? 'admin' : 'cliente')
  await registrarAuditoria({
    actorUid: actor.uid,
    actorEmail: actorEmail || null,
    actorRole: role,
    operation: 'PDF_ACCESS_REQUESTED',
    entity: 'faturas',
    entityId: faturaId,
    clienteId: invoice.clienteId || null,
    uc: invoice.uc || null,
    operationId: randomUUID(),
  })
  return { ok: true, recorded: 'request' }
})

exports.revogarTokensDownloadLegados = onCall({ timeoutSeconds: 300 }, async (request) => {
  let actor
  try {
    actor = requireMaster(request)
  } catch (error) {
    await registrarAuditoria({
      actorUid: request.auth?.uid || null,
      actorEmail: request.auth?.token?.email || null,
      actorRole: request.auth?.token?.role || 'unknown',
      operation: 'LEGACY_DOWNLOAD_TOKEN_REVOCATION_DENIED',
      entity: 'storage',
      result: 'denied',
    })
    throw error
  }
  const operationId = String(request.data?.operationId || randomUUID())
  const pageToken = String(request.data?.pageToken || '')
  const bucket = getStorage().bucket()
  const [files, nextQuery] = await bucket.getFiles({
    prefix: 'faturas/',
    autoPaginate: false,
    maxResults: 50,
    ...(pageToken ? { pageToken } : {}),
  })

  let tokensRevogados = 0
  try {
    for (const file of files) {
      const [metadata] = await file.getMetadata()
      if (!metadata.metadata?.firebaseStorageDownloadTokens) continue
      const customMetadata = { ...metadata.metadata }
      delete customMetadata.firebaseStorageDownloadTokens
      await file.setMetadata({ metadata: customMetadata })
      tokensRevogados += 1
    }
  } catch (error) {
    await registrarAuditoria({
      actorUid: actor.uid,
      actorEmail: actor.token.email || null,
      actorRole: 'master',
      operation: 'LEGACY_DOWNLOAD_TOKEN_REVOCATION_FAILED',
      entity: 'storage',
      after: { filesScanned: files.length, tokensRevogados },
      operationId,
      result: error.code || 'partial-failure',
    })
    throw new HttpsError('internal', 'A revogação foi parcial. Execute novamente para continuar.')
  }

  await registrarAuditoria({
    actorUid: actor.uid,
    actorEmail: actor.token.email || null,
    actorRole: 'master',
    operation: 'LEGACY_DOWNLOAD_TOKENS_REVOKED',
    entity: 'storage',
    after: { filesScanned: files.length, tokensRevogados },
    operationId,
    result: 'success',
  })
  return {
    ok: true,
    filesScanned: files.length,
    tokensRevogados,
    nextPageToken: nextQuery?.pageToken || null,
    operationId,
  }
})

const camposAuditaveis = [
  'clienteId',
  'uc',
  'numeroUC',
  'distribuidora',
  'referencia',
  'status',
  'storagePath',
  'versao',
  'versaoAtual',
  'nome',
  'email',
  'cpfCnpj',
]

const resumo = (data = {}) =>
  Object.fromEntries(camposAuditaveis
    .filter((key) => data[key] !== undefined)
    .map((key) => [key, data[key]]))

const actorRoleFor = async (uid, authType) => {
  if (!uid) return authType === 'ADMIN' ? 'server' : 'unknown'
  try {
    const user = await auth.getUser(uid)
    const email = String(user.email || '').toLowerCase()
    if (email === masterEmail) return 'master'
    if (user.customClaims?.role === 'master') return 'unknown'
    if (user.customClaims?.role === 'admin' || user.customClaims?.admin === true) return 'admin'
    if (['guladpizza@gmail.com', '1986.andersonbernardo@gmail.com'].includes(email)) return 'admin'
    return 'cliente'
  } catch (error) {
    if (error.code === 'auth/user-not-found') return 'unknown'
    throw error
  }
}

const registrarAlteracao = (colecao, acao) => async (event) => {
  const beforeSnap = event.data?.before
  const afterSnap = event.data?.after
  const before = beforeSnap?.exists ? beforeSnap.data() : null
  const after = afterSnap?.exists ? afterSnap.data() : null
  if ((after || before)?.administradorUid && (after || before)?.operationId) return
  const data = after || before || {}
  const actorUid = event.authId || null
  const actorRole = await actorRoleFor(actorUid, event.authType)
  const operation = !before ? `${acao}_CREATED` : !after ? `${acao}_DELETED` : `${acao}_UPDATED`

  await registrarAuditoria({
    actorUid,
    actorRole,
    operation,
    entity: colecao,
    entityId: event.params.documentId,
    clienteId: data.clienteId || null,
    uc: data.uc || data.numeroUC || null,
    before: before ? resumo(before) : null,
    after: after ? resumo(after) : null,
    operationId: data.operationId || randomUUID(),
    logId: event.id,
  })
}

exports.auditClientes = onDocumentWritten('clientes/{documentId}', registrarAlteracao('clientes', 'CLIENT'))
exports.auditUnidades = onDocumentWritten('unidades/{documentId}', registrarAlteracao('unidades', 'UC'))
exports.auditFaturas = onDocumentWritten('faturas/{documentId}', registrarAlteracao('faturas', 'INVOICE'))
