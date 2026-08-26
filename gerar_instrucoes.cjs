// ==================== Gera PDF com instruções de alimentação do sistema ====================
const PDFDocument = require('pdfkit')
const fs = require('fs')
const path = require('path')

// ==================== Cores da marca ====================
const CORES = {
  verdePrimario: '#16a34a',
  verdeEscuro: '#14532d',
  verdeClaro: '#dcfce7',
  cinzaTexto: '#334155',
  cinzaClaro: '#f1f5f9',
  cinzaBorda: '#cbd5e1',
  vermelho: '#dc2626',
  azul: '#2563eb',
  branco: '#ffffff',
  amarelo: '#f59e0b',
}

// ==================== Configurações ====================
const MARGEM = 50
const LARGURA_PAGINA = 595.28 // A4
const ALTURA_PAGINA = 841.89 // A4
const LARGURA_UTIL = LARGURA_PAGINA - MARGEM * 2

// ==================== Helpers ====================
function desenharCabecalho(doc) {
  // Faixa verde superior
  doc.rect(0, 0, LARGURA_PAGINA, 60).fill(CORES.verdeEscuro)

  // Logo NF
  doc.fillColor(CORES.branco)
  doc.font('Helvetica-Bold').fontSize(16)
  doc.text('NF', MARGEM, 12)
  doc.font('Helvetica').fontSize(9)
  doc.text('Nature Force', MARGEM, 32)

  // Título do documento
  doc.font('Helvetica-Bold').fontSize(11)
  doc.text('Guia de Alimentação do Sistema', 0, 15, {
    align: 'right',
    width: LARGURA_PAGINA - MARGEM,
  })
  doc.font('Helvetica').fontSize(8)
  doc.text('Faturas UC e Contas de Energia', 0, 32, {
    align: 'right',
    width: LARGURA_PAGINA - MARGEM,
  })
}

function desenharRodape(doc) {
  const y = ALTURA_PAGINA - 30
  doc.strokeColor(CORES.cinzaBorda).lineWidth(0.5)
  doc.moveTo(MARGEM, y).lineTo(LARGURA_PAGINA - MARGEM, y).stroke()
  doc.fillColor('#94a3b8').font('Helvetica').fontSize(8)
  doc.text(
    `Nature Force · Guia de Alimentação do Sistema · Página ${doc.page}`,
    0,
    y + 8,
    { align: 'center', width: LARGURA_PAGINA },
  )
}

function novaPagina(doc) {
  doc.addPage()
  desenharCabecalho(doc)
}

function tituloSecao(doc, texto) {
  doc.moveDown(1.5)
  doc.fillColor(CORES.verdeEscuro)
  doc.font('Helvetica-Bold').fontSize(16)
  doc.text(texto, MARGEM, doc.y)
  doc.moveDown(0.5)
  doc.strokeColor(CORES.verdePrimario).lineWidth(1.5)
  doc.moveTo(MARGEM, doc.y).lineTo(MARGEM + 60, doc.y).stroke()
  doc.moveDown(0.8)
}

function subtitulo(doc, texto) {
  doc.moveDown(0.8)
  doc.fillColor(CORES.verdePrimario)
  doc.font('Helvetica-Bold').fontSize(13)
  doc.text(texto, MARGEM, doc.y)
  doc.moveDown(0.5)
}

function paragrafo(doc, texto, tamanho = 10) {
  doc.fillColor(CORES.cinzaTexto)
  doc.font('Helvetica').fontSize(tamanho)
  const linhas = doc.heightOfString(texto, { width: LARGURA_UTIL })
  if (doc.y + linhas > ALTURA_PAGINA - 60) {
    novaPagina(doc)
  }
  doc.text(texto, MARGEM, doc.y, { width: LARGURA_UTIL, lineGap: 4 })
  doc.moveDown(0.5)
}

function paragrafoBold(doc, texto, tamanho = 10) {
  doc.fillColor(CORES.cinzaTexto)
  doc.font('Helvetica-Bold').fontSize(tamanho)
  const linhas = doc.heightOfString(texto, { width: LARGURA_UTIL })
  if (doc.y + linhas > ALTURA_PAGINA - 60) {
    novaPagina(doc)
  }
  doc.text(texto, MARGEM, doc.y, { width: LARGURA_UTIL, lineGap: 4 })
  doc.moveDown(0.5)
}

function caixaDica(doc, texto) {
  doc.moveDown(0.5)
  const altura = doc.heightOfString(texto, { width: LARGURA_UTIL - 30 })
  const y = doc.y
  if (y + altura + 30 > ALTURA_PAGINA - 60) {
    novaPagina(doc)
  }
  doc.roundedRect(MARGEM, y, LARGURA_UTIL, altura + 30, 8).fill(CORES.verdeClaro)
  doc.fillColor(CORES.verdeEscuro)
  doc.font('Helvetica').fontSize(9.5)
  doc.text(`💡 ${texto}`, MARGEM + 15, y + 15, {
    width: LARGURA_UTIL - 30,
    lineGap: 3,
  })
  doc.y = y + altura + 40
}

function caixaAviso(doc, texto) {
  doc.moveDown(0.5)
  const altura = doc.heightOfString(texto, { width: LARGURA_UTIL - 30 })
  const y = doc.y
  if (y + altura + 30 > ALTURA_PAGINA - 60) {
    novaPagina(doc)
  }
  doc.roundedRect(MARGEM, y, LARGURA_UTIL, altura + 30, 8).fill('#fef2f2')
  doc.fillColor(CORES.vermelho)
  doc.font('Helvetica').fontSize(9.5)
  doc.text(`⚠️ ${texto}`, MARGEM + 15, y + 15, {
    width: LARGURA_UTIL - 30,
    lineGap: 3,
  })
  doc.y = y + altura + 40
}

function caixaInfo(doc, texto) {
  doc.moveDown(0.5)
  const altura = doc.heightOfString(texto, { width: LARGURA_UTIL - 30 })
  const y = doc.y
  if (y + altura + 30 > ALTURA_PAGINA - 60) {
    novaPagina(doc)
  }
  doc.roundedRect(MARGEM, y, LARGURA_UTIL, altura + 30, 8).fill('#eff6ff')
  doc.fillColor(CORES.azul)
  doc.font('Helvetica').fontSize(9.5)
  doc.text(`ℹ️ ${texto}`, MARGEM + 15, y + 15, {
    width: LARGURA_UTIL - 30,
    lineGap: 3,
  })
  doc.y = y + altura + 40
}

function listaNumerada(doc, itens) {
  doc.moveDown(0.3)
  itens.forEach((item, index) => {
    const numero = `${index + 1}.`
    const larguraNumero = 25
    const texto = item
    const altura = doc.heightOfString(texto, { width: LARGURA_UTIL - larguraNumero })
    if (doc.y + altura > ALTURA_PAGINA - 60) {
      novaPagina(doc)
    }
    doc.fillColor(CORES.verdePrimario)
    doc.font('Helvetica-Bold').fontSize(10)
    doc.text(numero, MARGEM, doc.y, { width: larguraNumero })
    doc.fillColor(CORES.cinzaTexto)
    doc.font('Helvetica').fontSize(10)
    doc.text(texto, MARGEM + larguraNumero, doc.y, {
      width: LARGURA_UTIL - larguraNumero,
      lineGap: 3,
    })
    doc.moveDown(0.4)
  })
  doc.moveDown(0.3)
}

function listaMarcadores(doc, itens) {
  doc.moveDown(0.3)
  itens.forEach((item) => {
    const larguraBullet = 20
    const texto = item
    const altura = doc.heightOfString(texto, { width: LARGURA_UTIL - larguraBullet })
    if (doc.y + altura > ALTURA_PAGINA - 60) {
      novaPagina(doc)
    }
    doc.fillColor(CORES.verdePrimario)
    doc.font('Helvetica-Bold').fontSize(10)
    doc.text('•', MARGEM, doc.y, { width: larguraBullet })
    doc.fillColor(CORES.cinzaTexto)
    doc.font('Helvetica').fontSize(10)
    doc.text(texto, MARGEM + larguraBullet, doc.y, {
      width: LARGURA_UTIL - larguraBullet,
      lineGap: 3,
    })
    doc.moveDown(0.4)
  })
  doc.moveDown(0.3)
}

function desenharTabela(doc, cabecalhos, linhas, larguras) {
  doc.moveDown(0.5)
  const alturaLinha = 24
  const padding = 6

  // Cabeçalho
  const yInicio = doc.y
  if (yInicio + alturaLinha * (linhas.length + 1) > ALTURA_PAGINA - 60) {
    novaPagina(doc)
  }

  // Cabeçalho da tabela
  doc.rect(MARGEM, doc.y, LARGURA_UTIL, alturaLinha).fill(CORES.verdeEscuro)
  let x = MARGEM
  cabecalhos.forEach((cab, i) => {
    doc.fillColor(CORES.branco)
    doc.font('Helvetica-Bold').fontSize(9)
    doc.text(cab, x + padding, doc.y + 7, { width: larguras[i] - padding * 2 })
    x += larguras[i]
  })
  doc.y += alturaLinha

  // Linhas
  linhas.forEach((linha, idx) => {
    if (doc.y + alturaLinha > ALTURA_PAGINA - 60) {
      novaPagina(doc)
    }
    // Fundo alternado
    if (idx % 2 === 0) {
      doc.rect(MARGEM, doc.y, LARGURA_UTIL, alturaLinha).fill(CORES.cinzaClaro)
    } else {
      doc.rect(MARGEM, doc.y, LARGURA_UTIL, alturaLinha).fill(CORES.branco)
    }
    // Borda
    doc.strokeColor(CORES.cinzaBorda).lineWidth(0.5)
    doc.rect(MARGEM, doc.y, LARGURA_UTIL, alturaLinha).stroke()

    let x = MARGEM
    linha.forEach((celula, i) => {
      doc.fillColor(CORES.cinzaTexto)
      doc.font('Helvetica').fontSize(8.5)
      doc.text(celula, x + padding, doc.y + 7, {
        width: larguras[i] - padding * 2,
        lineBreak: false,
      })
      x += larguras[i]
    })
    doc.y += alturaLinha
  })
  doc.moveDown(0.5)
}

// ==================== Conteúdo ====================
function gerarPDF(caminho) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 70, bottom: 50, left: MARGEM, right: MARGEM },
    info: {
      Title: 'Guia de Alimentação do Sistema - Nature Force',
      Author: 'Nature Force',
      Subject: 'Instruções para cadastro de faturas UC e contas de energia',
    },
  })

  const stream = fs.createWriteStream(caminho)
  doc.pipe(stream)

  desenharCabecalho(doc)

  // ==================== CAPA ====================
  doc.moveDown(4)
  doc.fillColor(CORES.verdeEscuro)
  doc.font('Helvetica-Bold').fontSize(28)
  doc.text('Nature Force', MARGEM, doc.y, { align: 'center', width: LARGURA_UTIL })
  doc.moveDown(0.5)
  doc.fillColor(CORES.verdePrimario)
  doc.font('Helvetica-Bold').fontSize(18)
  doc.text('Guia de Alimentação do Sistema', MARGEM, doc.y, { align: 'center', width: LARGURA_UTIL })
  doc.moveDown(0.3)
  doc.fillColor(CORES.cinzaTexto)
  doc.font('Helvetica').fontSize(12)
  doc.text('Como cadastrar faturas UC e contas de energia', MARGEM, doc.y, { align: 'center', width: LARGURA_UTIL })
  doc.moveDown(2)

  // Caixa de resumo
  const resumoTexto =
    'Este guia explica passo a passo como alimentar o sistema Nature Force com as faturas de energia (UC) e contas dos clientes.\n\n' +
    'O sistema processa automaticamente os PDFs das faturas, extrai os dados necessários, calcula o desconto de 20% e disponibiliza as informações para o cliente no painel de acesso.'
  const alturaResumo = doc.heightOfString(resumoTexto, { width: LARGURA_UTIL - 40 })
  doc.roundedRect(MARGEM, doc.y, LARGURA_UTIL, alturaResumo + 40, 10).fill(CORES.branco)
  doc.strokeColor(CORES.verdePrimario).lineWidth(1.5)
  doc.roundedRect(MARGEM, doc.y, LARGURA_UTIL, alturaResumo + 40, 10).stroke()
  doc.fillColor(CORES.cinzaTexto)
  doc.font('Helvetica').fontSize(11)
  doc.text(resumoTexto, MARGEM + 20, doc.y + 20, {
    width: LARGURA_UTIL - 40,
    lineGap: 5,
    align: 'center',
  })
  doc.y += alturaResumo + 50

  // Sumário
  doc.moveDown(1)
  doc.fillColor(CORES.verdeEscuro)
  doc.font('Helvetica-Bold').fontSize(16)
  doc.text('Sumário', MARGEM, doc.y)
  doc.moveDown(0.5)

  const sumario = [
    ['1. Visão geral do fluxo', 'Página 2'],
    ['2. Acessando o painel administrativo', 'Página 2'],
    ['3. Cadastrando clientes', 'Página 3'],
    ['4. Cadastrando unidades consumidoras (UCs)', 'Página 4'],
    ['5. Enviando faturas (PDFs)', 'Página 5'],
    ['6. Dados extraídos automaticamente', 'Página 6'],
    ['7. Formato ideal do PDF de fatura', 'Página 7'],
    ['8. Fluxo de revisão e publicação', 'Página 8'],
    ['9. Status das faturas', 'Página 8'],
    ['10. Dicas e boas práticas', 'Página 9'],
    ['11. Solução de problemas', 'Página 10'],
  ]

  sumario.forEach((linha, idx) => {
    if (idx % 2 === 0) {
      doc.rect(MARGEM, doc.y, LARGURA_UTIL, 24).fill(CORES.cinzaClaro)
    } else {
      doc.rect(MARGEM, doc.y, LARGURA_UTIL, 24).fill(CORES.branco)
    }
    doc.strokeColor(CORES.cinzaBorda).lineWidth(0.5)
    doc.rect(MARGEM, doc.y, LARGURA_UTIL, 24).stroke()
    doc.fillColor(CORES.cinzaTexto)
    doc.font('Helvetica-Bold').fontSize(9.5)
    doc.text(linha[0], MARGEM + 10, doc.y + 7)
    doc.font('Helvetica').fontSize(9.5)
    doc.text(linha[1], 0, doc.y + 7, { align: 'right', width: LARGURA_PAGINA - MARGEM - 10 })
    doc.y += 24
  })

  // ==================== PÁGINA 2 ====================
  novaPagina(doc)

  // 1. VISÃO GERAL
  tituloSecao(doc, '1. Visão geral do fluxo')
  paragrafo(
    doc,
    'O sistema Nature Force funciona com um fluxo simples de alimentação de dados. O administrador cadastra os clientes e suas unidades consumidoras (UCs), faz o upload dos PDFs das faturas de energia, e o sistema processa automaticamente todos os dados, calcula o desconto de 20% e publica as informações para o cliente visualizar no seu painel.',
  )

  subtitulo(doc, 'Fluxo completo:')
  const fluxo = [
    ['1️⃣', 'Cadastrar cliente', 'Criar o cadastro do cliente no painel administrativo'],
    ['2️⃣', 'Cadastrar UC', 'Vincular a unidade consumidora ao cliente'],
    ['3️⃣', 'Enviar fatura', 'Fazer upload do PDF da fatura de energia'],
    ['4️⃣', 'Processamento', 'O sistema extrai os dados e calcula o desconto de 20%'],
    ['5️⃣', 'Revisão', 'Verificar se os dados foram extraídos corretamente'],
    ['6️⃣', 'Publicação', 'Publicar a fatura para o cliente visualizar'],
  ]
  desenharTabela(doc, ['', 'Etapa', 'Descrição'], fluxo, [30, 120, LARGURA_UTIL - 150])

  caixaDica(
    doc,
    'O sistema aceita faturas de qualquer concessionária de energia (Neoenergia, Celpe, Enel, Cemig, etc.) desde que o PDF seja legível e contenha os dados básicos da fatura.',
  )

  // 2. ACESSANDO O PAINEL
  tituloSecao(doc, '2. Acessando o painel administrativo')
  paragrafo(
    doc,
    'Para alimentar o sistema, você precisa acessar o painel administrativo. O acesso é feito com as credenciais de administrador ou operador.',
  )
  subtitulo(doc, 'Passos:')
  listaNumerada(doc, [
    'Abra o navegador e acesse o endereço do sistema (ex: http://localhost:5173).',
    'Na tela de login, selecione a opção Administrador.',
    'Informe o e-mail de acesso e a senha do administrador.',
    'Clique em Entrar. Você será direcionado ao painel administrativo.',
  ])
  caixaInfo(
    doc,
    'O painel administrativo possui os menus: Dashboard, Clientes, Faturas, Revisões, Usuários, Logs e Relatórios.',
  )

  // ==================== PÁGINA 3 ====================
  novaPagina(doc)

  // 3. CADASTRANDO CLIENTES
  tituloSecao(doc, '3. Cadastrando clientes')
  paragrafo(
    doc,
    'Antes de enviar faturas, é necessário cadastrar o cliente no sistema. Cada cliente terá acesso ao seu próprio painel para visualizar faturas, consumo, economia e financeiro.',
  )
  subtitulo(doc, 'Passos:')
  listaNumerada(doc, [
    'No menu lateral, clique em Clientes.',
    'Clique no botão "+ Novo cliente".',
    'Preencha os campos obrigatórios:',
  ])

  const camposCliente = [
    ['Nome completo', 'Sim', 'Nome do cliente ou razão social'],
    ['CPF/CNPJ', 'Sim', 'Documento do cliente (com pontuação)'],
    ['Telefone', 'Não', 'Telefone de contato'],
    ['E-mail', 'Não', 'E-mail de contato'],
    ['Endereço', 'Não', 'Endereço completo'],
    ['Cidade / Estado / CEP', 'Não', 'Dados de localização'],
    ['WhatsApp', 'Não', 'Número para contato via WhatsApp'],
    ['E-mail de acesso (login)', 'Sim', 'E-mail que o cliente usará para entrar no sistema'],
    ['Senha de acesso', 'Sim', 'Senha do cliente para acesso ao painel'],
  ]
  desenharTabela(doc, ['Campo', 'Obrigatório', 'Descrição'], camposCliente, [130, 70, LARGURA_UTIL - 200])

  doc.moveDown(0.5)
  listaNumerada(doc, [
    'Clique em "Cadastrar cliente" para salvar.',
    'O cliente aparecerá na lista de clientes com o status Ativo.',
  ])
  caixaDica(
    doc,
    'O e-mail de acesso e a senha são as credenciais que o cliente usará para entrar no sistema e visualizar suas faturas, consumo e economia.',
  )

  // ==================== PÁGINA 4 ====================
  novaPagina(doc)

  // 4. CADASTRANDO UCs
  tituloSecao(doc, '4. Cadastrando unidades consumidoras (UCs)')
  paragrafo(
    doc,
    'Cada cliente pode ter uma ou mais unidades consumidoras (UCs). A UC é identificada pelo número da unidade consumidora e pelo código de instalação.',
  )
  subtitulo(doc, 'Onde encontrar os dados da UC na fatura:')
  caixaInfo(
    doc,
    'Na fatura de energia, procure pelos campos "Nº da UC" ou "Unidade Consumidora" (número de 6 a 12 dígitos) e "Código de Instalação" (número de 10 a 12 dígitos). Esses dados geralmente aparecem no topo da fatura, próximos aos dados do cliente.',
  )
  subtitulo(doc, 'Passos para cadastrar a UC:')
  listaNumerada(doc, [
    'No menu lateral, clique em Clientes.',
    'Localize o cliente na lista e clique em Editar.',
    'No formulário, adicione a UC com:',
  ])

  const camposUC = [
    ['Número da UC', 'Número da unidade consumidora (ex: 123456789)'],
    ['Código de instalação', 'Código da instalação (ex: 1234567890)'],
    ['Concessionária', 'Nome da concessionária (ex: Neoenergia Pernambuco)'],
    ['Tipo de fornecimento', 'Ex: Monofásico, Bifásico, Trifásico'],
  ]
  desenharTabela(doc, ['Campo', 'Descrição'], camposUC, [130, LARGURA_UTIL - 130])

  caixaDica(
    doc,
    'O número da UC é essencial para o sistema identificar a qual unidade a fatura pertence. Certifique-se de cadastrar corretamente.',
  )

  // ==================== PÁGINA 5 ====================
  novaPagina(doc)

  // 5. ENVIANDO FATURAS
  tituloSecao(doc, '5. Enviando faturas (PDFs)')
  paragrafo(
    doc,
    'O envio de faturas é feito no menu Faturas do painel administrativo. O sistema aceita arquivos PDF e processa automaticamente os dados da fatura.',
  )
  subtitulo(doc, 'Passos:')
  listaNumerada(doc, [
    'No menu lateral, clique em Faturas.',
    'Na seção "Upload de faturas", selecione o Cliente que receberá a fatura.',
    'Selecione a Unidade consumidora (UC) correspondente à fatura.',
    'Clique na área de upload ou arraste os arquivos PDF das faturas.',
    'O sistema processará automaticamente cada PDF, extraindo os dados e calculando o desconto de 20%.',
    'Após o processamento, a fatura aparecerá em uma das seções: Pendentes, Requerem revisão, Com erro ou Publicadas.',
  ])
  caixaInfo(
    doc,
    'Você pode enviar múltiplos PDFs de uma vez. O sistema processará cada arquivo individualmente e mostrará o status de cada um.',
  )
  caixaAviso(
    doc,
    'É obrigatório selecionar o cliente antes de enviar as faturas. Se nenhum cliente for selecionado, o sistema exibirá um erro.',
  )

  // ==================== PÁGINA 6 ====================
  novaPagina(doc)

  // 6. DADOS EXTRAÍDOS
  tituloSecao(doc, '6. Dados extraídos automaticamente')
  paragrafo(doc, 'Ao processar o PDF da fatura, o sistema extrai automaticamente os seguintes dados:')

  const dadosExtraidos = [
    ['UC', 'Número da unidade consumidora', '"UC: 123456789" ou "Unidade Consumidora"'],
    ['Cliente', 'Nome do titular da conta', '"Cliente: João Silva" ou "Consumidor"'],
    ['Referência', 'Mês/ano de competência', '"AGO/2026", "08/2026" ou "2026-08"'],
    ['Vencimento', 'Data de vencimento da fatura', '"Vencimento: 18/09/2026"'],
    ['Consumo', 'Consumo em kWh', '"Consumo: 250 kWh"'],
    ['Energia', 'Valor da energia elétrica', '"Energia Elétrica: R$ 150,00"'],
    ['TUSD', 'Tarifa de uso do sistema', '"TUSD: R$ 80,00"'],
    ['TE', 'Tarifa de energia', '"TE: R$ 70,00"'],
    ['ICMS', 'Imposto sobre circulação', '"ICMS: R$ 30,00"'],
    ['PIS', 'Programa de integração social', '"PIS: R$ 5,00"'],
    ['COFINS', 'Contribuição federal', '"COFINS: R$ 20,00"'],
    ['Encargos', 'Encargos setoriais (CDE, PROINFA)', '"Encargos: R$ 10,00"'],
    ['Iluminação', 'Contribuição de iluminação pública', '"Iluminação Pública: R$ 15,00"'],
    ['Créditos', 'Créditos de energia (geração)', '"Créditos: R$ 25,00"'],
    ['Descontos', 'Descontos ou subsídios', '"Desconto: R$ 5,00"'],
  ]
  desenharTabela(doc, ['Dado', 'O que é', 'Onde aparece na fatura'], dadosExtraidos, [80, 150, LARGURA_UTIL - 230])

  caixaDica(
    doc,
    'O sistema calcula o desconto de 20% sobre a parcela elegível (Energia + TUSD + TE). Impostos, encargos e iluminação pública não recebem desconto.',
  )

  // ==================== PÁGINA 7 ====================
  novaPagina(doc)

  // 7. FORMATO IDEAL DO PDF
  tituloSecao(doc, '7. Formato ideal do PDF de fatura')
  paragrafo(doc, 'Para que o sistema extraia os dados corretamente, o PDF da fatura deve atender aos seguintes requisitos:')

  subtitulo(doc, 'Requisitos do PDF:')
  listaMarcadores(doc, [
    'Formato: Arquivo PDF (não aceita imagens, fotos ou outros formatos).',
    'Legibilidade: O texto deve ser legível e não pode ser uma imagem escaneada sem OCR.',
    'Completo: O PDF deve conter todas as páginas da fatura.',
    'Original: Use o PDF original da concessionária, não uma versão editada.',
    'Nome do arquivo: Use um nome descritivo, ex: fatura_uc_123456_ago2026.pdf.',
  ])

  subtitulo(doc, 'Dados que devem estar presentes no PDF:')
  listaMarcadores(doc, [
    'Número da UC (ex: "UC: 123456789")',
    'Nome do cliente (ex: "Cliente: João Silva")',
    'Mês de referência (ex: "AGO/2026" ou "08/2026")',
    'Data de vencimento (ex: "Vencimento: 18/09/2026")',
    'Consumo em kWh (ex: "Consumo: 250 kWh")',
    'Valores dos componentes (Energia, TUSD, TE, ICMS, PIS, COFINS, etc.)',
  ])

  subtitulo(doc, 'Exemplo de trecho de fatura que o sistema reconhece:')
  const exemploTexto =
    'FATURA DE ENERGIA ELÉTRICA\n\n' +
    'UC: 123456789\n' +
    'Cliente: João da Silva\n' +
    'Referente a: AGO/2026\n' +
    'Vencimento: 18/09/2026\n\n' +
    'Energia Elétrica: R$ 150,00\n' +
    'TUSD: R$ 80,00\n' +
    'TE: R$ 70,00\n' +
    'ICMS: R$ 30,00\n' +
    'PIS: R$ 5,00\n' +
    'COFINS: R$ 20,00\n' +
    'Iluminação Pública: R$ 15,00\n\n' +
    'Consumo: 250 kWh'
  const alturaExemplo = doc.heightOfString(exemploTexto, { width: LARGURA_UTIL - 30 })
  doc.roundedRect(MARGEM, doc.y, LARGURA_UTIL, alturaExemplo + 30, 8).fill(CORES.cinzaClaro)
  doc.strokeColor(CORES.cinzaBorda).lineWidth(0.5)
  doc.roundedRect(MARGEM, doc.y, LARGURA_UTIL, alturaExemplo + 30, 8).stroke()
  doc.fillColor(CORES.cinzaTexto)
  doc.font('Courier').fontSize(9)
  doc.text(exemploTexto, MARGEM + 15, doc.y + 15, {
    width: LARGURA_UTIL - 30,
    lineGap: 3,
  })
  doc.y += alturaExemplo + 40

  caixaAviso(
    doc,
    'Se o PDF for uma imagem escaneada (sem texto selecionável), o sistema não conseguirá extrair os dados. Nesse caso, a fatura será marcada como "erro" ou "requer revisão".',
  )

  // ==================== PÁGINA 8 ====================
  novaPagina(doc)

  // 8. FLUXO DE REVISÃO
  tituloSecao(doc, '8. Fluxo de revisão e publicação')
  paragrafo(
    doc,
    'Após o upload, cada fatura passa por um fluxo de processamento e revisão antes de ser publicada para o cliente.',
  )

  const fluxoRevisao = [
    ['Upload do PDF', 'Processando', 'Aguardar o processamento automático'],
    ['Processamento concluído', 'Concluído', 'Verificar se os dados foram extraídos corretamente'],
    ['Fatura processada com sucesso', 'Aguardando revisão', 'Clicar em "Publicar p/ cliente"'],
    ['Fatura com dados incompletos', 'Requer revisão', 'Analisar no menu Revisões e aprovar ou remover'],
    ['Falha no processamento', 'Erro', 'Verificar o erro e reenviar ou remover'],
    ['Fatura publicada', 'Disponível', 'Cliente já pode visualizar no painel'],
  ]
  desenharTabela(doc, ['Etapa', 'Status', 'Ação do administrador'], fluxoRevisao, [130, 100, LARGURA_UTIL - 230])

  caixaDica(
    doc,
    'A fatura só fica visível para o cliente quando o status é "Disponível". Faturas com status "Aguardando revisão" precisam ser publicadas manualmente.',
  )

  // 9. STATUS DAS FATURAS
  tituloSecao(doc, '9. Status das faturas')
  paragrafo(doc, 'Cada fatura pode ter um dos seguintes status no sistema:')

  const statusTabela = [
    ['Disponível', 'Fatura processada e publicada para o cliente', '🟢 Verde'],
    ['Aguardando revisão', 'Fatura processada, aguardando publicação manual', '🟡 Amarelo'],
    ['Requer revisão', 'Dados incompletos ou não identificados com segurança', '🟠 Laranja'],
    ['Erro', 'Falha no processamento do PDF', '🔴 Vermelho'],
  ]
  desenharTabela(doc, ['Status', 'Significado', 'Cor'], statusTabela, [120, 220, LARGURA_UTIL - 340])

  // ==================== PÁGINA 9 ====================
  novaPagina(doc)

  // 10. DICAS E BOAS PRÁTICAS
  tituloSecao(doc, '10. Dicas e boas práticas')
  paragrafo(doc, 'Siga estas recomendações para garantir o melhor funcionamento do sistema:')

  subtitulo(doc, 'Cadastro de clientes:')
  listaMarcadores(doc, [
    'Cadastre o cliente antes de enviar as faturas.',
    'Verifique se o e-mail de acesso está correto, pois é com ele que o cliente fará login.',
    'Mantenha os dados de contato (telefone, WhatsApp, e-mail) sempre atualizados.',
  ])

  subtitulo(doc, 'Envio de faturas:')
  listaMarcadores(doc, [
    'Envie as faturas mensalmente, assim que receber o PDF da concessionária.',
    'Selecione sempre o cliente e a UC corretos antes do upload.',
    'Você pode enviar vários PDFs de uma vez para o mesmo cliente.',
    'Verifique o status de cada fatura após o processamento.',
    'Publique as faturas processadas para que o cliente possa visualizá-las.',
  ])

  subtitulo(doc, 'Qualidade dos PDFs:')
  listaMarcadores(doc, [
    'Use sempre o PDF original da concessionária.',
    'Evite PDFs escaneados ou com baixa qualidade de imagem.',
    'Se o PDF tiver múltiplas páginas, envie o arquivo completo.',
    'Nomeie os arquivos de forma descritiva para facilitar a identificação.',
  ])

  subtitulo(doc, 'Revisão de faturas:')
  listaMarcadores(doc, [
    'Acompanhe o menu Revisões para verificar faturas que precisam de atenção.',
    'Faturas com status "Requer revisão" podem ter dados incompletos — analise e corrija.',
    'Faturas com status "Erro" geralmente indicam PDF inválido ou ilegível — reenvie o arquivo.',
  ])

  // ==================== PÁGINA 10 ====================
  novaPagina(doc)

  // 11. SOLUÇÃO DE PROBLEMAS
  tituloSecao(doc, '11. Solução de problemas')
  paragrafo(doc, 'Problemas comuns e como resolvê-los:')

  const problemas = [
    ['"Nenhum componente de energia identificado"', 'O PDF não contém os valores de energia legíveis', 'Verifique se o PDF é legível e contém os valores de Energia, TUSD ou TE'],
    ['"Não foi possível ler o PDF"', 'Arquivo corrompido ou não é um PDF válido', 'Baixe novamente o PDF da concessionária e tente novamente'],
    ['Fatura com status "Erro"', 'Falha no processamento do arquivo', 'Remova a fatura e reenvie o PDF'],
    ['Fatura com status "Requer revisão"', 'Dados incompletos ou não identificados', 'Analise no menu Revisões e aprove ou remova'],
    ['Cliente não vê a fatura', 'Fatura não foi publicada', 'Publique a fatura clicando em "Publicar p/ cliente"'],
    ['UC não aparece no cadastro', 'UC não foi vinculada ao cliente', 'Edite o cliente e adicione a UC corretamente'],
  ]
  desenharTabela(doc, ['Problema', 'Causa provável', 'Solução'], problemas, [130, 140, LARGURA_UTIL - 270])

  // ==================== CONTATO ====================
  doc.moveDown(1.5)
  tituloSecao(doc, 'Precisa de ajuda?')
  paragrafo(
    doc,
    'Se você tiver dúvidas ou encontrar problemas ao alimentar o sistema, entre em contato com a equipe de suporte da Nature Force.',
  )

  const contato = [
    ['📧', 'E-mail:', 'suporte@natureforce.com.br'],
    ['📱', 'WhatsApp:', '(81) 9 9999-9999'],
    ['🌐', 'Site:', 'www.natureforce.com.br'],
  ]
  desenharTabela(doc, ['', 'Canal', 'Contato'], contato, [30, 80, LARGURA_UTIL - 110])

  doc.moveDown(1)
  doc.fillColor(CORES.verdePrimario)
  doc.font('Helvetica-Bold').fontSize(10)
  doc.text('— Fim do guia —', MARGEM, doc.y, { align: 'center', width: LARGURA_UTIL })

  // Finalizar
  doc.end()
  stream.on('finish', () => {
    console.log(`✅ PDF gerado com sucesso: ${caminho}`)
  })
}

// ==================== Execução ====================
const caminhoSaida = path.join(__dirname, 'Guia_Alimentacao_Sistema_NatureForce.pdf')
gerarPDF(caminhoSaida)