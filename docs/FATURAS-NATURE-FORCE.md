# Emissão de faturas Nature Force

## Diagnóstico verificado no código

O frontend é React/Vite; Auth, Firestore e Storage são Firebase. `faturaClassifier.js` extrai dados do PDF da distribuidora. `descontoCalculator.js` calcula uma sugestão com percentual fixo de 20% sobre energia + TUSD + TE, sem demonstrar energia efetivamente compensada. `AdminDashboard.jsx` grava `componentes`, `calculo`, `valorTotal`, `consumo`, `referencia`, `vencimento`, `ucId`, `uc` e `clienteId`. `functions/index.js:publicarFaturaValidada` publica **o documento original da distribuidora**, validando UC e cliente no backend. Esse fluxo continua identificado como publicação do original.

Não foi encontrada coleção de contratos, vigência contratual, tarifa específica da energia compensada ou configuração central do Pix. A existência de `calculo.valorFinal` não provava aprovação financeira administrativa. O novo emissor exige confirmação explícita do valor atual, não usa a sugestão de 20% como condição contratual e não recalcula a cobrança. Esta análise é do código local; não foi feita leitura de dados de produção.

## Arquivos e responsabilidades

- `functions/natureForceInvoice.js`: contrato validado, mapeamento, BR Code Pix estático e template A4 em PDFKit. Texto selecionável, logo oficial copiado de `src/assets/logo.png`, vetores e QR gerado; não utiliza a referência como imagem de fundo.
- `functions/natureForceHandlers.js`: configuração central administrativa, geração/publicação, correção por nova versão e baixa manual. Usa a autorização administrativa já existente no backend.
- `functions/index.js`: registra os handlers e impede que a publicação do original injete os campos reservados de emissão e pagamento.
- `functions/assets/logo.png`: logo oficial empacotado para o deploy das Functions.
- `src/pages/admin/NatureForceBilling.jsx`: formulário de empresa/Pix, aprovação por fatura, emissão/correção e baixa manual com referência do comprovante.
- `src/pages/admin/AdminDashboard.jsx`: integra os formulários à lista de pendentes/publicadas e identifica a publicação do original.
- `src/pages/cliente/ClienteDashboard.jsx`: visualização e download usam a mesma referência Nature Force publicada; exibe número, desconto declarado e situação de conferência manual.
- `firestore.rules` e `storage.rules`: campos de emissão e baixa exclusivos do servidor; leitura do PDF atual restrita ao proprietário ou administrador; versões anteriores Nature Force não ficam disponíveis ao cliente por troca de caminho.
- `tests/natureForceInvoice.test.mjs`: contrato, renderização, QR decodificado dos pixels, isolamento no mapeamento e ciclo de publicação com adaptadores em memória.
- `tests/firestore.rules.test.mjs`: testes reais das regras no Emulator Suite.
- `package.json` e `functions/package*.json`: execução dos testes e dependências PDFKit, qrcode, decimal.js; jsqr é dependência de desenvolvimento para decodificação dos testes.

## Fontes de cada campo

| Campo PDF | Fonte autorizada |
| --- | --- |
| Nome, documento e endereço do cliente | Documento de `clientes` resolvido no backend pelo vínculo `unidades.clienteId`, via `resolveLinkedClient` |
| UC original | `unidades.numeroUC`, obrigatoriamente texto; comparação numérica normalizada preserva zeros; ambiguidades bloqueiam |
| Cliente e UC da cobrança | `faturas.clienteId`, `faturas.ucId`, `faturas.uc`, confrontados com cadastros centrais |
| Referência e vencimento | `faturas.referencia` (AAAA-MM) e `faturas.vencimento` (AAAA-MM-DD) |
| Consumo medido | `faturas.consumo`; ausência fica explícita |
| Valor final | `faturas.valorTotal`, lido novamente no backend, aprovado explicitamente; `expectedTotal` apenas detecta tela desatualizada |
| Número da fatura | Informado pelo administrador durante a aprovação e preservado no snapshot |
| Percentual contratado | Informado expressamente pelo administrador para aquela competência e preservado no snapshot; não vem da calculadora fixa |
| Até seis meses de consumo | Faturas centrais da mesma UC, mesmo cliente, versão atual e janela de seis meses; registros ausentes não viram zero; valores contraditórios bloqueiam |
| Empresa e recebedor | Novo documento central `configuracoes/faturamentoNatureForce`, escrito somente pela callable administrativa |
| Composição, compensação efetiva, economia, créditos | Não demonstrados nas fontes atuais: estados explícitos no PDF, sem copiar valores da referência ou tratar consumo medido como compensado |
| Emissão e versão | Servidor: data, ator, hash SHA-256, identificador da operação e versão do template |

A configuração nova contém `nome`, `documento`, `endereco`, `pix.tipo`, `pix.chave`, `pix.titular`, `pix.cidade`, além de revisão e metadados administrativos. Não é semeada com valores da referência. Tipos de chave: cpf, cnpj, email, telefone (E.164, com +) e aleatoria. CPF/CNPJ validam dígitos verificadores. A validação local não comprova titularidade ou existência da chave no DICT: o administrador deve conferir o recebedor no banco antes de usar.

## Condições financeiras e arredondamento

O total registrado é usado sem aplicar uma fórmula nova. Ausência, valor negativo, fração de centavo, divergência não resolvida com `calculo.valorFinal` ou mudança desde a confirmação bloqueiam emissão. A aprovação exige número oficial e percentual contratado entre 0 e 100. O percentual é metadado contratual desta emissão, não aciona cálculo presumido. Uma divergência pode ser resolvida por retificação explícita: administrador informa o novo valor oficial, justifica e confirma a cobrança. Total anterior, valor sugerido pela importação, motivo e novo valor ficam no snapshot; o total da fatura e o PDF mudam juntos somente após publicação bem-sucedida. Não se reescreve a sugestão antiga de cálculo como se fosse o cálculo do novo total.

Decimal.js valida os valores. A representação monetária usa duas casas e ROUND_HALF_UP, mas o total oficial **é rejeitado se precisasse ser arredondado**. Não se arredondam tarifas nem se calculam itens sem fonte comercial definida. A calculadora legada de importação permanece como sugestão existente; não é promovida a regra do novo emissor.

A alteração mínima para preservar condições é o snapshot imutável por emissão, com aprovação, valor, percentual e competência. Não foi criada uma estrutura presumida de contratos com vigência. Para futura automação será necessário definir a fonte oficial das condições comerciais e seu vínculo temporal.

## Fluxo e rastreabilidade

1. Callable autentica administrador, incluindo bloqueio de perfil inativo, usando a política já existente.
2. Lê fatura, cadastros, histórico e configuração do banco central; dados do cache do navegador não alimentam o PDF.
3. Valida vínculo único, datas, aprovação financeira e Pix. Gera PDF e QR.
4. Grava arquivo privado com precondição de não sobrescrever, sem token público; baixa os bytes e confere SHA-256.
5. Transação relê as fontes e exige que não tenham mudado. Cria `faturas/{id}/emissoesNatureForce/{operationId}` com snapshot completo e publicação; atualiza `faturas.natureForce` e audita atomicamente.
6. Portal usa `natureForce.storagePath` tanto para visualizar quanto para baixar. O original continua em `storagePath`; não há migração em massa.
7. Nova correção gera outra versão e conserva os PDFs e snapshots anteriores. O ponteiro só muda após sucesso. A mesma operação concluída retorna a mesma versão em novas tentativas.
8. Geração/download não escrevem estado de pagamento. A callable de baixa manual exige administrador e referência de comprovante conferido; grava `pagamentoStatus: pago`, ator/data/valor e auditoria. Emissão de uma fatura já quitada é bloqueada.

Logs distinguem geração, publicação/correção, falha, falha de limpeza, configuração e baixa manual, sem incluir a chave Pix, documento ou endereço do cliente. Falhas controladas removem o upload ainda não publicado. Encerramento abrupto do processo entre upload e transação pode deixar arquivo privado órfão; ele não é publicado e não impede nova tentativa. Não foi criada rotina automática de exclusão de arquivos.

Após emissão, as regras bloqueiam alterações diretas nos campos financeiros/vínculos da fatura para evitar divergência com o PDF. O formulário permite nova versão com ajuste explícito de número/percentual e retificação manual de valor com justificativa. A retificação altera apenas o valor oficial aprovado; não presume uma fórmula para demonstrar a composição. Não se deve liberar edição direta dos campos no banco para contornar esse fluxo.

## Pix

Mesmo recebedor, chave, cidade e payload em todas as faturas sob a mesma configuração. BR Code com iniciação estática, txid `***`, sem tag de valor e CRC16-CCITT. Não há conciliação automática, identificador por cliente ou baixa ao ler QR.

Referências primárias: [Manual de Padrões para Iniciação do Pix](https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Regulamento_Pix/II_ManualdePadroesparaIniciacaodoPix.pdf) e [Manual BR Code](https://cdn-www.bcb.gov.br/content/estabilidadefinanceira/spb_docs/ManualBRCode.pdf).

## Validação e evidência local

`npm test` passou com 54 testes: os 44 legados e dez novos grupos. Os handlers são exercitados com banco/Storage em memória, incluindo configuração administrativa, idempotência, nova versão, retificação financeira explícita, falha de upload, falha de transação, bytes corrompidos, permissão de baixa e preservação do estado financeiro. Esses testes não substituem os emuladores. Lint, build e `git diff --check` também passaram.

Os PDFs sintéticos ficam em `artifacts/invoices/standard.pdf` (uma página) e `long.pdf` (duas páginas), com PNGs de cada página, ignorados pelo Git. O teste renderiza os PDFs com PDF.js, verifica A4, extração de texto e limites inferiores/esquerdos, e decodifica o QR diretamente dos pixels com jsQR. A inspeção humana pelo agente comparou a referência e as três páginas sintéticas, verificando cores, margens, hierarquia, QR e ausência de sobreposição nos casos gerados. O resumo de composição usa estado indisponível porque ainda não existe fonte comercial para os itens.

Comandos de validação: `npm ci`, `npm ci --prefix functions`, `npm test`, `npm run lint`, `npm run build`, `npm run test:rules`. Os emuladores precisam de Java compatível. Nenhum teste publica cobranças em produção. O deploy das Functions, frontend e regras deve ocorrer em conjunto após a validação das regras.

Resultado local em 18/10/2026: suíte Firebase com 9 testes aprovada usando Java 21 portátil em `artifacts/tools/jre21` (sem instalação no sistema). Foi corrigido um erro preexistente da suíte que chamava `getFirestore(context)` em vez de `context.firestore()`. O arquivo `artifacts/invoices/rules-test.log` contém a execução. Os testes incluem UID diferente, usuário não autenticado, segunda UC, bloqueio de escrita direta de aprovação/baixa/configuração e acesso apenas à versão atual Nature Force pelo cliente.

## Dados comerciais a fornecer

- Razão social, documento e endereço institucionais oficiais.
- Tipo/chave Pix, titular e cidade oficiais, conferidos no banco. Sem isso a publicação Nature Force com Pix fica bloqueada.
- Número oficial, valor final conferido e percentual contratado por UC/competência. O percentual não é inferido da imagem ou dos 20% da importação.
- Para demonstrar composição: energia efetivamente compensada, tarifas/componentes aprovados, elegibilidade ao desconto, tratamento de tributos/encargos, itens e totais oficiais conciliados.
- Para exibir economia e créditos: base aprovada da economia mensal, histórico por UC e saldo de créditos; valores da distribuidora separados quando houver.
- Para automatizar vigências e cálculos de retificação: regra e fonte oficial das condições contratuais.

## Ajustes técnicos e operação

Template, contrato, configuração administrativa, emissão, versionamento, retificação manual de valor, entrega privada e baixa manual estão implementados localmente. Não houve deploy nem leitura/escrita de produção. A demonstração de itens e os cálculos comerciais automáticos permanecem dependentes das definições acima; não foram simulados como funcionalidades concluídas.
