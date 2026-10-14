const resolveLinkedClient = (unit, clientDocuments) => {
  const linkedId = String(unit?.clienteId || '')
  if (!linkedId) {
    return { ok: false, reason: 'missing-client', client: null }
  }

  const candidates = clientDocuments.filter(
    (client) =>
      String(client?.uid || '') === linkedId ||
      String(client?.id || '') === linkedId,
  )
  const identities = new Map()
  for (const candidate of candidates) {
    const identity = String(candidate.uid || candidate.id || '')
    const current = identities.get(identity)
    if (!current || (!current.uid && candidate.uid)) {
      identities.set(identity, candidate)
    }
  }

  if (identities.size > 1) {
    return { ok: false, reason: 'ambiguous-client', client: null }
  }

  const client = identities.values().next().value || null
  if (!client?.uid || client.contaFirebase === false) {
    return { ok: false, reason: 'missing-authenticated-client', client: null }
  }

  return { ok: true, reason: null, client }
}

module.exports = { resolveLinkedClient }
