# Provisionamento administrativo e acesso ao banco compartilhado

Todo acesso administrativo depende de uma conta autenticada no Firebase
Authentication. Não existe autenticação administrativa offline ou senha
administrativa no código, em variáveis `VITE_*` ou no cache do navegador.

## Administrador master e criação de usuários

O administrador master é `thyagopatriota2020@gmail.com`. Faça login com esta
conta no Firebase Authentication para operar em qualquer dispositivo. Na tela
**Usuários**, administradores operacionais podem consultar os perfis, mas apenas
o master pode convidar, editar o nome, ativar, desativar ou excluir usuários.
Essas ações passam por Cloud Functions; as Security Rules bloqueiam gravações
diretas nos perfis administrativos.

Cadastre a conta master em **Firebase Console → Authentication → Users** caso
ainda não exista. Convites para administradores operacionais são enviados pelo
master e permitem ao destinatário definir a própria senha. Para isso, configure
os secrets SMTP descritos no `README.md` e publique rules e Functions:

```powershell
npx --yes firebase-tools login
npm run deploy:rules
npm run deploy:functions
```

Se a senha não corresponder, use **Recuperar senha** na tela de acesso
administrativo para receber um link de redefinição no e-mail da conta.

O e-mail do master é a única identidade autorizada a gerenciar administradores.
Administradores operacionais legados permanecem alinhados à allowlist das
Rules; novas contas recebem uma custom claim pelo fluxo de convite.

## Faturas e PDFs visíveis no portal do cliente

O portal consulta faturas pelo UID da conta Firebase do cliente e só mostra as
que têm `status: "disponivel"`. O painel publica novas faturas depois da revisão.
Ao entrar um administrador autenticado, o sistema também migra faturas e UCs
legadas do ID local do cliente para o UID quando esse UID já está vinculado.

Os PDFs novos são enviados ao Firebase Storage em
`faturas/{uid}/{uc}/{id-da-fatura}.pdf`. Para habilitar upload e download:

1. Confirme no Console do Firebase que o **Storage** está inicializado no
   projeto `natureforce-65cdc` e que existe um bucket configurado.
2. Na raiz do projeto, execute:

   ```powershell
   npm run deploy:storage
   ```

3. Importe a fatura após provisionar o acesso Firebase do cliente. O painel
   informa se o upload compartilhado falhar. O cliente deve entrar com a conta
   Firebase correspondente para visualizar e baixar o PDF.

Faturas antigas sem PDF compartilhado podem ser migradas reenviando o mesmo PDF
no painel. Se o cliente tiver UID e a fatura já estiver cadastrada, a duplicata
é reconhecida e o PDF é enviado ao Storage sem criar outra fatura.

Na aba **Faturas**, administradores também podem usar **Remover todas as
faturas** para preparar um novo teste: a ação pede confirmação, remove os PDFs
do Storage e tira as faturas do portal dos clientes, mas preserva os registros
marcados como removidos e a auditoria. PDFs apagados podem ser enviados
novamente. Para disponibilizar a ação, publique a nova versão do site e as
Cloud Functions com `npm run deploy:functions`. Não é necessário alterar as
regras do Firestore ou do Storage para essa operação.

## Por que isso acontece

O login administrativo autentica exclusivamente no Firebase Authentication.
Sem conexão ou sessão válida, o login falha — o cache local não concede acesso
ao painel administrativo. O cache local do navegador não é compartilhado.
As regras e Functions devem ser publicadas no projeto `natureforce-65cdc`,
correspondente à configuração Firebase padrão do site.

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

2. **Provisionar as contas**
   - A conta master deve existir no Firebase Authentication; crie-a no Console
     se ainda não existir.
   - Administradores operacionais devem ser convidados pelo master na tela
     **Usuários** após publicar a Function e configurar SMTP.

3. **Publicar as Security Rules**
   - Na raiz do projeto, execute `npx --yes firebase-tools login` (uma vez) e
     `npm run deploy:rules`; ou
   - Console do Firebase → **Firestore Database → Rules** → publique o
     conteúdo de `firestore.rules` deste projeto.
   - Confirme que o projeto do Console corresponde ao `projectId` usado pelo
     site (`VITE_FIREBASE_PROJECT_ID` ou `natureforce-65cdc`).

4. **Entrar novamente**
   - Abra `/admin/login` e entre com a conta Firebase autorizada.
   - A sincronização com o banco compartilhado só ocorre com a sessão
     autenticada pelo Firebase.

## Segurança

- Senhas vivem apenas no Firebase Authentication; a interface não as grava nem
  cria senhas para administradores.
- O fluxo de convite e as mudanças de perfil usam Cloud Functions autorizadas
  exclusivamente ao master. Não copie chaves de serviço para o frontend.
- Desativação marca o perfil como inativo antes de alterar a conta Auth, para
  que as Rules bloqueiem o acesso imediatamente.

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
