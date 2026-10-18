const PDFDocument = require('pdfkit')
const QRCode = require('qrcode')
const Decimal = require('decimal.js')
const path = require('node:path')

const TEMPLATE_VERSION = 'nf-a4-1'
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: dado obrigatório ausente.`)
  if (value.length > 2000) throw new Error(`${label}: texto excede 2000 caracteres.`)
  return value.trim()
}
const decimal = (value, label) => {
  if (value === null || value === undefined || value === '' || String(value).length > 64 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(String(value))) {
    throw new Error(`${label}: informe um decimal não negativo, com ponto decimal.`)
  }
  const result = new Decimal(value)
  if (!result.isFinite() || result.gt('999999999999')) throw new Error(`${label}: valor fora do limite.`)
  return result
}
const money = (value) => decimal(value, 'Valor').toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
const currency = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value)
const ascii = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
const tlv = (id, value) => `${id}${String(Buffer.byteLength(value, 'utf8')).padStart(2, '0')}${value}`
const crc16 = (input) => {
  let crc = 0xffff
  for (const byte of Buffer.from(input, 'utf8')) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

function validateSettings(input) {
  const pix = input?.pix || {}
  const key = required(pix.chave, 'Chave Pix')
  if (!/^[\x21-\x7e]+$/.test(key) || Buffer.byteLength(key, 'utf8') > 77) throw new Error('Chave Pix: use até 77 caracteres ASCII sem espaços.')
  const type = pix.tipo
  const digits = key.replace(/\D/g, '')
  const validDocument = (length) => {
    if (key !== digits || digits.length !== length || /^(\d)\1+$/.test(digits)) return false
    const check = (base, weights) => {
      const rest = base.split('').reduce((sum, n, i) => sum + Number(n) * weights[i], 0) % 11
      return rest < 2 ? 0 : 11 - rest
    }
    const weights = length === 11 ? [10,9,8,7,6,5,4,3,2] : [5,4,3,2,9,8,7,6,5,4,3,2]
    const first = check(digits.slice(0, -2), weights)
    const next = length === 11 ? [11,...weights] : [6,...weights]
    return digits.endsWith(`${first}${check(digits.slice(0, -1), next)}`)
  }
  const valid = type === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key) && key.length <= 77
    : type === 'telefone' ? /^\+[1-9]\d{9,14}$/.test(key)
    : type === 'aleatoria' ? /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(key)
    : type === 'cpf' ? validDocument(11) : type === 'cnpj' ? validDocument(14) : false
  if (!valid) throw new Error('Chave Pix inválida para o tipo informado.')
  const titular = required(pix.titular, 'Titular Pix')
  const cidade = required(pix.cidade, 'Cidade Pix')
  if (!/^[A-Z0-9 $%*+\-./:]{1,25}$/.test(ascii(titular))) throw new Error('Titular Pix: use até 25 caracteres compatíveis com BR Code.')
  if (!/^[A-Z0-9 $%*+\-./:]{1,15}$/.test(ascii(cidade))) throw new Error('Cidade Pix: use até 15 caracteres compatíveis com BR Code.')
  const companyName = required(input.nome, 'Razão social da empresa')
  const companyDocument = required(input.documento, 'Documento da empresa')
  const companyAddress = required(input.endereco, 'Endereço da empresa')
  if (companyName.length > 160 || companyDocument.length > 32 || companyAddress.length > 500) throw new Error('Empresa: limites de 160 caracteres para razão social, 32 para documento e 500 para endereço.')
  return {
    nome: companyName,
    documento: companyDocument,
    endereco: companyAddress,
    pix: { tipo: type, chave: key, titular, cidade },
  }
}

function pixPayload(settings) {
  const { pix } = validateSettings(settings)
  const account = tlv('00', 'br.gov.bcb.pix') + tlv('01', pix.chave)
  // Static reusable BR Code: no tag 54 (amount), no invoice/client identifiers.
  const payload = tlv('00', '01') + tlv('01', '11') + tlv('26', account) + tlv('52', '0000') +
    tlv('53', '986') + tlv('58', 'BR') + tlv('59', ascii(pix.titular)) +
    tlv('60', ascii(pix.cidade)) + tlv('62', tlv('05', '***')) + '6304'
  return payload + crc16(payload)
}

function buildInvoice({ fatura, cliente, unidade, settings, approval, history = [], generatedAt }) {
  const empresa = validateSettings(settings)
  const uc = required(unidade.numeroUC, 'UC original')
  const normalize = (v) => String(v ?? '').replace(/\D/g, '')
  if (!normalize(uc) || normalize(fatura.uc) !== normalize(uc) || fatura.ucId !== unidade.id ||
      fatura.clienteId !== cliente.uid || ![cliente.uid, cliente.id].includes(unidade.clienteId)) {
    throw new Error('Vínculo fatura, cliente e UC inconsistente.')
  }
  const ref = required(fatura.referencia, 'Competência')
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ref)) throw new Error('Competência inválida: use AAAA-MM, formato canônico do sistema.')
  const date = required(fatura.vencimento, 'Vencimento')
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Vencimento inválido: use AAAA-MM-DD.')
  if (approval?.confirmed !== true || !approval.actorUid) throw new Error('Aprovação financeira explícita obrigatória.')
  // Existing extraction calculations are suggestions, never proof of approval.
  const registeredTotal = money(fatura.valorTotal)
  if (!decimal(fatura.valorTotal, 'Valor final').eq(registeredTotal)) throw new Error('Valor registrado possui fração de centavo; corrija antes de aprovar.')
  if (approval.expectedTotal !== registeredTotal) throw new Error('O valor da fatura mudou. Revise e aprove novamente.')
  const total = approval.valorRetificado == null || approval.valorRetificado === '' ? registeredTotal : money(approval.valorRetificado)
  if (approval.valorRetificado != null && approval.valorRetificado !== '' && !decimal(approval.valorRetificado,'Valor retificado').eq(total)) throw new Error('Valor retificado possui fração de centavo.')
  const isCorrection = total !== registeredTotal
  const correctionReason = isCorrection ? required(approval.motivoRetificacao, 'Motivo da retificação financeira') : null
  const percent = decimal(approval.percentualDesconto, 'Percentual contratado')
  if (percent.gt(100)) throw new Error('Percentual contratado deve estar entre 0 e 100.')
  const previouslyApproved = fatura.natureForce?.valorAprovado === registeredTotal
  if (!isCorrection && !previouslyApproved && fatura.calculo?.valorFinal != null && !decimal(fatura.calculo.valorFinal, 'Valor calculado').eq(total)) {
    throw new Error('Divergência entre valorTotal e calculo.valorFinal. Corrija os registros antes de emitir.')
  }
  const records = new Map()
  for (const item of history) {
    if (item.clienteId !== cliente.uid || item.ucId !== unidade.id || normalize(item.uc) !== normalize(uc) || item.versaoAtual === false) continue
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(item.referencia))
    if (!m || item.consumo == null || item.consumo === '') continue
    const key = `${m[1]}-${m[2]}`
    if (key > ref) continue
    const value = decimal(item.consumo, 'Consumo histórico').toString()
    if (records.has(key) && records.get(key) !== value) throw new Error('Histórico de consumo ambíguo para a mesma UC e competência.')
    records.set(key, value)
  }
  const start = new Date(Date.UTC(Number(ref.slice(0,4)), Number(ref.slice(5)) - 6, 1))
  const lower = `${start.getUTCFullYear()}-${String(start.getUTCMonth()+1).padStart(2,'0')}`
  return {
    templateVersion: TEMPLATE_VERSION, generatedAt, empresa,
    cliente: { nome: required(cliente.nome, 'Nome do cliente'), documento: required(cliente.cpfCnpj, 'CPF/CNPJ do cliente'), endereco: required(cliente.endereco, 'Endereço do cliente') },
    uc, referencia: ref, vencimento: date, numero: required(approval.numero, 'Número da fatura'),
    total, percentualDesconto: percent.toString(),
    consumo: fatura.consumo == null ? null : decimal(fatura.consumo, 'Consumo medido').toString(),
    // No compensated-energy, tariff validity or commercial line items exist in the current schema.
    composicaoDisponivel: false,
    history: [...records].filter(([key]) => key >= lower).sort(([a], [b]) => a.localeCompare(b)).slice(-6).map(([mes, consumo]) => ({ mes, consumo })),
    approval: { actorUid: approval.actorUid, numero: approval.numero, percentualDesconto: percent.toString(), valorAprovado: total, competencia: ref, confirmedAt: generatedAt,
      valorAnterior: registeredTotal, motivoRetificacao: correctionReason, valorCalculadoImportacao: fatura.calculo?.valorFinal == null ? null : String(fatura.calculo.valorFinal) },
    pixPayload: pixPayload(empresa),
  }
}

async function renderInvoice(data) {
  const qr = await QRCode.toBuffer(data.pixPayload, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 320 })
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 28, info: { Title: `Fatura Nature Force ${data.numero}`, Author: data.empresa.nome } })
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    const green = '#105331', light = '#dfefc6', width = 539
    let y = 28
    const page = () => { doc.addPage(); y = 32 }
    const text = (value, x, top, w, size = 9, bold = false, color = '#203329') => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color).text(String(value), x, top, { width: w, lineGap: 3 })
    }
    const height = (value, w, size = 9, bold = false) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).heightOfString(String(value), { width: w, lineGap: 3 })
    const fitted = (value, w, max = 24) => {
      let size=max
      while(size>7 && doc.font('Helvetica-Bold').fontSize(size).widthOfString(String(value))>w) size--
      return size
    }
    const ensure = (h) => { if (y + h > 800) page() }
    const box = (x, top, w, h, fill = '#ffffff') => doc.roundedRect(x, top, w, h, 8).fillAndStroke(fill, '#ceddcc')
    const section = (title, body) => {
      const parts = body.split('\n')
      let block = []
      let h = 36
      const flush = () => {
        ensure(h + 12); box(28,y,width,h); text(title,40,y+10,width-24,10,true,green)
        let cy = y+30
        for (const line of block) { text(line,40,cy,width-24); cy += height(line,width-24)+5 }
        y += h+12; block=[]; h=36
      }
      for (const part of parts) {
        // Wrap long content into bounded lines so even very long addresses paginate.
        let line = ''
        for (const word of part.split(/\s+/)) {
          const candidate = `${line} ${word}`.trim()
          if (height(candidate,width-24) > 28 && line) {
            const lh=height(line,width-24)+5
            if (h+lh > 600) flush()
            block.push(line); h+=lh; line=word
          } else line=candidate
        }
        if (line) { const lh=height(line,width-24)+5; if(h+lh>600) flush(); block.push(line); h+=lh }
      }
      flush()
    }
    doc.save().circle(570,-12,117).fill('#438f48').circle(530,-35,130).fill(green).restore()
    doc.image(path.join(__dirname, 'assets/logo.png'),28,y,{fit:[180,64]})
    y += 73
    text('FATURA DE ENERGIA POR ASSINATURA',28,y,265,14,true,green)
    const institution=`${data.empresa.nome}\n${data.empresa.documento}\n${data.empresa.endereco}`
    text(institution,320,y,247,8)
    y += Math.max(38,height(institution,247,8))+14
    const clientBody=`${data.cliente.nome}\nCPF/CNPJ: ${data.cliente.documento}\n${data.cliente.endereco}\nUnidade Consumidora: ${data.uc}`
    const compactClientHeight=height(clientBody,240)+42
    const identity = `FATURA Nº ${data.numero}     VENCIMENTO ${data.vencimento.split('-').reverse().join('/')}     REFERÊNCIA ${data.referencia}`
    if(compactClientHeight<=160 && data.numero.length<=30){
      const h=Math.max(compactClientHeight,132)
      ensure(h+12);box(28,y,265,h);text('DADOS DO CLIENTE',40,y+10,240,10,true,green);text(clientBody,40,y+32,240)
      const rightIdentity=`FATURA Nº ${data.numero}\nVENCIMENTO ${data.vencimento.split('-').reverse().join('/')}   REFERÊNCIA ${data.referencia}`
      const ih=height(rightIdentity,249,8,true)+18
      box(303,y,264,ih,green);text(rightIdentity,313,y+9,244,8,true,'#ffffff')
      box(303,y+ih+7,264,h-ih-7,light);text('VALOR A PAGAR À NATURE FORCE',313,y+ih+17,244,9,true,green)
      text(currency(data.total),313,y+ih+38,244,fitted(currency(data.total),244),true,green);y+=h+12
    }else{
      section('DADOS DO CLIENTE',clientBody)
      const ih = height(identity,width-24,10,true)+20
      ensure(ih+100); box(28,y,width,ih,green);text(identity,40,y+10,width-24,10,true,'#ffffff'); y+=ih+8
      box(28,y,width,75,light);text('VALOR A PAGAR À NATURE FORCE',40,y+9,width-24,11,true,green)
      text(currency(data.total),40,y+29,width-24,27,true,green);y+=87
    }
    section('RESUMO DA ENERGIA COMPENSADA',`Desconto contratado declarado pelo administrador: ${data.percentualDesconto}% (competência ${data.referencia}).\nComposição da cobrança e energia efetivamente compensada: não disponíveis nos registros atuais. Valor final aprovado administrativamente.\nConsumo medido: ${data.consumo === null ? 'não informado' : `${data.consumo} kWh`}. Economia mensal: não demonstrada.`)
    ensure(150); box(28,y,330,138);box(368,y,199,138,green)
    text('EVOLUÇÃO DO CONSUMO (kWh)',40,y+10,305,10,true,green)
    if (!data.history.length) text('Histórico não disponível.',40,y+50,300)
    else {
      const max = Math.max(1,...data.history.map(v=>Number(v.consumo)))
      const step=300/data.history.length
      data.history.forEach((item,i)=>{
        const x=42+i*step, bar=Number(item.consumo)/max*70
        doc.rect(x,y+115-bar,Math.min(25,step-10),bar).fill(green)
        text(item.consumo,x,y+100-bar,step-3,fitted(item.consumo,step-3,7),true)
        text(`${item.mes.slice(5)}/${item.mes.slice(2,4)}`,x,y+123,step-3,7)
      })
    }
    text('ECONOMIA ACUMULADA',380,y+15,175,10,true,'#ffffff')
    text('Não demonstrada nos registros.\n\nSaldo de créditos: não informado.',380,y+44,175,10,false,'#ffffff'); y+=150
    const important=`A conta da distribuidora é separada desta cobrança. Valores devidos à distribuidora: não informados.\n\nApós o pagamento, envie o comprovante e informe sua Unidade Consumidora (UC) para identificação.\n\nA confirmação depende de conferência e baixa manual por administrador.`
    const pixText=`Chave Pix (${data.empresa.pix.tipo}): ${data.empresa.pix.chave}\nTitular: ${data.empresa.pix.titular}\nInforme no banco ${currency(data.total)}.`
    const ph=Math.max(height(important,267,8)+40,height(pixText,216,8)+120)
    ensure(ph+12);box(28,y,291,ph);text('IMPORTANTE',40,y+10,267,10,true,green);text(important,40,y+30,267,8)
    box(329,y,238,ph);text('PAGUE COM PIX',341,y+10,214,11,true,green);doc.image(qr,341,y+29,{width:80});text(pixText,341,y+114,214,8);y+=ph+9
    const footer=`Template ${data.templateVersion} • Emitida em ${data.generatedAt}. Histórico: registros existentes dos últimos seis meses; meses ausentes não representam consumo zero.`
    ensure(height(footer,width,7));text(footer,28,y,width,7)
    doc.end()
  })
}

module.exports = { TEMPLATE_VERSION, validateSettings, pixPayload, crc16, buildInvoice, renderInvoice, money }
