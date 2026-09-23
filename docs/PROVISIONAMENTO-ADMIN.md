# Provisionamento da conta administrativa no Firebase

Este guia resolve definitivamente a mensagem:

> "Sessão administrativa SEM acesso ao banco compartilhado. As alterações ficam
> salvas apenas neste navegador..."

## Por que isso acontece

O login administrativo valida as credenciais **no Firebase Authentication**
(fonte da verdade — `signInWithEmailAndPassword` em `src/firebase/auth.js`).
Sem uma sessão Firebase autenticada, o Firestore nega toda escrita
(`request.auth == null` nas Security Rules) e o sistema só consegue salvar os
dados no cache local do navegador.

## Passo a passo no Firebase Console

1. **Ativar o provedor E-mail/Senha**
   - Console do Firebase → projeto `natureforce-65cdc`
   - **Authentication → Sign-in method → Email/Password → Enable**

2. **Criar a conta do administrador**
   - **Authentication → Users → Add user**
   - E-mail: o MESMO e-mail usado em `/admin/login` (padrão: `admin@natureforce.com`)
   - Senha: a MESMA senha usada no login do sistema
   - IMPORTANTE: se a conta já existir com outro e-mail, use o e-mail que está
     na lista de `firestore.rules` (função `isAdmin()`), ou atualize a lista.

3. **Publicar as Security Rules atualizadas** (obrigatório depois das últimas
   alterações — agora existem regras para `usuarios` e `logs`)
   - Console do Firebase → **Firestore Database → Rules**
   - Cole o conteúdo de `firestore.rules` deste projeto → **Publish**

4. **Entrar novamente**
   - Abra `/admin/login`, entre com o mesmo e-mail e senha.
   - O aviso desaparece e o rodapé do painel passa a indicar
     **"Firestore — banco compartilhado"** (modo `firestore`).

## Opcional (recomendado em produção): custom claim `admin: true`

As Security Rules aceitam duas formas de autorização:

1. E-mail na lista `isAdmin()` em `firestore.rules` (já suficiente);
2. Custom claim `admin: true` (recomendado: sobrevive a mudanças de e-mail).

Para definir o claim, use o SDK Admin (servidor/CLI, nunca o frontend):

```bash
npm i -D firebase-admin
# salve a chave de serviço (Console → Configurações do projeto → Contas de serviço)
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node -e "
const admin = require('firebase-admin');
admin.initializeApp();
admin.auth().setCustomUserClaims('<UID_DO_ADMIN>', { admin: true })
  .then(() => console.log('claim admin definido'))
  .finally(() => process.exit());
"
```

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
