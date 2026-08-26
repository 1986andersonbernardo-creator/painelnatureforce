// ==================== TESTES — Identificação, Idempotência, Desconto e Segurança ====================
// Executa em Node: node tests/run-tests.mjs
// Cobre os 14 cenários obrigatórios + a regra comercial do desconto.

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { identificarFatura, DECISAO, podeAcessarRecurso } from '../src/services/faturaIdentificacao.js'
import { STATUS_FATURA } from '../src/services/faturaStatus.js'
import {
  gerarChaveDedupe,
  montarChaveIdempotencia,
  gerarIdFatura,
  encontrarFaturaDuplicada,
  encontrarDuplicadaPorIdempotencia,
} from '../src/services/faturaDedup.js'
import { calcularDesconto } from '../src/services/descontoCalculator.js'

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