import { useEffect, useState } from 'react'
import { getFunctions, httpsCallable } from 'firebase/functions'
import app from '../../firebase/config'

const call = async (name, data) => (await httpsCallable(getFunctions(app), name)(data)).data

export function NatureForceSettings() {
  const [form, setForm] = useState({ nome:'', documento:'', endereco:'', pix:{ tipo:'', chave:'', titular:'', cidade:'' } })
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  useEffect(()=>{ call('configurarFaturamentoNatureForce',{action:'read'}).then(({settings})=>{
    if(settings) setForm(settings)
  }).catch(e=>setMessage(e.message)) },[])
  return <section className="panel">
    <h3>Emissão Nature Force — empresa e Pix comum</h3>
    <p>Preencha com dados oficiais. Nenhuma informação da fatura de referência é usada como configuração.</p>
    <form onSubmit={async e=>{e.preventDefault();setBusy(true);try{
      await call('configurarFaturamentoNatureForce',{settings:form});setMessage('Configuração salva e validada.')
    }catch(error){setMessage(error.message)}finally{setBusy(false)}}}>
      {['nome','documento','endereco'].map(key=><label key={key} style={{display:'block',margin:'8px 0'}}>
        {{nome:'Razão social',documento:'CPF/CNPJ da empresa',endereco:'Endereço institucional'}[key]}
        <input required maxLength={2000} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})}/>
      </label>)}
      <label>Tipo da chave Pix <select required value={form.pix.tipo} onChange={e=>setForm({...form,pix:{...form.pix,tipo:e.target.value}})}>
        <option value="">Selecione</option>{['cpf','cnpj','email','telefone','aleatoria'].map(type=><option key={type} value={type}>{type}</option>)}
      </select></label>
      {['chave','titular','cidade'].map(key=><label key={key} style={{display:'block',margin:'8px 0'}}>
        {{chave:'Chave Pix (CPF/CNPJ sem pontuação; telefone com +55)',titular:'Titular do Pix (até 25 caracteres)',cidade:'Cidade do recebedor (até 15 caracteres)'}[key]}
        <input required value={form.pix[key]} onChange={e=>setForm({...form,pix:{...form.pix,[key]:e.target.value}})}/>
      </label>)}
      <button disabled={busy}>{busy?'Salvando…':'Salvar configuração oficial'}</button>
      <p role="status">{message}</p>
    </form>
  </section>
}

export function NatureForceEmission({invoice}) {
  const [numero,setNumero]=useState('')
  const [percent,setPercent]=useState('')
  const [confirmed,setConfirmed]=useState(false)
  const [confirmedTotal,setConfirmedTotal]=useState(null)
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  const [operationId,setOperationId]=useState(()=>crypto.randomUUID())
  const [receipt,setReceipt]=useState('')
  const [correctedTotal,setCorrectedTotal]=useState('')
  const [reason,setReason]=useState('')
  const id=invoice.idFatura || invoice.firestoreId || String(invoice.id)
  return <details style={{margin:'12px 0'}}><summary>Emitir / corrigir fatura Nature Force · baixa manual</summary>
    <p>O PDF original da distribuidora será preservado. A emissão usa o valor registrado no servidor e exige aprovação financeira explícita.</p>
    <form onSubmit={async e=>{e.preventDefault();setBusy(true);try{
      const total=Number(invoice.valorTotal)
      if(invoice.valorTotal == null || !Number.isFinite(total)) throw new Error('Valor final ausente; corrija a fatura antes de aprovar.')
      await call('emitirFaturaNatureForce',{faturaId:id,operationId,approval:{
        numero,percentualDesconto:percent,confirmed,expectedTotal:confirmedTotal,
        valorRetificado:correctedTotal || null,motivoRetificacao:reason,
      }})
      setMessage('Fatura publicada. Pagamento depende de baixa manual.');setOperationId(crypto.randomUUID());setConfirmed(false);setCorrectedTotal('');setReason('')
    }catch(error){setMessage(error.message)}finally{setBusy(false)}}}>
      <label>Número oficial da fatura <input required maxLength={120} value={numero} onChange={e=>{setNumero(e.target.value);setOperationId(crypto.randomUUID());setConfirmed(false)}}/></label>
      <label>Desconto contratado nesta competência (%) <input required type="number" min="0" max="100" step="0.01" value={percent} onChange={e=>{setPercent(e.target.value);setOperationId(crypto.randomUUID());setConfirmed(false)}}/></label>
      <label>Retificar valor final (opcional, R$) <input type="number" min="0" step="0.01" value={correctedTotal} onChange={e=>{setCorrectedTotal(e.target.value);setOperationId(crypto.randomUUID());setConfirmed(false)}}/></label>
      {correctedTotal && <label>Justificativa da retificação <input required maxLength={2000} value={reason} onChange={e=>{setReason(e.target.value);setOperationId(crypto.randomUUID());setConfirmed(false)}}/></label>}
      <label style={{display:'block'}}><input type="checkbox" required checked={confirmed} onChange={e=>{setConfirmed(e.target.checked);setConfirmedTotal(invoice.valorTotal == null ? null : Number(invoice.valorTotal).toFixed(2))}}/>
        Conferi e aprovo a cobrança de R$ {correctedTotal || (invoice.valorTotal ?? 'não informado')} para esta UC e competência, e confirmo o percentual contratado. A composição não está demonstrada no cadastro atual.
      </label>
      <button disabled={busy}>{busy?'Processando…':invoice.natureForce?'Publicar nova versão corrigida':'Aprovar valor e emitir PDF'}</button>
    </form>
    {invoice.natureForce && <div>
      <p>Versão {invoice.natureForce.versao} · Pagamento: {invoice.pagamentoStatus === 'pago'?'pago':'aguardando conferência manual'}</p>
      <label>Referência do comprovante conferido <input maxLength={200} value={receipt} onChange={e=>setReceipt(e.target.value)}/></label>
      <button disabled={busy || !receipt.trim() || invoice.pagamentoStatus==='pago'} onClick={async()=>{setBusy(true);try{
        await call('baixarFaturaNatureForceManualmente',{faturaId:id,comprovanteReferencia:receipt});setMessage('Baixa manual registrada.')
      }catch(error){setMessage(error.message)}finally{setBusy(false)}}}>Confirmar pagamento manualmente</button>
    </div>}
    <p role="status">{message}</p>
  </details>
}
