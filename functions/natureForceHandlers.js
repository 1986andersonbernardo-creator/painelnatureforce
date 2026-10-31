const { createHash, randomUUID } = require('node:crypto')
const { buildInvoice, renderInvoice, validateSettings, money } = require('./natureForceInvoice')
const { resolveLinkedClient } = require('./invoiceLinking')

module.exports = function register({ onCall, HttpsError, db, bucket, authorize, FieldValue }) {
  const settingsRef = db.collection('configuracoes').doc('faturamentoNatureForce')
  const audit = (actor, operation, entityId, extra = {}) => ({
    actorUid: actor.uid, actorRole: 'admin', operation, entity: 'faturas', entityId,
    createdAt: FieldValue.serverTimestamp(), result: 'success', ...extra,
  })
  const settings = onCall(async (request) => {
    const { actor } = await authorize(request)
    if (request.data?.action === 'read') {
      const snap = await settingsRef.get()
      return { settings: snap.exists ? snap.data() : null }
    }
    let value
    try { value = validateSettings(request.data?.settings) }
    catch (error) { throw new HttpsError('invalid-argument', error.message) }
    await db.runTransaction(async (tx) => {
      tx.set(settingsRef, { ...value, revision: randomUUID(), updatedBy: actor.uid, updatedAt: FieldValue.serverTimestamp() })
      tx.set(db.collection('logs').doc(), audit(actor, 'INVOICE_SETTINGS_UPDATED', 'faturamentoNatureForce', { entity: 'configuracoes' }))
    })
    return { ok: true }
  })

  const emit = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    const { actor } = await authorize(request)
    const id = String(request.data?.faturaId || '')
    const operationId = String(request.data?.operationId || '')
    if (!/^[\w-]{1,120}$/.test(id) || !/^[\da-f-]{36}$/i.test(operationId)) throw new HttpsError('invalid-argument', 'Identificadores inválidos.')
    const ref = db.collection('faturas').doc(id)
    const versionRef = ref.collection('emissoesNatureForce').doc(operationId)
    const completed = await versionRef.get()
    if (completed.exists) return { ok: true, ...completed.data().publication, operationId }
    const [invoiceSnap, configSnap, unitsSnap, clientsSnap] = await Promise.all([
      ref.get(), settingsRef.get(), db.collection('unidades').get(), db.collection('clientes').get(),
    ])
    if (!invoiceSnap.exists) throw new HttpsError('not-found', 'Fatura não encontrada.')
    const invoice = invoiceSnap.data()
    if (['removida','excluindo','erro_exclusao','historico'].includes(invoice.status)) throw new HttpsError('failed-precondition', 'A fatura não está elegível para emissão.')
    const norm = (v) => String(v ?? '').replace(/\D/g, '')
    const units = unitsSnap.docs.filter(d => norm(d.get('numeroUC')) === norm(invoice.uc))
    if (units.length !== 1 || units[0].id !== invoice.ucId) throw new HttpsError('failed-precondition', 'UC ausente ou ambígua. Corrija o cadastro.')
    const unitSnap = units[0]
    const unit = { ...unitSnap.data(), id: unitSnap.id }
    const linked = resolveLinkedClient(unit, clientsSnap.docs.map(d => ({ ...d.data(), id: d.data().id || d.id })))
    if (!linked.ok) throw new HttpsError('failed-precondition', 'Vínculo autenticado do cliente ausente ou ambíguo.')
    const historySnap = await db.collection('faturas').where('ucId','==',unit.id).get()
    if (historySnap.docs.some(d => d.id !== id && d.get('referencia') === invoice.referencia && d.get('status') === 'disponivel' && d.get('versaoAtual') !== false)) {
      throw new HttpsError('failed-precondition', 'Já existe outra fatura publicada para esta UC e competência. Corrija a versão atual ou conclua a substituição administrativa do original antes de emitir.')
    }
    const generatedAt = new Date().toISOString()
    let snapshot
    try {
      snapshot = buildInvoice({ fatura: invoice, unidade: unit, cliente: linked.client,
        settings: configSnap.data(), generatedAt,
        approval: { ...request.data.approval, actorUid: actor.uid },
        history: historySnap.docs.map(d => d.data()),
      })
    } catch (error) { throw new HttpsError('failed-precondition', error.message) }
    if (invoice.pagamentoStatus === 'pago') throw new HttpsError('failed-precondition', 'Fatura já quitada. Revise administrativamente antes de corrigir a cobrança.')
    const bytes = await renderInvoice(snapshot)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const storagePath = `faturas/${invoice.clienteId}/${norm(invoice.uc)}/nf_${id}_${operationId}_${hash}.pdf`
    const file = bucket.file(storagePath)
    let uploaded = false
    try {
      await db.collection('logs').add(audit(actor, 'NATURE_FORCE_INVOICE_GENERATED', id, { operationId, after: { hashArquivo: hash, templateVersion: snapshot.templateVersion } }))
      await file.save(bytes, { resumable: false, contentType: 'application/pdf',
        preconditionOpts: { ifGenerationMatch: 0 }, metadata: { metadata: { faturaId: id } } })
      uploaded = true
      const [stored] = await file.download()
      if (createHash('sha256').update(stored).digest('hex') !== hash) throw new Error('Integridade do PDF não confirmada.')
      const publication = await db.runTransaction(async (tx) => {
        const [current, config, currentUnit, version, currentUnits, currentClients, currentHistory] = await Promise.all([
          tx.get(ref), tx.get(settingsRef), tx.get(unitSnap.ref), tx.get(versionRef),
          tx.get(db.collection('unidades')), tx.get(db.collection('clientes')),
          tx.get(db.collection('faturas').where('ucId','==',unit.id)),
        ])
        if (version.exists) return version.data().publication
        const unchanged = (a,b) => a.exists && b.exists && a.updateTime.isEqual(b.updateTime)
        const sameQuery = (a,b) => a.docs.length === b.docs.length && a.docs.every((d,i) => d.id === b.docs[i].id && unchanged(d,b.docs[i]))
        if (!unchanged(current,invoiceSnap) || !unchanged(config,configSnap) || !unchanged(currentUnit,unitSnap) ||
            !sameQuery(currentUnits,unitsSnap) || !sameQuery(currentClients,clientsSnap) || !sameQuery(currentHistory,historySnap)) {
          throw new HttpsError('aborted','Os dados mudaram durante a emissão. Revise e tente novamente.')
        }
        const publication = { storagePath, hashArquivo: hash, templateVersion: snapshot.templateVersion,
          versao: (current.get('natureForce.versao') || 0)+1, operationId, generatedAt,
          numero: snapshot.numero, valorAprovado: snapshot.total, percentualDesconto: snapshot.percentualDesconto }
        tx.create(versionRef, { snapshot, publication, administradorUid: actor.uid, criadoEm: FieldValue.serverTimestamp() })
        // Preserve the original distributor PDF and every prior Nature Force version.
        tx.update(ref, { natureForce: publication,
          valorTotal: snapshot.approval.motivoRetificacao ? Number(snapshot.total) : invoice.valorTotal,
          status: 'disponivel' })
        tx.set(db.collection('logs').doc(), audit(actor, current.get('natureForce') ? 'NATURE_FORCE_INVOICE_CORRECTED' : 'NATURE_FORCE_INVOICE_PUBLISHED', id,
          { operationId, after: { versao: publication.versao, templateVersion: publication.templateVersion } }))
        return publication
      })
      if (publication.storagePath !== storagePath) await file.delete({ ignoreNotFound: true })
      return { ok: true, ...publication, operationId }
    } catch (error) {
      // A lost response after a committed transaction must not delete the published PDF.
      const committed = await versionRef.get()
      if (committed.exists) return { ok: true, ...committed.data().publication, operationId }
      if (uploaded) await file.delete({ ignoreNotFound: true }).catch(async () => {
        await db.collection('logs').add(audit(actor, 'NATURE_FORCE_INVOICE_CLEANUP_FAILED', id, { operationId, result: 'cleanup-failed' }))
      })
      await db.collection('logs').add(audit(actor, 'NATURE_FORCE_INVOICE_FAILED', id, { operationId, result: error.code || 'failed' }))
      if (error instanceof HttpsError) throw error
      throw new HttpsError('internal', 'Emissão não publicada. Tente novamente; o documento anterior foi preservado.')
    }
  })

  // Download uses central records and never writes invoices, versions or Storage.
  const download = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    await authorize(request)
    const id = String(request.data?.faturaId || '')
    if (!/^[\w-]{1,120}$/.test(id)) throw new HttpsError('invalid-argument', 'Identificador inválido.')
    const [invoiceSnap, configSnap, unitsSnap, clientsSnap] = await Promise.all([
      db.collection('faturas').doc(id).get(), settingsRef.get(),
      db.collection('unidades').get(), db.collection('clientes').get(),
    ])
    if (!invoiceSnap.exists) throw new HttpsError('not-found', 'Cobrança não encontrada.')
    const invoice = { ...invoiceSnap.data(), id }
    if (['removida','excluindo','erro_exclusao','historico'].includes(invoice.status)) throw new HttpsError('failed-precondition', 'Cobrança indisponível para download.')
    const norm = v => String(v ?? '').replace(/\D/g, '')
    const units = unitsSnap.docs.filter(d => norm(d.get('numeroUC')) === norm(invoice.uc))
    if (units.length !== 1 || units[0].id !== invoice.ucId) throw new HttpsError('failed-precondition', 'Corrija o vínculo da UC antes de gerar o PDF.')
    const unit = { ...units[0].data(), id: units[0].id }
    const linked = resolveLinkedClient(unit, clientsSnap.docs.map(d => ({ ...d.data(), id: d.data().id || d.id })))
    if (!linked.ok) throw new HttpsError('failed-precondition', 'Vínculo do cliente ausente ou ambíguo.')
    let snapshot
    try {
      snapshot = buildInvoice({ fatura: invoice, unidade: unit, cliente: linked.client,
        settings: configSnap.data(), generatedAt: new Date().toISOString(), downloadOnly: true })
    } catch (error) { throw new HttpsError('failed-precondition', error.message) }
    const bytes = await renderInvoice(snapshot)
    return { pdfBase64: bytes.toString('base64'), filename: `NatureForce-${id}.pdf` }
  })

  const settle = onCall(async (request) => {
    const { actor } = await authorize(request)
    const id = String(request.data?.faturaId || '')
    const note = String(request.data?.comprovanteReferencia || '').trim()
    if (!/^[\w-]{1,120}$/.test(id) || !note || note.length > 200) throw new HttpsError('invalid-argument','Informe a fatura e a referência do comprovante conferido (até 200 caracteres).')
    await db.runTransaction(async (tx) => {
      const ref = db.collection('faturas').doc(id)
      const snap = await tx.get(ref)
      if (!snap.exists || !snap.get('natureForce') || snap.get('status') !== 'disponivel') throw new HttpsError('failed-precondition','Fatura Nature Force publicada não encontrada.')
      if (snap.get('pagamentoStatus') === 'pago') return
      tx.update(ref, { pagamentoStatus:'pago', baixaManual: { actorUid:actor.uid, data:FieldValue.serverTimestamp(), comprovanteReferencia:note, valor:money(snap.get('valorTotal')) } })
      tx.set(db.collection('logs').doc(),audit(actor,'INVOICE_MANUALLY_SETTLED',id))
    })
    return { ok:true }
  })
  return { gerarPdfFaturaNatureForce: download, configurarFaturamentoNatureForce: settings, emitirFaturaNatureForce: emit, baixarFaturaNatureForceManualmente: settle }
}
