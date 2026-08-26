// ==================== Estados de Processamento da Fatura ====================
// Ciclo de vida do processamento de um PDF de fatura.
//
//   PENDENTE       → aguardando processamento
//   PROCESSANDO    → em processamento (extração/identificação)
//   PROCESSADO     → identificado e processado com sucesso
//   REVISAO_MANUAL → UC não encontrada / múltiplas UCs / cliente incompatível
//                    (nunca inventar ou associar automaticamente)
//   ERRO_EXTRACAO  → PDF ilegível ou sem dados de identificação
//   DUPLICADA      → fatura já cadastrada (idempotência)
export const STATUS_FATURA = Object.freeze({
  PENDENTE: 'PENDENTE',
  PROCESSANDO: 'PROCESSANDO',
  PROCESSADO: 'PROCESSADO',
  REVISAO_MANUAL: 'REVISAO_MANUAL',
  ERRO_EXTRACAO: 'ERRO_EXTRACAO',
  DUPLICADA: 'DUPLICADA',
})

// Motivos que levam uma fatura à revisão manual (rastreabilidade).
export const MOTIVO_REVISAO = Object.freeze({
  UC_NAO_ENCONTRADA: 'UC_NAO_ENCONTRADA',
  UC_AUSENTE_NO_PDF: 'UC_AUSENTE_NO_PDF',
  MULTIPLAS_UCS: 'MULTIPLAS_UCS',
  UC_SEM_CLIENTE: 'UC_SEM_CLIENTE',
  CLIENTE_INCOMPATIVEL: 'CLIENTE_INCOMPATIVEL',
  SEM_DADOS_IDENTIFICACAO: 'SEM_DADOS_IDENTIFICACAO',
})

// Rótulos amigáveis para exibição.
export const ROTULO_MOTIVO_REVISAO = Object.freeze({
  [MOTIVO_REVISAO.UC_NAO_ENCONTRADA]: 'UC não encontrada',
  [MOTIVO_REVISAO.UC_AUSENTE_NO_PDF]: 'UC ausente no PDF',
  [MOTIVO_REVISAO.MULTIPLAS_UCS]: 'Múltiplas UCs possíveis',
  [MOTIVO_REVISAO.UC_SEM_CLIENTE]: 'UC sem cliente vinculado',
  [MOTIVO_REVISAO.CLIENTE_INCOMPATIVEL]: 'Cliente incompatível com a UC',
  [MOTIVO_REVISAO.SEM_DADOS_IDENTIFICACAO]: 'Sem dados de identificação',
})
