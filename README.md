# Nature Force — Área do Cliente

Portal web dos clientes da Nature Force + painel administrativo. Mostra faturas
de energia, consumo, economia (desconto de 20% sobre a parcela elegível),
atendimento e cadastro — com processamento automático de PDFs de fatura.

## Stack

| Camada | Tecnologia |
|---|---|
| Front-end | React 19 + Vite 8 + react-router-dom 7 |
| Banco / autenticação | Firebase (Firestore + Authentication) |
| PDF | pdfjs-dist (build principal + fallback legacy) |
| Cache local | localStorage (cache de dados) + Firebase Storage (PDFs compartilhados) |
| Lint / testes | oxlint · `node --test` |
| Deploy | Vercel (rewrites de SPA em `vercel.json`) |

## Rodando localmente

```bash
npm install
npm run dev      # ambiente de desenvolvimento
npm run build    # build de produção (verifica o bundle)
npm run lint     # análise estática
npm test         # testes dos módulos puros (identificação, dedup, desconto, PDF)
```

## Rotas

```
/                   → redireciona para /login
/login              → login do cliente
/admin/login        → login administrativo
/admin/dashboard    → painel administrativo (protegido, perfil admin)
/cliente/dashboard  → área do cliente (protegida, perfil cliente)
```

## Arquitetura em uma frase

**Firestore e Firebase Storage são as fontes compartilhadas; o cache local é
apenas uma otimização da interface.** O portal de clientes consulta as faturas
autorizadas em tempo real pelo UID autenticado.

## Fluxos principais

1. **Login** → Firebase Auth → ponte de identidade `vincularClienteAoUid`
   (propaga o UID para UCs/faturas) → dashboard.
2. **Importação de PDF** (admin) → valida assinatura `%PDF-` → identifica a UC
   e o cadastro único → envia o PDF privado ao Storage → uma callable Function
   confirma a UC/cliente e a existência do arquivo, versiona a competência e
   grava os metadados como disponíveis. UC ausente, ambígua ou sem cliente
   autenticado não é publicada.
3. **Pré-cadastro** — UC nova no PDF vira pré-cadastro; o admin confirma
   (cria cliente) **ou** associa a um cliente existente (sem duplicar cadastro).
4. **Atendimento** — cliente envia solicitação, admin atualiza o status, o
   cliente acompanha em tempo real.
5. **Exclusões** — são propagadas ao banco com o ID correto do documento e a
   falha (se houver) é informada ao usuário.

## Segurança

- `firestore.rules` — clientes só leem o próprio perfil, UCs e faturas
  publicadas; só administradores editam dados de negócio. Perfis de
  administradores e logs não podem ser escritos pelo cliente.
- `storage.rules` — PDFs privados; a leitura do cliente exige UID, UC, caminho e
  fatura publicada correspondentes no Firestore. A aplicação usa `getBlob()`
  com a sessão autenticada, não URL compartilhável com token.
- `functions/` — gerenciamento de administradores exclusivamente pelo master,
  convite por e-mail, publicação/versionamento serializado de faturas e auditoria server-side.
  A auditoria registra solicitações de acesso ao PDF, não confirma que o arquivo
  foi efetivamente baixado.
- `firestore.indexes.json` — índice composto da consulta de faturas autorizadas.
- PDFs enviados antes da integração com o Storage continuam somente no
  IndexedDB do navegador de origem. Reenvie o mesmo PDF no painel para
  sincronizar uma fatura já cadastrada.
- **Credenciais nunca são espelhadas no banco**: `senha`/`senhaAcesso` são
  removidas do payload por `itemParaBanco()` antes de qualquer gravação.
- As regras, índices e Functions nesta alteração são arquivos locais e ainda
  precisam ser publicados. O projeto configurado e ativo conferido é
  `natureforce-65cdc`. O deploy de Functions exige plano Firebase com billing
  habilitado.
- Configure o serviço SMTP no Secret Manager (nunca no frontend ou no Git),
  informando cada valor quando o CLI solicitar:
  ```bash
  npx firebase-tools functions:secrets:set SMTP_HOST --project natureforce-65cdc
  npx firebase-tools functions:secrets:set SMTP_PORT --project natureforce-65cdc
  npx firebase-tools functions:secrets:set SMTP_USER --project natureforce-65cdc
  npx firebase-tools functions:secrets:set SMTP_PASSWORD --project natureforce-65cdc
  npx firebase-tools functions:secrets:set SMTP_FROM --project natureforce-65cdc
  npm install --prefix functions
  npm run deploy:functions
  ```
- `getBlob()` requer CORS no bucket. Configure com
  `npm run deploy:storage-cors`; CORS não substitui as regras de autorização.
- Publique as regras e índices com `npm run deploy:rules` e
  `npm run deploy:indexes`;
  publique Storage com `npm run deploy:storage`.
- PDFs que existiam apenas no IndexedDB não são migrados automaticamente.
  Reenvie os PDFs legados e revise cadastros ambíguos antes de publicar; nenhuma
  fatura antiga é reassociada ou excluída automaticamente.

## Variáveis de ambiente (opcionais)

As credenciais do Firebase já vêm com fallbacks embutidos (config pública do
SDK Web). As variáveis abaixo permitem mudar sem editar código:

```bash
VITE_FIREBASE_API_KEY=...       # demais chaves: AUTH_DOMAIN, PROJECT_ID, etc.
```

Senhas administrativas não devem ser configuradas em variáveis `VITE_*`, no
código ou no armazenamento local. Todo acesso administrativo depende de uma
conta ativa no Firebase Authentication.

## Provisionamento

- **Administrador**: somente a callable Function, autorizada ao master, cria a
  conta Auth, atribui role `admin` e envia convite para definir senha. A interface
  não recebe nem grava senha administrativa.
- **Administrador master**: `thyagopatriota2020@gmail.com`; único autorizado
  pelo backend a convidar, editar, ativar, desativar e excluir administradores.
  A conta deve existir no Firebase Authentication; publicar regras não cria a conta.
- **Cliente**: o painel cria a conta automaticamente ao cadastrar (ou pelo
  botão **Criar acesso** no cartão do cliente), sem derrubar a sessão do admin.

## Documentação

- `Guia_Alimentacao_Sistema_NatureForce.pdf` — guia operacional (PDF)
- `gerar_instrucoes.cjs` — gera o guia (`node gerar_instrucoes.cjs`)