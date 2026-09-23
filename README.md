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
| Cache local | localStorage (dados) + IndexedDB (PDFs importados) |
| Lint / testes | oxlint · `node --test` (31 testes) |
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

**O cache local (localStorage) é o espelho de leitura; o Firestore é a fonte da
verdade compartilhada.** Toda escrita grava localmente (síncrono), depois é
espelhada no Firestore (assíncrono) e re-renderiza a interface por `dadosVersao`.
As `onSnapshot` reconciliam o cache com o banco em tempo real.

## Fluxos principais

1. **Login** → Firebase Auth → ponte de identidade `vincularClienteAoUid`
   (propaga o UID para UCs/faturas) → dashboard.
2. **Importação de PDF** (admin) → valida assinatura `%PDF-` → hash SHA-256
   (dedupe) → extrai texto preservando linhas → classifica componentes →
   aplica 20% sobre elegível → identifica UC/cliente → **fica "aguardando
   revisão"** → admin publica → aparece na área do cliente.
3. **Pré-cadastro** — UC nova no PDF vira pré-cadastro; o admin confirma
   (cria cliente) **ou** associa a um cliente existente (sem duplicar cadastro).
4. **Atendimento** — cliente envia solicitação, admin atualiza o status, o
   cliente acompanha em tempo real.
5. **Exclusões** — são propagadas ao banco com o ID correto do documento e a
   falha (se houver) é informada ao usuário.

## Segurança

- `firestore.rules` — isolamento por UID: um cliente só lê/grava os próprios
  documentos; administrador tem acesso amplo (custom claim `admin` ou e-mail na
  allowlist).
- `storage.rules` — PDFs por cliente (uso futuro; hoje os PDFs ficam no
  navegador do admin, em IndexedDB).
- **Credenciais nunca são espelhadas no banco**: `senha`/`senhaAcesso` são
  removidas do payload por `itemParaBanco()` antes de qualquer gravação.
- Após mudanças nas regras, **publique** no Console → Firestore → Rules
  (veja `docs/PROVISIONAMENTO-ADMIN.md`).

## Variáveis de ambiente (opcionais)

As credenciais do Firebase já vêm com fallbacks embutidos (config pública do
SDK Web). As variáveis abaixo permitem mudar sem editar código:

```bash
VITE_FIREBASE_API_KEY=...       # demais chaves: AUTH_DOMAIN, PROJECT_ID, etc.
VITE_ADMIN_EMAILS=admin@natureforce.com,outro@empresa.com   # allowlist de admin
VITE_ADMIN_EMAIL=admin@natureforce.com                      # conta de bootstrap
VITE_ADMIN_PASSWORD=...         # senha do bootstrap offline (troque em produção)
```

## Provisionamento

- **Administrador**: conta no Firebase Auth com o mesmo e-mail/senha do login
  → `docs/PROVISIONAMENTO-ADMIN.md`.
- **Cliente**: o painel cria a conta automaticamente ao cadastrar (ou pelo
  botão **Criar acesso** no cartão do cliente), sem derrubar a sessão do admin.

## Documentação

- `Guia_Alimentacao_Sistema_NatureForce.pdf` — guia operacional (PDF)
- `gerar_instrucoes.cjs` — gera o guia (`node gerar_instrucoes.cjs`)