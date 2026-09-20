// ==================== TESTES — Identificação, Idempotência, Desconto e Segurança ====================
// Executa em Node: node tests/run-tests.mjs
// Cobre os 14 cenários obrigatórios + a regra comercial do desconto.

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { identificarFatura, DECISAO, podeAcessarRecurso } from '../src/services/faturaIdentificacao.js'
import { STATUS_FATURA, MOTIVO_REVISAO } from '../src/services/faturaStatus.js'
import {
  gerarChaveDedupe,
  montarChaveIdempotencia,
  gerarIdFatura,
  encontrarFaturaDuplicada,
  encontrarDuplicadaPorIdempotencia,
} from '../src/services/faturaDedup.js'
import { calcularDesconto } from '../src/services/descontoCalculator.js'
import {
  reconstruirLinhas,
  reconstruirTextoDePaginas,
  contarCaracteresUteis,
  temCamadaDeTexto,
  MIN_CARACTERES_TEXTO,
} from '../src/services/pdfTextLayout.js'
import { classificarFatura, extrairUC, extrairUCDaLinha } from '../src/services/faturaClassifier.js'
import {
  ERRO_PDF,
  MENSAGEM_ERRO_PDF,
  encontrarAssinaturaPDF,
  validarBytesPDF,
  validarArquivoPDF,
} from '../src/services/pdfValidacao.js'

// ==================== Cenário-base ====================
const clientes = [
  { id: 'C1', nome: 'JOÃO DA SILVA', cpfCnpj: '111.222.333-44' },
  { id: 'C2', nome: 'MARIA OLIVEIRA', cpfCnpj: '999.888.777-66' },
  { id: 'C3', nome: 'ABC COMERCIO LTDA', cpfCnpj: '12.345.678/0001-90' },
  { id: 'C4', nome: 'PEDRO SANTOS', cpfCnpj: '555.444.333-22' },
]

const unidades = [
  { id: 'U1', clienteId: 'C1', numeroUC: '123456', codigoInstalacao: '', titularNome: 'JOÃO DA SILVA', titularCpfCnpj: '111.222.333-44', numeroMedidor: '100000000001', endereco: 'Rua A, 100', cidade: 'Recife', estado: 'PE' },
  { id: 'U2', clienteId: 'C1', numeroUC: '789012', titularNome: 'JOÃO DA SILVA', titularCpfCnpj: '111.222.333-44', endereco: 'Rua B, 500' },
  { id: 'U3', clienteId: 'C1', numeroUC: '345678', titularNome: 'JOÃO DA SILVA', titularCpfCnpj: '111.222.333-44', endereco: 'Rua C, 80' },
  { id: 'U4', clienteId: 'C2', numeroUC: '222333', titularNome: 'MARIA OLIVEIRA', titularCpfCnpj: '999.888.777-66', endereco: 'Av. Central, 200' },
  { id: 'U5', clienteId: 'C3', numeroUC: '999001', titularNome: 'JOÃO DA SILVA', titularCpfCnpj: '111.222.333-44', endereco: 'Rua do Comercio, 1' },
  { id: 'U6', clienteId: 'C3', numeroUC: '999002', titularNome: 'JOÃO DA SILVA', titularCpfCnpj: '111.222.333-44', endereco: 'Rua do Comercio, 2' },
]
// ===================== 1. Cliente com uma UC =====================
test('01. Cliente com 1 UC → PROCESSADO', () => {
  const r = identificarFatura({ componentes: { uc: '345678' }, unidades, clientes })
  assert.equal(r.decisao, DECISAO.PROCESSADO)
  assert.equal(r.cliente.id, 'C1')
  assert.equal(r.unidade.id, 'U3')
})

// ===================== 2. Cliente com duas UCs =====================
test('02. Cliente com 2 UCs → resolve a UC correta', () => {
  const r = identificarFatura({ componentes: { uc: '789012' }, unidades, clientes })
  assert.equal(r.decisao, DECISAO.PROCESSADO)
  assert.equal(r.cliente.id, 'C1')
  assert.equal(r.unidade.id, 'U2') // não confunde com U1/U3
})

// ===================== 3. Cliente com várias UCs =====================
test('03. Cliente com várias UCs → resolve cada UC individualmente', () => {
  for (const [uc, uniId] of [['123456', 'U1'], ['789012', 'U2'], ['345678', 'U3']]) {
    const r = identificarFatura({ componentes: { uc }, unidades, clientes })
    assert.equal(r.decisao, DECISAO.PROCESSADO)
    assert.equal(r.unidade.id, uniId)
  }
})

// ===================== 4. Mesmo titular em UCs diferentes =====================
test('04. Mesmo titular em UCs diferentes → resolve pela UC (não pelo nome)', () => {
  const r = identificarFatura({ componentes: { uc: '123456', cliente: 'JOÃO DA SILVA' }, unidades, clientes })
  assert.equal(r.decisao, DECISAO.PROCESSADO)
  assert.equal(r.unidade.id, 'U1')
  assert.equal(r.cliente.id, 'C1')
})

// ===================== 5. Mesmo endereço com clientes diferentes =====================
test('05. Mesmo endereço com clientes diferentes → REVISAO_MANUAL (nunca por endereço)', () => {
  const cena = [
    ...unidades,
    { id: 'U7', clienteId: 'C4', numeroUC: '777777', titularNome: 'PEDRO SANTOS', endereco: 'Rua das Flores, 10' },
    { id: 'U8', clienteId: 'C2', numeroUC: '888888', titularNome: 'MARIA OLIVEIRA', endereco: 'Rua das Flores, 10' },
  ]
  // Sem UC no PDF (apenas endereço igual) → nunca decidir sozinho → revisão
  const r = identificarFatura({ componentes: { endereco: 'Rua das Flores, 10' }, unidades: cena, clientes })
  assert.equal(r.decisao, DECISAO.REVISAO_MANUAL)
  assert.equal(r.cliente, null)
})

// ===================== 6. Cliente PJ com titular pessoa física =====================
test('06. Cliente PJ com titular PF → resolve pela UC (vínculo PJ), não pelo nome', () => {
  const r = identificarFatura({ componentes: { uc: '999001', cliente: 'JOÃO DA SILVA' }, unidades, clientes })
  assert.equal(r.decisao, DECISAO.PROCESSADO)
  assert.equal(r.cliente.id, 'C3') // ABC, a empresa — não João
  assert.equal(r.cliente.nome, 'ABC COMERCIO LTDA')
})

// ===================== 7. PDF duplicado =====================
test('07. PDF duplicado (mesmo arquivo) → DUPLICADA pela idempotência', () => {
  const params = { uc: '123456', referencia: '2026-08', numeroNota: '123456', hashArquivo: 'a1b2c3' }
  const existente = { chaveIdempotencia: montarChaveIdempotencia(params), hashArquivo: 'a1b2c3', status: 'disponivel' }
  const dup = encontrarDuplicadaPorIdempotencia([existente], params)
  assert.ok(dup, 'deveria detectar a duplicada')
  assert.equal(gerarIdFatura(params), gerarIdFatura(params))
})

// ===================== 8. PDF ilegível =====================
test('08. PDF ilegível (sem dados de identificação) → ERRO_EXTRACAO', () => {
  const r = identificarFatura({ componentes: {}, unidades, clientes })
  assert.equal(r.decisao, DECISAO.ERRO_EXTRACAO)
  assert.equal(r.motivo, 'SEM_DADOS_IDENTIFICACAO')
})

// ===================== 9. UC inexistente =====================
test('09. UC inexistente → REVISAO_MANUAL (não cria cliente)', () => {
  const r = identificarFatura({ componentes: { uc: '999999', cliente: 'CLIENTE NOVO' }, unidades, clientes })
  assert.equal(r.decisao, DECISAO.REVISAO_MANUAL)
  assert.equal(r.motivo, 'UC_NAO_ENCONTRADA')
  assert.equal(r.cliente, null) // nunca inventar cliente
})

// ===================== 10. UC encontrada, mas cliente incompatível =====================
test('10. UC encontrada, mas cliente incompatível → REVISAO_MANUAL', () => {
  const r = identificarFatura({ componentes: { uc: '123456', cpfCnpj: '000.000.000-00' }, unidades, clientes })
  assert.equal(r.decisao, DECISAO.REVISAO_MANUAL)
  assert.equal(r.motivo, 'CLIENTE_INCOMPATIVEL')
})

// ===================== 11. Duas faturas do mesmo mês =====================
test('11. Duas faturas do mesmo mês (mesma UC+ref+nota) → duplicada', () => {
  const p1 = { uc: '123456', referencia: '2026-08', numeroNota: '777', hashArquivo: 'h1' }
  const p2 = { uc: '123456', referencia: '2026-08', numeroNota: '777', hashArquivo: 'h1' }
  assert.equal(montarChaveIdempotencia(p1), montarChaveIdempotencia(p2))
  assert.equal(gerarChaveDedupe(p1), gerarChaveDedupe(p2))
  const dup = encontrarFaturaDuplicada([{ chaveDedupe: gerarChaveDedupe(p1), status: 'disponivel' }], {
    hashArquivo: 'h2',
    chaveDedupe: gerarChaveDedupe(p2),
  })
  assert.ok(dup, 'a segunda fatura do mesmo mês deve ser detectada como duplicada')
})

// ===================== 12. Faturas de meses diferentes =====================
test('12. Faturas de meses diferentes → NÃO duplicadas', () => {
  const p1 = { uc: '123456', referencia: '2026-08', numeroNota: '777' }
  const p2 = { uc: '123456', referencia: '2026-07', numeroNota: '888' }
  assert.notEqual(gerarChaveDedupe(p1), gerarChaveDedupe(p2))
  assert.notEqual(montarChaveIdempotencia(p1), montarChaveIdempotencia(p2))
})
// ===================== 3b. Cliente com cinco UCs =====================
test('03b. Cliente com 5 UCs → resolve cada UC independentemente', () => {
  const c5 = [...unidades]
  for (let i = 0; i < 5; i++) {
    c5.push({ id: `U5-${i}`, clienteId: 'C1', numeroUC: `5500${i}`, titularNome: 'JOÃO DA SILVA' })
  }
  // A UC 55003 (só este cliente) deve resolver corretamente
  const r = identificarFatura({ componentes: { uc: '55003' }, unidades: c5, clientes })
  assert.equal(r.decisao, DECISAO.PROCESSADO)
  assert.equal(r.unidade.id, 'U5-3')
  assert.equal(r.cliente.id, 'C1')
})

// ===================== 4b. Mesmo titular em três endereços =====================
test('04b. Mesmo titular em 3 endereços → resolve pela UC, não pelo nome/endereço', () => {
  // 3 UCs do mesmo titular em 3 endereços (U1, U2, U3 do João)
  for (const [uc, uniId] of [['123456', 'U1'], ['789012', 'U2'], ['345678', 'U3']]) {
    const r = identificarFatura({ componentes: { uc, cliente: 'JOÃO DA SILVA', endereco: 'Rua X' }, unidades, clientes })
    assert.equal(r.decisao, DECISAO.PROCESSADO)
    assert.equal(r.unidade.id, uniId)
  }
})

// ===================== 5b. Titular ≠ Cliente Nature Force =====================
test('05b. Titular diferente do cliente → vínculo mantido na UC (pessoa jurídica)', () => {
  // Cliente ABC (C3) tem UC 999002 cujo titular é JOÃO (PF), diferente da razão social
  const r = identificarFatura({ componentes: { uc: '999002', cliente: 'JOÃO DA SILVA' }, unidades, clientes })
  assert.equal(r.decisao, DECISAO.PROCESSADO)
  assert.equal(r.cliente.nome, 'ABC COMERCIO LTDA')
})
// ===================== 13. Cliente vê só as próprias faturas =====================
test('13. Cliente acessa seus próprios recursos → permitido', () => {
  assert.equal(podeAcessarRecurso({ uid: 'C1', clienteId: 'C1' }), true)
  const regras = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')
  // Faturas e UCs isoladas por clienteId == uid (via isOwner)
  assert.ok(regras.includes('isOwner(resource.data.clienteId)'), 'faturas isoladas por clienteId')
  assert.ok(regras.includes('request.auth.uid =='),
    'isOwner compara uid com o clienteId do documento')
  assert.ok(regras.includes('isOwner'), 'regras usam isOwner')
})

// ===================== 14. Cliente acessando fatura de outro =====================
test('14. Cliente tentando acessar fatura de outro cliente → negado', () => {
  assert.equal(podeAcessarRecurso({ uid: 'C1', clienteId: 'C2' }), false)
  const regras = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')
  assert.ok(regras.includes('match /{document=**}'), 'negação padrão presente')
  assert.ok(regras.includes('allow read, write: if false'), 'deny-all por padrão')
})

// ===================== Regra comercial do desconto =====================
test('Desconto aplicado sobre parcela ELEGÍVEL (Energia+TUSD+TE), não sobre o total', () => {
  const comp = { energia: 100, tusd: 50, te: 30, icms: 50, pis: 0, cofins: 0, encargos: 0, iluminacao: 0, creditos: 0, descontos: 0, outros: 0 }
  const calc = calcularDesconto(comp)
  assert.equal(calc.ok, true)
  const elegivel = 100 + 50 + 30 // 180
  assert.equal(calc.valorElegivel, elegivel)
  assert.equal(calc.valorDesconto, 36) // 180 * 0.2
  assert.equal(calc.valorFinal, (180 - 36) + 50)
  // PROVA DA DIVERGÊNCIA: 20% "cego" sobre o total (230) seria 46 ≠ 36
  assert.notEqual(calc.valorDesconto, 230 * 0.2, 'o desconto NÃO é 20% do total da fatura')
})

// ===================== Status enum =====================
test('Estados do processamento presentes', () => {
  for (const s of ['PENDENTE', 'PROCESSANDO', 'PROCESSADO', 'REVISAO_MANUAL', 'ERRO_EXTRACAO', 'DUPLICADA']) {
    assert.ok(STATUS_FATURA[s], `status ${s} ausente`)
  }
})
// ==================== Extração de texto do PDF (pdfjs-dist / getTextContent) ====================
// Fixture: página simulando uma fatura de energia, com os itens exatamente na
// forma devolvida por `page.getTextContent()` — cada fragmento de texto com sua
// matriz `transform` = [a, b, c, d, x, y]. Aqui o rótulo e o valor ficam em
// LINHAS DIFERENTES (layout real das faturas).
const itemPDF = (str, x, y, hasEOL = false) => ({
  str,
  dir: 'ltr',
  width: str.length * 5,
  height: 10,
  transform: [10, 0, 0, 10, x, y],
  fontName: 'F1',
  hasEOL,
})

const paginaFatura = [
  itemPDF('NEOENERGIA PERNAMBUCO', 30, 760),
  itemPDF('NÚMERO DA UNIDADE CONSUMIDORA', 30, 730, true),
  itemPDF('1234567890', 30, 722),
  itemPDF('NOME DO CLIENTE:', 30, 700, true),
  itemPDF('JOAO DA SILVA', 30, 692),
  itemPDF('REF:MÊS/ANO', 30, 670, true),
  itemPDF('08/2026', 30, 662),
  itemPDF('VENCIMENTO', 30, 640, true),
  itemPDF('18/09/2026', 30, 632),
  itemPDF('CONSUMO FATURADO', 30, 610, true),
  itemPDF('188,75', 30, 602),
  itemPDF('Energia Ativa Único 16.602,00 16.925,00 1,00000 188,75', 30, 580),
  itemPDF('Consumo-TUSDkWh 188,75 0,72048386 135,99 7,10 135,99 20,50 27,88 0,53521000', 30, 570),
  itemPDF('Consumo-TEkWh 188,75 0,35491782 66,99 3,49 66,99 20,50 13,73 0,26365000', 30, 560),
  itemPDF('ICMS 236,01 20,50 48,37', 30, 550),
]

// ===================== 15. Reconstrução das linhas =====================
test('15. reconstruirLinhas mantém uma linha por linha visual (eixo Y)', () => {
  const linhas = reconstruirLinhas(paginaFatura)

  assert.equal(linhas.length, paginaFatura.length)
  assert.equal(linhas[1], 'NÚMERO DA UNIDADE CONSUMIDORA')
  assert.equal(linhas[2], '1234567890', 'o valor ficou na linha SEGUINTE, não na mesma')
  assert.equal(linhas[4], 'JOAO DA SILVA')
  assert.equal(linhas[8], '18/09/2026')
})

test('15b. reconstruirLinhas ordena os fragmentos da mesma linha pela coordenada X', () => {
  // Itens emitidos fora de ordem visual, porém na MESMA linha (mesmo Y)
  const itens = [itemPDF('789012', 200, 500), itemPDF('UC', 30, 500)]
  assert.deepEqual(reconstruirLinhas(itens), ['UC 789012'])
})

test('15c. reconstruirLinhas ignora itens de marcação e não gera linhas vazias', () => {
  const itens = [
    itemPDF('Ok', 10, 100),
    { type: 'beginMarkedContent', tag: 'P' },
    { type: 'endMarkedContent' },
    itemPDF('', 10, 90),
  ]
  assert.deepEqual(reconstruirLinhas(itens), ['Ok'])
})

test('15d. reconstruirLinhas usa hasEOL como quebra de linha explícita', () => {
  // Mesmo Y, mas o gerador sinaliza fim de linha no primeiro item
  const itens = [itemPDF('Linha 1', 10, 100, true), itemPDF('Linha 2', 10, 100)]
  assert.deepEqual(reconstruirLinhas(itens), ['Linha 1', 'Linha 2'])
})

// ===================== 16. Regressão do bug: unir tudo com espaço =====================
test('16. BUG corrigido: unir os itens com espaço destrói campos da linha seguinte', () => {
  // Extração ANTIGA (uma única linha por página)
  const textoAntigo = paginaFatura.map((i) => i.str).join(' ') + '\n'
  const antigo = classificarFatura(textoAntigo)

  // Extração CORRIGIDA (linhas visuais preservadas)
  const textoNovo = reconstruirTextoDePaginas([paginaFatura])
  const novo = classificarFatura(textoNovo)

  // O texto antigo fica legível para diagnóstico:
  assert.ok(textoAntigo.includes('NOME DO CLIENTE: JOAO DA SILVA'))

  assert.equal(antigo.cliente, null, 'a extração antiga NÃO identificava o cliente')
  assert.equal(novo.cliente, 'JOAO DA SILVA', 'com as linhas preservadas o cliente é lido')
  assert.equal(novo.confiancas.cliente, 'CONFIRMADO')
})

// ===================== 17. Fatura completa pela nova extração =====================
test('17. Fatura completa: UC, cliente, referência, vencimento e consumo', () => {
  const texto = reconstruirTextoDePaginas([paginaFatura])
  const c = classificarFatura(texto)

  assert.equal(c.erro, undefined)
  assert.equal(c.uc, '1234567890')
  assert.equal(c.cliente, 'JOAO DA SILVA')
  assert.equal(c.referencia, '08/2026')
  assert.equal(c.vencimento, '18/09/2026')
  assert.equal(c.consumo, 188.75)
  assert.equal(c.energia, 188.75)
  assert.equal(c.tusd, 135.99)
  assert.equal(c.te, 66.99)
  assert.equal(c.icms, 48.37)
  assert.equal(c.confiancas.uc, 'CONFIRMADO')

  // A UC extraída resolve o cliente cadastrado (pipeline completo)
  const decisao = identificarFatura({
    componentes: c,
    unidades: [{ id: 'U9', clienteId: 'C1', numeroUC: '1234567890' }],
    clientes,
  })
  assert.equal(decisao.decisao, DECISAO.PROCESSADO)
  assert.equal(decisao.cliente.id, 'C1')
})
// ===================== 18. Regex da UC =====================
test('18. extrairUCDaLinha lê a UC da linha seguinte e os formatos usuais', () => {
  // Rótulo em uma linha, valor na linha seguinte (layout mais comum)
  assert.deepEqual(extrairUCDaLinha('NÚMERO DA UNIDADE CONSUMIDORA', '1234567890'), {
    uc: '1234567890',
    confianca: 'CONFIRMADO',
  })
  assert.deepEqual(extrairUCDaLinha('Unidade Consumidora', '1234567890'), {
    uc: '1234567890',
    confianca: 'CONFIRMADO',
  })
  assert.deepEqual(extrairUCDaLinha('UC', '1234567890'), {
    uc: '1234567890',
    confianca: 'CONFIRMADO',
  })

  // Mesma linha
  assert.equal(extrairUCDaLinha('UC 123456789').uc, '123456789')
  assert.equal(extrairUCDaLinha('Unidade Consumidora: 123456789').uc, '123456789')

  // "numero da unidade consumidora e 2.014.249.014-06" → somente dígitos
  assert.equal(
    extrairUCDaLinha('numero da unidade consumidora e 2.014.249.014-06').uc,
    '201424901406',
  )

  // Falsos positivos não podem virar UC
  assert.equal(extrairUCDaLinha('NÚMERO DA UNIDADE CONSUMIDORA', '188'), null)
  assert.equal(extrairUCDaLinha('Total a pagar 1.234,56'), null)
  assert.equal(extrairUCDaLinha(''), null)
})

test('18b. extrairUC percorre o texto e devolve a primeira UC confiável', () => {
  const texto = reconstruirTextoDePaginas([paginaFatura])
  assert.equal(extrairUC(texto).uc, '1234567890')
  assert.equal(extrairUC('fatura sem identificacao'), null)
  assert.equal(extrairUC(''), null)
  assert.equal(extrairUC(null), null)
})
// ===================== 19. Validação por CONTEÚDO (não por MIME) =====================
// Objeto no formato de File/Blob (usa o Blob global do Node)
const arquivoFalso = (conteudo, { nome = '', tipo = '' } = {}) => {
  const bytes = typeof conteudo === 'string' ? new TextEncoder().encode(conteudo) : conteudo
  const blob = new Blob([bytes])
  return {
    name: nome,
    type: tipo,
    size: blob.size,
    slice: (inicio, fim) => blob.slice(inicio, fim),
    arrayBuffer: () => blob.arrayBuffer(),
  }
}

const CONTEUDO_PDF = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n'

test('19. Validação de PDF pelo conteúdo: MIME vazio não rejeita PDF válido', async () => {
  // (a) PDF válido com MIME VAZIO e SEM extensão .pdf — a regra por MIME reprovava
  const semMime = arquivoFalso(CONTEUDO_PDF, { nome: 'fatura-conta', tipo: '' })
  const regraAntiga =
    semMime.type === 'application/pdf' || semMime.name.toLowerCase().endsWith('.pdf')
  assert.equal(regraAntiga, false, 'a checagem por MIME rejeitaria este PDF válido')

  const r1 = await validarArquivoPDF(semMime)
  assert.equal(r1.ok, true, 'pelo conteúdo o PDF é aceito')
  assert.equal(r1.codigo, null)
  assert.equal(r1.assinaturaOk, true)

  // (b) MIME genérico (comum em uploads de alguns navegadores/SO)
  const octet = arquivoFalso(CONTEUDO_PDF, { nome: 'fatura.pdf', tipo: 'application/octet-stream' })
  assert.equal((await validarArquivoPDF(octet)).ok, true)

  // (c) MIME alternativo aceito por alguns sistemas
  const xpdf = arquivoFalso(CONTEUDO_PDF, { nome: 'fatura.pdf', tipo: 'application/x-pdf' })
  assert.equal((await validarArquivoPDF(xpdf)).ok, true)

  // (d) MIME declarado como PDF mas conteúdo NÃO é PDF → corrompido/renomeado
  const falso = arquivoFalso('apenas texto puro, sem cabecalho PDF', {
    nome: 'fatura.pdf',
    tipo: 'application/pdf',
  })
  const r4 = await validarArquivoPDF(falso)
  assert.equal(r4.ok, false)
  assert.equal(r4.codigo, ERRO_PDF.CORROMPIDO)

  // (e) Arquivo que não é PDF e não se declara PDF
  const r5 = await validarArquivoPDF(arquivoFalso('oi', { nome: 'nota.txt', tipo: 'text/plain' }))
  assert.equal(r5.ok, false)
  assert.equal(r5.codigo, ERRO_PDF.NAO_E_PDF)

  // (f) Arquivo vazio
  const r6 = await validarArquivoPDF(
    arquivoFalso(new Uint8Array(0), { nome: 'vazio.pdf', tipo: 'application/pdf' }),
  )
  assert.equal(r6.ok, false)
  assert.equal(r6.codigo, ERRO_PDF.VAZIO)

  // Toda reprovação traz mensagem clara para o usuário (é o que a UI exibe)
  for (const r of [r4, r5, r6]) {
    assert.ok(r.mensagem && r.mensagem.length > 10, 'mensagem clara para o usuário')
  }

  // (g) PDF real como ArrayBuffer (sem nome/MIME) também é aceito
  const buffer = new TextEncoder().encode(CONTEUDO_PDF).buffer
  assert.equal((await validarArquivoPDF(buffer)).ok, true)
})

// ===================== 20. Assinatura "%PDF-" =====================
test('20. A assinatura "%PDF-" é encontrada mesmo com bytes antes do cabeçalho', () => {
  const semAssinatura = new TextEncoder().encode('GIF89a conteudo de imagem')
  assert.equal(encontrarAssinaturaPDF(semAssinatura), false)
  assert.equal(validarBytesPDF(semAssinatura).ok, false)
  assert.equal(validarBytesPDF(semAssinatura).codigo, ERRO_PDF.NAO_E_PDF)

  // Geradores antigos inserem bytes antes do cabeçalho — continua válido
  const comLixo = new TextEncoder().encode('\u0000\u0000\u0000%PDF-1.4\nconteudo')
  assert.equal(encontrarAssinaturaPDF(comLixo), true)
  assert.equal(validarBytesPDF(comLixo).ok, true)

  assert.equal(validarBytesPDF(new Uint8Array(0)).codigo, ERRO_PDF.VAZIO)
  assert.equal(encontrarAssinaturaPDF(null), false)
})

// ===================== 21. PDF sem camada de texto (escaneado) =====================
test('21. PDF sem camada de texto (digitalizado/imagem) é detectado', () => {
  // PDF escaneado: o getTextContent() não devolve itens de texto
  const semTexto = reconstruirTextoDePaginas([[], []])
  assert.equal(contarCaracteresUteis(semTexto), 0)
  assert.equal(temCamadaDeTexto(semTexto), false)
  assert.equal(temCamadaDeTexto('\n   \n\t'), false)
  assert.equal(temCamadaDeTexto(''), false)

  // PDF de texto normal passa
  const comTexto = reconstruirTextoDePaginas([paginaFatura])
  assert.equal(temCamadaDeTexto(comTexto), true)
  assert.ok(contarCaracteresUteis(comTexto) >= MIN_CARACTERES_TEXTO)

  // A mensagem exibida ao usuário explica o problema e o que fazer
  const msg = MENSAGEM_ERRO_PDF[ERRO_PDF.SEM_TEXTO]
  assert.ok(msg.includes('camada de texto'))
  assert.ok(msg.toLowerCase().includes('digitaliza'))
})

// ===================== 22. UC lida mas não cadastrada =====================
test('22. UC lida no PDF e não cadastrada → REVISAO_MANUAL (nunca cria cliente)', () => {
  const texto = reconstruirTextoDePaginas([paginaFatura])
  const c = classificarFatura(texto)

  // A UC existe no PDF, mas nenhuma unidade cadastrada corresponde a ela
  const decisao = identificarFatura({ componentes: c, unidades, clientes })
  assert.equal(decisao.uc, '1234567890')
  assert.equal(decisao.decisao, DECISAO.REVISAO_MANUAL)
  assert.equal(decisao.motivo, MOTIVO_REVISAO.UC_NAO_ENCONTRADA)
  assert.equal(decisao.cliente, null, 'nunca inventar/associar cliente automaticamente')
})

