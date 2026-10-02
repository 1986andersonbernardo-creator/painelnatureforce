// ==================== Definir custom claim `admin: true` ====================
// Servidor/CLI (NUNCA frontend): usa o SDK Admin para marcar contas do Firebase
// Authentication como administradoras. A claim é lida pelas Security Rules
// (firestore.rules → isAdmin(): request.auth.token.admin == true), então o
// usuário passa a ter acesso administrativo inclusive após trocar de e-mail.
//
// PRÉ-REQUISITO (uma vez):
//   1. Console do Firebase → Configurações do projeto → Contas de serviço
//      → "Gerar nova chave privada" → salvar como `serviceAccountKey.json` na
//      raiz do projeto (o arquivo está no .gitignore — NUNCA comitar).
//   2. npm i -D firebase-admin  (já instalado no projeto)
//
// USO:
//   node scripts/set-admin-claim.cjs                       # contas padrão abaixo
//   node scripts/set-admin-claim.cjs UID_OU_EMAIL ...      # contas informadas
//   node scripts/set-admin-claim.cjs --remove UID_OU_EMAIL # remove a claim
//
// Cada argumento pode ser um UID OU um e-mail (o script resolve o e-mail → UID).
//
// O script:
//   - localiza a conta (por UID ou e-mail) e mostra UID + e-mail;
//   - define { admin: true } em cada conta;
//   - lê a claim DE VOLTA para confirmar (prova de que funcionou).

const fs = require('node:fs');
const path = require('node:path');

const admin = require('firebase-admin');

// Administradores deste projeto — informados por UID (podem ser sobrescritos
// por argumento, em UID ou e-mail).
const UIDS_PADRAO = [
  '1qJna0D81JYSiEs2xNyrHfaC6B83',
  'fBNmfJzvL8eIDUuwr3dtR97566M2',
];

const CAMINHO_CHAVE = path.join(__dirname, '..', 'serviceAccountKey.json');

/**
 * Lê as contas (UID ou e-mail) e a ação (definir ou remover) da CLI.
 * @returns {{ alvos: string[], remover: boolean }}
 */
function lerArgumentos() {
  const args = process.argv.slice(2);
  const remover = args.includes('--remove');
  const alvos = args.filter((a) => !a.startsWith('--'));
  return { alvos: alvos.length ? alvos : UIDS_PADRAO, remover };
}

/**
 * Resolve um alvo (UID ou e-mail) para o usuário do Firebase Auth.
 * @param {string} alvo
 * @returns {Promise<Object>} usuário (com uid e email)
 */
async function resolverUsuario(alvo) {
  if (String(alvo).includes('@')) {
    return admin.auth().getUserByEmail(String(alvo).trim().toLowerCase());
  }
  return admin.auth().getUser(alvo);
}

/**
 * Inicializa o SDK Admin usando a chave de serviço do projeto.
 * Mensagem clara caso o arquivo ainda não exista.
 */
function inicializarAdmin() {
  if (!fs.existsSync(CAMINHO_CHAVE)) {
    console.error(
      '\n[ERRO] "serviceAccountKey.json" não encontrado em:\n  ' +
        CAMINHO_CHAVE +
        '\n\nBaixe a chave em: Console do Firebase → Configurações do projeto →' +
        '\nContas de serviço → Gerar nova chave privada.\n',
    );
    process.exitCode = 1;
    return false;
  }

  const credencial = admin.credential.cert(require(CAMINHO_CHAVE));
  admin.initializeApp({ credential: credencial });
  return true;
}

/**
 * Aplica (ou remove) a claim `admin` em um único alvo (UID ou e-mail), com validação.
 * @param {string} alvo
 * @param {boolean} remover
 * @returns {Promise<boolean>} true se a operação foi confirmada
 */
async function processarAlvo(alvo, remover) {
  const claims = remover ? { admin: null } : { admin: true };

  // 1. Localiza a conta (por UID ou e-mail) — evita "sucesso" em alvo inexistente.
  let usuario;
  try {
    usuario = await resolverUsuario(alvo);
  } catch (e) {
    console.error(`  [FALHA] ${alvo} — conta não encontrada no Firebase Auth (${e.code || e.message}).`);
    console.error('          Verifique o UID/e-mail em Authentication → Users.');
    return false;
  }

  const uid = usuario.uid;

  // 2. Define a claim.
  try {
    await admin.auth().setCustomUserClaims(uid, claims);
  } catch (e) {
    console.error(`  [FALHA] ${uid} — não foi possível definir a claim (${e.message}).`);
    return false;
  }

  // 3. Lê a claim de volta — prova de que a gravação funcionou.
  const atualizado = await admin.auth().getUser(uid);
  const confirmado = remover
    ? atualizado.customClaims?.admin !== true
    : atualizado.customClaims?.admin === true;

  const acao = remover ? 'REMOVER' : 'DEFINIR';
  const marca = confirmado ? '[OK]   ' : '[AVISO]';
  console.log(
    `  ${marca} ${acao} admin → ${uid}  | e-mail: ${usuario.email || '(sem e-mail)'}  | ` +
      `claim atual: ${JSON.stringify(atualizado.customClaims || {})}`,
  );
  return confirmado;
}

async function principal() {
  if (!inicializarAdmin()) return;

  const { alvos, remover } = lerArgumentos();
  console.log(
    `\n${remover ? 'Removendo' : 'Definindo'} a claim admin:true para ${alvos.length} conta(s)...\n`,
  );

  const resultados = [];
  for (const alvo of alvos) {
    // Sequencial: operações administrativas — evita corrida e logs confusos.
    resultados.push(await processarAlvo(alvo, remover));
  }

  const ok = resultados.filter(Boolean).length;
  console.log(`\nConcluído: ${ok}/${alvos.length} conta(s) processada(s) com sucesso.`);
  if (ok !== alvos.length) {
    console.log('Algumas contas falharam — veja as mensagens acima.');
  } else {
    console.log(
      'A claim é reconhecida pelas Security Rules (isAdmin → request.auth.token.admin == true).\n' +
        'O usuário precisa SAIR e ENTRAR novamente (ou renovar o token) para o novo token valer.\n',
    );
  }
  process.exitCode = ok === alvos.length ? 0 : 1;
}

principal()
  .catch((e) => {
    console.error('\n[ERRO INESPERADO]', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => {
    // Encerra o processo (o SDK Admin mantém conexões abertas).
    process.exit(process.exitCode || 0);
  });