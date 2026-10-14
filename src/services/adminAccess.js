// ==================== Autorização administrativa ====================
// Fonte ÚNICA (frontend) de "quem é administrador".
//
// A lista legada precisa permanecer alinhada às Firestore/Storage Rules.
// Novos administradores recebem a custom claim pelo fluxo de convite no servidor.
//
// Módulo PURO (sem firebase, sem localStorage) — importável nos testes em Node.

import { normalizarEmail } from './persistencia.js'

export const MASTER_ADMIN_EMAIL = 'thyagopatriota2020@gmail.com'

const ADMIN_EMAILS_PADRAO = 'guladpizza@gmail.com,1986.andersonbernardo@gmail.com'

// Esta lista espelha os administradores operacionais legados das Rules.
export const ADMIN_EMAILS = Object.freeze(
  Array.from(new Set([
    MASTER_ADMIN_EMAIL,
    ...ADMIN_EMAILS_PADRAO.split(',').map((email) => normalizarEmail(email)).filter(Boolean),
  ])),
)

export const ehEmailAdminMaster = (email) =>
  normalizarEmail(email) === MASTER_ADMIN_EMAIL

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

/**
 * O usuário autenticado é o administrador master, único autorizado a criar
 * ou remover perfis administrativos.
 * @param {{email?:string}} usuario
 * @returns {boolean}
 */
export const usuarioFirebaseEhAdminMaster = ({ email = '' } = {}) =>
  ehEmailAdminMaster(email)
