import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
const require = createRequire(import.meta.url)
const { buildInvoice, renderInvoice, pixPayload, crc16, money, validateSettings } = require('../functions/natureForceInvoice')
const register = require('../functions/natureForceHandlers')
const jsQR = require('../functions/node_modules/jsqr')
const base = () => ({
  fatura: { clienteId:'a',ucId:'u1',uc:'000123',referencia:'2026-10',vencimento:'2026-11-15',valorTotal:'123.45',consumo:'320',calculo:{valorFinal:123.45} },
  cliente: { id:'a',uid:'a',nome:'Cliente sintético A',cpfCnpj:'DOCUMENTO DE TESTE',endereco:'Rua de Testes, 100' },
  unidade: {id:'u1',numeroUC:'000.123',clienteId:'a'},
  settings: {nome:'EMPRESA SINTÉTICA',documento:'DOCUMENTO DE TESTE',endereco:'Endereço de testes',pix:{tipo:'email',chave:'financeiro@example.com',titular:'EMPRESA DE TESTES',cidade:'RECIFE'}},
  approval: {confirmed:true,actorUid:'admin',numero:'TESTE-001',percentualDesconto:'25',expectedTotal:'123.45'},
  generatedAt:'2026-10-18T12:00:00.000Z',
})

test('contrato preserva UC original, valor oficial aprovado e percentual individual sem presumir composição', () => {
  const input=base(), original=structuredClone(input)
  const a=buildInvoice(input)
  assert.equal(a.uc,'000.123');assert.equal(a.total,'123.45');assert.equal(a.percentualDesconto,'25')
  assert.equal(a.composicaoDisponivel,false);assert.deepEqual(input,original)
  input.approval.percentualDesconto='17.5'
  assert.equal(buildInvoice(input).percentualDesconto,'17.5')
  assert.equal(buildInvoice(input).total,'123.45')
  assert.equal(money('10.005'),'10.01')
})

test('dados essenciais, divergência financeira e aprovação obsoleta bloqueiam emissão', () => {
  for(const mutate of [
    x=>{x.fatura.valorTotal=null},x=>{x.fatura.valorTotal='123.451'},
    x=>{x.fatura.calculo.valorFinal=123.44},x=>{x.approval.expectedTotal='1.00'},
    x=>{x.approval.confirmed=false},x=>{x.approval.percentualDesconto='101'},
    x=>{x.cliente.nome=''},x=>{x.settings.pix.chave=''},x=>{x.fatura.vencimento='2026-02-30'},
    x=>{x.fatura.referencia='2026-13'},x=>{x.unidade.numeroUC=123},
  ]) {const x=base();mutate(x);assert.throws(()=>buildInvoice(x))}
})

test('clientes e múltiplas UCs permanecem isolados inclusive no histórico incompleto', () => {
  const x=base()
  x.history=[
    {...x.fatura,referencia:'2026-05',consumo:100},
    {...x.fatura,referencia:'2026-08',consumo:200},
    {...x.fatura,referencia:'2026-09',consumo:null},
    {...x.fatura,referencia:'2026-07',ucId:'u2',consumo:999},
    {...x.fatura,referencia:'2026-06',clienteId:'b',consumo:888},
    {...x.fatura,referencia:'2026-04',consumo:500},
    x.fatura,
  ]
  assert.deepEqual(buildInvoice(x).history.map(x=>x.mes),['2026-05','2026-08','2026-10'])
  x.fatura.clienteId='b';assert.throws(()=>buildInvoice(x),/Vínculo/)
  x.fatura.clienteId='a';x.fatura.ucId='u2';assert.throws(()=>buildInvoice(x),/Vínculo/)
})

test('Pix central valida tipo/chave/titular/cidade e mantém CRC, txid comum e ausência de valor', () => {
  const x=base(),payload=pixPayload(x.settings)
  const parse=(value)=>{const fields={};for(let i=0;i<value.length;){const id=value.slice(i,i+2),len=Number(value.slice(i+2,i+4));fields[id]=value.slice(i+4,i+4+len);i+=4+len}return fields}
  const fields=parse(payload)
  assert.equal(fields['54'],undefined);assert.equal(fields['01'],'11')
  assert.equal(parse(fields['26'])['01'],'financeiro@example.com')
  assert.equal(parse(fields['62'])['05'],'***');assert.equal(fields['59'],'EMPRESA DE TESTES')
  assert.equal(payload.slice(-4),crc16(payload.slice(0,-4)));assert.equal(crc16('123456789'),'29B1')
  x.cliente={...x.cliente,id:'b',uid:'b'};x.fatura.clienteId='b';x.unidade.clienteId='b'
  assert.equal(buildInvoice(x).pixPayload,payload)
  for(const key of ['tipo','chave','cidade','titular']){const settings=structuredClone(x.settings);settings.pix[key]='';assert.throws(()=>validateSettings(settings))}
})

test('PDFs A4 sintéticos: texto selecionável, nomes extensos, paginação e QR decodificado da página', async () => {
  mkdirSync('artifacts/invoices',{recursive:true})
  for(const long of [false,true]) {
    const input=base()
    if(long){input.cliente.nome='Nome extenso para validar a quebra de linhas '.repeat(35);input.cliente.endereco='Endereço extenso de teste com bairro e complemento '.repeat(35)}
    input.history=[{...input.fatura,referencia:'2026-08',consumo:200},input.fatura]
    const invoice=buildInvoice(input),bytes=await renderInvoice(invoice)
    const name=long?'long':'standard'
    writeFileSync(`artifacts/invoices/${name}.pdf`,bytes)
    const loading=getDocument({data:new Uint8Array(bytes),standardFontDataUrl:path.join(path.dirname(require.resolve('pdfjs-dist/package.json')),'standard_fonts').replaceAll('\\','/')+'/'})
    const pdf=await loading.promise
    let allText='',decoded
    for(let i=1;i<=pdf.numPages;i++){
      const page=await pdf.getPage(i),viewport=page.getViewport({scale:2})
      assert.ok(Math.abs(page.view[2]-595.28)<1);assert.ok(Math.abs(page.view[3]-841.89)<1)
      const content=await page.getTextContent()
      allText+=content.items.map(x=>x.str).join(' ')
      for(const item of content.items){if(item.str.trim()){assert.ok(item.transform[4]>=27);assert.ok(item.transform[5]>=25,`Texto cortado na página ${i}: ${item.str}`)}}
      const canvas=createCanvas(viewport.width,viewport.height),ctx=canvas.getContext('2d')
      await page.render({canvasContext:ctx,viewport}).promise
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height)
      const qr=jsQR(new Uint8ClampedArray(pixels.data),canvas.width,canvas.height)
      if(qr) decoded=qr.data
      writeFileSync(`artifacts/invoices/${name}-${i}.png`,canvas.toBuffer('image/png'))
    }
    assert.ok(allText.includes('000.123'));assert.ok(allText.includes('123,45'))
    assert.ok(allText.includes('comprovante'));assert.equal(decoded,invoice.pixPayload)
    if(long) assert.ok(pdf.numPages>1)
    await loading.destroy()
  }
})

// In-memory adapters exercise handler control flow; Firebase rule checks live in the emulator suite.
function harness(){
  let tick=0,failSave=false,failCommit=false,corrupt=false
  const records=new Map(),files=new Map()
  const put=(path,data)=>records.set(path,{data:structuredClone(data),version:++tick})
  const get=(data,key)=>key.split('.').reduce((v,k)=>v?.[k],data)
  const snapshot=ref=>{const entry=records.get(ref.path);return {ref,id:ref.id,exists:!!entry,data:()=>structuredClone(entry?.data),get:key=>get(entry?.data,key),updateTime:{isEqual:other=>entry?.version===other.version,version:entry?.version}}}
  const ref=path=>({path,id:path.split('/').at(-1),get:async()=>snapshot(ref(path)),collection:name=>collection(`${path}/${name}`),update:async data=>put(path,{...records.get(path)?.data,...data})})
  const collection=(path,filters=[])=>({path,doc:(id=String(++tick))=>ref(`${path}/${id}`),where:(...filter)=>collection(path,[...filters,filter]),
    get:async()=>({docs:[...records.keys()].filter(key=>key.startsWith(path+'/')&&key.split('/').length===path.split('/').length+1).sort().map(key=>snapshot(ref(key))).filter(s=>filters.every(([k,,v])=>s.get(k)===v))}),
    add:async data=>put(`${path}/${++tick}`,data)})
  const db={collection,runTransaction:async callback=>{
    const writes=[]
    const tx={get:target=>target.get(),set:(r,d)=>writes.push(()=>put(r.path,d)),create:(r,d)=>writes.push(()=>put(r.path,d)),update:(r,d)=>writes.push(()=>put(r.path,{...records.get(r.path)?.data,...d}))}
    const value=await callback(tx)
    if(failCommit){failCommit=false;throw new Error('simulated commit failure')}
    writes.forEach(fn=>fn());return value
  }}
  const bucket={file:path=>({save:async bytes=>{if(failSave){failSave=false;throw new Error('storage offline')}files.set(path,bytes)},download:async()=>[corrupt?Buffer.from('bad'):files.get(path)],delete:async()=>files.delete(path)})}
  class HttpsError extends Error {constructor(code,message){super(message);this.code=code}}
  const handlers=register({db,bucket,FieldValue:{serverTimestamp:()=> 'SERVER_TIME'},HttpsError,
    onCall:(options,fn)=>fn||options,authorize:async request=>{if(request.auth?.role!=='admin')throw new HttpsError('permission-denied','admin required');return {actor:{uid:'admin'}}}})
  const x=base();put('faturas/fat_test',x.fatura);put('unidades/u1',x.unidade);put('clientes/a',{...x.cliente,contaFirebase:true});put('configuracoes/faturamentoNatureForce',x.settings)
  const request={auth:{role:'admin'},data:{faturaId:'fat_test',operationId:'11111111-1111-4111-8111-111111111111',approval:x.approval}}
  return {handlers,request,records,files,put,failSave:()=>{failSave=true},failCommit:()=>{failCommit=true},corrupt:()=>{corrupt=true}}
}

test('publicação, reenvio idempotente, correção e baixa manual auditada preservam estado financeiro',async()=>{
  const h=harness(),before=h.records.get('faturas/fat_test').data
  const first=await h.handlers.emitirFaturaNatureForce(h.request)
  assert.equal(first.versao,1);assert.equal(h.records.get('faturas/fat_test').data.valorTotal,before.valorTotal)
  assert.equal(h.records.get('faturas/fat_test').data.pagamentoStatus,undefined)
  assert.equal((await h.handlers.emitirFaturaNatureForce(h.request)).storagePath,first.storagePath);assert.equal(h.files.size,1)
  h.request.data.operationId='22222222-2222-4222-8222-222222222222'
  h.request.data.approval.numero='CORRIGIDA'
  const second=await h.handlers.emitirFaturaNatureForce(h.request)
  assert.equal(second.versao,2);assert.notEqual(first.storagePath,second.storagePath);assert.equal(h.files.size,2)
  assert.equal(h.records.get('faturas/fat_test').data.pagamentoStatus,undefined)
  const settlement={auth:{role:'client'},data:{faturaId:'fat_test',comprovanteReferencia:'comprovante-teste'}}
  await assert.rejects(h.handlers.baixarFaturaNatureForceManualmente(settlement),{code:'permission-denied'})
  settlement.auth.role='admin';await h.handlers.baixarFaturaNatureForceManualmente(settlement)
  assert.equal(h.records.get('faturas/fat_test').data.pagamentoStatus,'pago')
  assert.ok([...h.records.values()].some(x=>x.data.operation==='INVOICE_MANUALLY_SETTLED'))
})

test('falha de armazenamento/transação/integridade preserva versão anterior e permite nova tentativa',async()=>{
  for(const failure of ['failSave','failCommit','corrupt']){
    const h=harness();const first=await h.handlers.emitirFaturaNatureForce(h.request)
    h.request.data.operationId='22222222-2222-4222-8222-222222222222';h[failure]()
    await assert.rejects(h.handlers.emitirFaturaNatureForce(h.request))
    assert.equal(h.records.get('faturas/fat_test').data.natureForce.storagePath,first.storagePath)
    assert.equal(h.files.size,1)
    if(failure!=='corrupt') assert.equal((await h.handlers.emitirFaturaNatureForce(h.request)).versao,2)
  }
})

test('servidor recusa não administrador, UC ambígua e falta de configuração Pix',async()=>{
  const h=harness();h.request.auth.role='client'
  await assert.rejects(h.handlers.emitirFaturaNatureForce(h.request),{code:'permission-denied'})
  h.request.auth.role='admin';h.put('unidades/u2',{...base().unidade,id:'u2'})
  await assert.rejects(h.handlers.emitirFaturaNatureForce(h.request),/ambígua/)
  const other=harness();other.records.delete('configuracoes/faturamentoNatureForce')
  await assert.rejects(other.handlers.emitirFaturaNatureForce(other.request),/Pix/)
  const duplicate=harness();duplicate.put('faturas/fat_other',{...base().fatura,status:'disponivel',versaoAtual:true})
  await assert.rejects(duplicate.handlers.emitirFaturaNatureForce(duplicate.request),/outra fatura publicada/)
})

test('retificação financeira exige justificativa e só troca valor junto da nova publicação',async()=>{
  const h=harness();const first=await h.handlers.emitirFaturaNatureForce(h.request)
  h.request.data.operationId='22222222-2222-4222-8222-222222222222'
  h.request.data.approval.valorRetificado='150.00'
  await assert.rejects(h.handlers.emitirFaturaNatureForce(h.request),/Motivo/)
  h.request.data.approval.motivoRetificacao='Valor oficial conferido novamente no documento comercial.'
  h.failSave();await assert.rejects(h.handlers.emitirFaturaNatureForce(h.request))
  assert.equal(h.records.get('faturas/fat_test').data.valorTotal,'123.45')
  assert.equal(h.records.get('faturas/fat_test').data.natureForce.storagePath,first.storagePath)
  const corrected=await h.handlers.emitirFaturaNatureForce(h.request)
  assert.equal(corrected.valorAprovado,'150.00');assert.equal(h.records.get('faturas/fat_test').data.valorTotal,150)
  const version=h.records.get(`faturas/fat_test/emissoesNatureForce/${h.request.data.operationId}`).data
  assert.equal(version.snapshot.approval.valorAnterior,'123.45')
  assert.equal(version.snapshot.approval.valorCalculadoImportacao,'123.45')
  assert.equal(h.records.get('faturas/fat_test').data.calculo.valorFinal,123.45)
  assert.equal(h.records.get('faturas/fat_test').data.pagamentoStatus,undefined)
})

test('configuração administrativa valida e audita dados oficiais sem preencher valores padrão',async()=>{
  const h=harness()
  h.records.delete('configuracoes/faturamentoNatureForce')
  assert.equal((await h.handlers.configurarFaturamentoNatureForce({auth:{role:'admin'},data:{action:'read'}})).settings,null)
  await assert.rejects(h.handlers.configurarFaturamentoNatureForce({auth:{role:'client'},data:{settings:base().settings}}),{code:'permission-denied'})
  await assert.rejects(h.handlers.configurarFaturamentoNatureForce({auth:{role:'admin'},data:{settings:{}}}),/Pix/)
  await h.handlers.configurarFaturamentoNatureForce({auth:{role:'admin'},data:{settings:base().settings}})
  const saved=(await h.handlers.configurarFaturamentoNatureForce({auth:{role:'admin'},data:{action:'read'}})).settings
  assert.equal(saved.pix.chave,'financeiro@example.com');assert.equal(saved.updatedBy,'admin');assert.ok(saved.revision)
  assert.ok([...h.records.values()].some(x=>x.data.operation==='INVOICE_SETTINGS_UPDATED'))
})
