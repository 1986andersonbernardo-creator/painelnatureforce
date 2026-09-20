// ==================== Autorização administrativa ====================
// Fonte ÚNICA (frontend) de "quem é administrador".
//
// Por que existe: o administrador precisa de sessão no Firebase Authentication
// para gravar no banco compartilhado. As Firestore/Storage Security Rules
// autorizam por:
//   1. custom claim `admin: true`  (recomendado em produção); ou
//   2. e-mail presente na lista de administradores.
//
// Esta lista DEVE espelhar exatamente a lista de `firestore.rules` e
// `storage.rules`. Ela é configurável por variável de ambiente para não exigir
// edição de código a cada novo administrador:
//
//   VITE_ADMIN_EMAILS="admin@natureforce.com,outro@empresa.com"
//
// Módulo PURO (sem firebase, sem localStorage) — importável nos testes em Node.

import { normalizarEmail } from './persistencia.js'

// E-mail do administrador provisionado no Firebase Authentication e autorizado
// nas Security Rules. Fallback: mesma conta usada pelo login administrativo.
export const ADMIN_EMAILS = Object.freeze(
  String(
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ADMIN_EMAILS) ||
      'admin@natureforce.com',
  )
    .split(',')
    .map((email) => normalizarEmail(email))
    .filter(Boolean),
)

/**
 * E-mail pertence à lista de administradores?
 * @param {string} email
 * @returns {boolean}
 */
export const ehEmailAdmin = (email) => ADMIN_EMAILS.includes(normalizarEmail(email))

/**
 * O usuário pode administrar (claim `admin` OU e-mail na allowlist)?
 * Exatamente o mesmo critério do `isAdmin()` das Security Rules — evita o
 * cenário em que o frontend acredita que pode gravar e o banco nega.
 *
 * @param {{email?:string, claimAdmin?:boolean}} usuario
 * @returns {boolean}
 */
export const podeAdministrar = ({ email = '', claimAdmin = false } = {}) =>
  claimAdmin === true || ehEmailAdmin(email)

/**
 * Usuário autenticado no Firebase é administrador (pela identidade do token)?
 * @param {{email?:string, claimAdmin?:boolean}} usuario
 * @returns {boolean}
 */
export const usuarioFirebaseEhAdmin = (usuario) => podeAdministrar(usuario)
