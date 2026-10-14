# Provisionamento da conta administrativa no Firebase

Este guia resolve definitivamente a mensagem:

> "Sessão administrativa SEM acesso ao banco compartilhado. As alterações ficam
> salvas apenas neste navegador..."

## Administrador master e criação de usuários

O administrador master é `thyagopatriota2020@gmail.com`. Faça login com esta
conta no Firebase Authentication para operar em qualquer dispositivo. Na tela
**Usuários**, administradores operacionais podem consultar os perfis, mas apenas
o master pode criar ou remover usuários. Essa restrição existe tanto na
interface quanto nas Firestore Security Rules (`isMasterAdmin()`); não depende
de um perfil salvo pelo navegador.

Cadastre esta conta em **Firebase Console → Authentication → Users** caso ainda
não exista. Depois publique as rules:

```powershell
npx --yes firebase-tools login
npm run deploy:rules
```

Se a senha não corresponder, use **Recuperar senha** na tela de acesso
administrativo para receber um link de redefinição no e-mail da conta.

O endereço do master é uma identidade fixa das rules e permanece autorizado
mesmo se `VITE_ADMIN_EMAILS` for configurado para outros administradores. A
variável de ambiente pode listar administradores operacionais; nunca a use
como substituta das Firestore Security Rules.

## Por que isso acontece

O login administrativo valida as credenciais **no Firebase Authentication**
(fonte da verdade — `signInWithEmailAndPassword` em `src/firebase/auth.js`).
Sem uma sessão Firebase autenticada, o Firestore nega toda escrita
(`request.auth == null` nas Security Rules) e o sistema só consegue salvar os
dados no cache local do navegador.

Para que os mesmos dados apareçam em outros dispositivos, o login precisa ser
feito com a conta administrativa do **Firebase Authentication**. O cache local
do navegador não é compartilhado. As regras do projeto são associadas ao
projeto Firebase padrão `natureforce-65cdc`; se `VITE_FIREBASE_PROJECT_ID` foi
configurado no deploy, publique as regras também nesse projeto.

## Erro de acesso à coleção `preCadastros`

`firestore.rules` já restringe essa coleção a administradores (`isAdmin()`).
Não substitua essa regra por `allow read, write: if true`: isso exporia dados
de clientes sem autenticação. O erro normalmente significa que as regras locais
ainda não foram publicadas no **mesmo projeto** usado pelo site, ou que a conta
Firebase conectada não está autorizada.

Na raiz do projeto, autentique o Firebase CLI (não precisa instalá-lo
globalmente) e publique somente as regras do Firestore:

```bash
npx --yes firebase-tools login
npm run deploy:rules
```

O `firebase.json` deste repositório aponta a publicação para `firestore.rules`;
`.firebaserc` define o projeto padrão. Alternativamente, no Console Firebase,
abra o projeto correto → **Firestore Database → Rules**, publique o conteúdo
de `firestore.rules` e verifique a mensagem de publicação concluída.

Após publicar, confira se o e-mail exibido no erro é um dos autorizados nas
regras (`thyagopatriota2020@gmail.com`, `guladpizza@gmail.com` ou
`1986.andersonbernardo@gmail.com`). Para autorizar outra conta operacional com
segurança, atribua-lhe a custom claim `admin: true` com o script abaixo; isso
não concede permissão para criar/remover perfis administrativos. Em seguida,
saia e entre novamente para renovar o token.

## Passo a passo no Firebase Console

1. **Ativar o provedor E-mail/Senha**
   - Console do Firebase → projeto `natureforce-65cdc`
   - **Authentication → Sign-in method → Email/Password → Enable**

2. **Criar a conta do administrador**
   - **Authentication → Users → Add user**
   - E-mail: `thyagopatriota2020@gmail.com` para o master.
   - Senha: a MESMA senha usada no login do sistema
   - IMPORTANTE: se a conta já existir com outro e-mail, use o e-mail que está
     na lista de `firestore.rules` (função `isAdmin()`), ou atualize a lista.

3. **Publicar as Security Rules**
   - Na raiz do projeto, execute `npx --yes firebase-tools login` (uma vez) e
     `npm run deploy:rules`; ou
   - Console do Firebase → **Firestore Database → Rules** → publique o
     conteúdo de `firestore.rules` deste projeto.
   - Confirme que o projeto do Console corresponde ao `projectId` usado pelo
     site (`VITE_FIREBASE_PROJECT_ID` ou `natureforce-65cdc`).

4. **Entrar novamente**
   - Abra `/admin/login`, entre com o mesmo e-mail e senha.
   - O aviso desaparece e o rodapé do painel passa a indicar
     **"Firestore — banco compartilhado"** (modo `firestore`).

## Opcional (recomendado em produção): custom claim `admin: true`

As Security Rules aceitam duas formas de autorização:

1. E-mail na lista `isAdmin()` em `firestore.rules` (já suficiente);
2. Custom claim `admin: true` (recomendado: sobrevive a mudanças de e-mail).

Para definir o claim, use o SDK Admin (servidor/CLI, nunca o frontend). O projeto
já traz um script pronto:

```bash
# 1. salve a chave de serviço como serviceAccountKey.json na raiz do projeto
#    (Console → Configurações do projeto → Contas de serviço → Gerar nova chave privada)
# 2. defina a claim nos UIDs administrativos
npm run set-admin                       # usa os UIDs padrão do projeto
npm run set-admin -- UID1 UID2 UID3     # ou informe os UIDs
npm run set-admin -- --remove UID1      # remove a claim de um UID
```

O script `scripts/set-admin-claim.cjs`:
- valida que a conta existe no Firebase Auth (mostra o e-mail correspondente);
- define `{ admin: true }` em cada UID;
- lê a claim DE VOLTA para confirmar (prova de que funcionou).

> Depois de aplicar a claim, o usuário precisa **sair e entrar novamente** para
> o novo token valer (o token já emitido mantém as claims antigas até expirar).
> Se o e-mail também estiver na lista `isAdmin()` das Rules, a autorização vale
> de imediato, sem troca de token.

## Segurança

- A senha administrativa **NÃO** fica no código: vive apenas no Firebase
  Authentication (e no campo local de bootstrap, configurável por
  `VITE_ADMIN_PASSWORD` para o modo offline — altere-o em produção).
- O frontend **nunca** cria contas administrativas (`createUserWithEmailAndPassword`
  não é usado no fluxo de login admin).
- O fallback local (sem internet / conta não provisionada) é restrito: quando o
  Firebase **rejeita** as credenciais (senha inválida, conta desativada,
  provedor desligado), o login falha — a decisão do Firebase prevalece.

---

# ATUALIZAÇÕES — publicar as regras novamente

As Security Rules deste repositório foram corrigidas. **Copie o conteúdo de
`firestore.rules` no Console (Firestore → Rules → Publish)**. As duas mudanças:

## 1. `delete` de `clientes` permitido ao administrador

Antes: `allow delete: if false` — o botão **Remover cliente** do painel falhava
em silêncio (o Firestore recusava e o cadastro voltava na sincronização
seguinte). Agora: `allow delete: if isAdmin()`.

## 2. `create` de `clientes` simplificado

Antes exigia `request.resource.data.email == request.auth.token.email`, mas o
cadastro guarda o e-mail de **contato** (o de login fica em `emailAcesso`) — a
gravação do próprio cliente era negada sem explicação. Agora: `isOwner` ou admin.

---

# PROVISIONAMENTO DE CLIENTES (automático)

O painel agora **cria a conta de acesso do cliente** no Firebase Authentication:

- ao cadastrar um cliente novo com e-mail e senha de acesso;
- ou pelo botão **Criar acesso** no cartão do cliente (clientes antigos).

Detalhes importantes:

- a conta é criada por uma **instância secundária** do Firebase — a sessão do
  administrador continua ativa (ver `criarContaCliente` em `src/firebase/auth.js`);
- se a conta já existir, o sistema orienta a usar "Recuperar senha";
- **a senha do cliente não é gravada no Firestore** — apenas no cache local do
  navegador do administrador (`senhaAcesso`), para permitir a criação/reenvio;
- o cliente entra com o MESMO e-mail e senha cadastrados no painel.

> Ainda é possível criar contas manualmente no Console (Authentication →
> Users → Add user) — use o mesmo e-mail/senha cadastrados no painel.
