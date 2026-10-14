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
//   VITE_ADMIN_EMAILS="guladpizza@gmail.com,1986.andersonbernardo@gmail.com"
//
// Módulo PURO (sem firebase, sem localStorage) — importável nos testes em Node.

import { normalizarEmail } from './persistencia.js'

export const MASTER_ADMIN_EMAIL = 'thyagopatriota2020@gmail.com'

const ADMIN_EMAILS_PADRAO = 'guladpizza@gmail.com,1986.andersonbernardo@gmail.com'

// O master permanece autorizado mesmo quando a lista de administradores é
// sobrescrita em deploy. Esta lista espelha os administradores operacionais
// de firestore.rules/storage.rules; o master é reconhecido separadamente.
export const ADMIN_EMAILS = Object.freeze(
  Array.from(
    new Set([
      MASTER_ADMIN_EMAIL,
      ...String(
        (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ADMIN_EMAILS) ||
          ADMIN_EMAILS_PADRAO,
      )
        .split(',')
        .map((email) => normalizarEmail(email))
        .filter(Boolean),
    ]),
  ),
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
