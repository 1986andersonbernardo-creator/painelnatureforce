// ==================== Reconstrução das Linhas do Texto do PDF ====================
// `page.getTextContent()` devolve uma lista PLANA de fragmentos de texto: cada
// item é um pedaço da linha com sua matriz `transform` [a, b, c, d, x, y].
//
// ERRO CLÁSSICO: juntar todos os itens da página com um único espaço —
//   content.items.map((i) => i.str).join(' ')
// Isso transforma a página inteira em UMA linha só e destrói a estrutura
// visual. Todo o classificador de faturas (faturaClassifier) é orientado a
// linhas: ele faz `texto.split('\n')` e usa `proxima` (a linha seguinte) para
// ler valores que ficam embaixo do rótulo, p.ex.:
//
//   NÚMERO DA UNIDADE CONSUMIDORA
//   1234567890
//
// Sem a reconstrução, `proxima` nunca é a linha seguinte (viram páginas) e a
// UC não é encontrada — o PDF válido é rejeitado como "formato/UC inválido".
//
// Estratégia usada aqui:
//   - preserva a ORDEM do fluxo do PDF (que é a ordem de leitura);
//   - quebra a linha quando a coordenada Y muda (tolerância configurável)
//     ou quando o item sinaliza fim de linha (`hasEOL`);
//   - ordena os fragmentos de cada linha pela coordenada X (esquerda → direita),
//     porque alguns geradores emitem os valores antes dos rótulos.
//
// Módulo puro (sem pdfjs) — é importável nos testes em Node.

// Diferença máxima de Y (em unidades de PDF) para considerar que dois
// fragmentos pertencem à mesma linha visual.
export const TOLERANCIA_LINHA_Y = 2.5

// Mínimo de caracteres "úteis" (sem espaços) para considerar que o PDF
// realmente possui camada de texto. Abaixo disso tratamos como digitalizado.
export const MIN_CARACTERES_TEXTO = 20

/**
 * Verifica se o item é um fragmento de texto utilizável.
 * Itens de marcação (TextMarkedContent) não possuem `str`.
 * @param {Object} item
 * @returns {boolean}
 */
export const ehItemTexto = (item) => Boolean(item) && typeof item.str === 'string'

/**
 * Extrai as coordenadas (x, y) da matriz de transformação do item.
 * @param {Object} item
 * @returns {{ x: number, y: number }}
 */
export const extrairGeometria = (item) => {
  const t = Array.isArray(item?.transform) ? item.transform : null
  const x = t && Number.isFinite(t[4]) ? t[4] : 0
  const y = t && Number.isFinite(t[5]) ? t[5] : 0
  return { x, y }
}

/**
 * Reconstrói as linhas de texto a partir dos itens do `getTextContent()`.
 * @param {Array<Object>} items - content.items de uma página
 * @param {number} [toleranciaY] - variação de Y aceita na mesma linha
 * @returns {string[]} Linhas de texto (sem linhas vazias)
 */
export const reconstruirLinhas = (items = [], toleranciaY = TOLERANCIA_LINHA_Y) => {
  if (!Array.isArray(items) || items.length === 0) return []

  const grupos = []
  let atual = null

  for (const item of items) {
    if (!ehItemTexto(item)) continue

    const texto = item.str
    // Item sem texto e sem fim de linha não contribui em nada.
    if (!texto && !item.hasEOL) continue

    const { x, y } = extrairGeometria(item)

    if (!atual || Math.abs(atual.y - y) > toleranciaY) {
      atual = { y, fragmentos: [] }
      grupos.push(atual)
    }

    if (texto) atual.fragmentos.push({ x, texto })

    // `hasEOL` marca o fim de linha conforme o próprio gerador do PDF.
    if (item.hasEOL) atual = null
  }

  return grupos
    .map((grupo) =>
      grupo.fragmentos
        .slice()
        .sort((a, b) => a.x - b.x)
        .map((f) => f.texto)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((linha) => linha.length > 0)
}

/**
 * Monta o texto final do documento a partir das páginas já reconstruídas.
 * @param {Array<Array<Object>>} paginasDeItens - array com os items de cada página
 * @returns {string} Texto completo, uma linha visual por linha
 */
export const reconstruirTextoDePaginas = (paginasDeItens = []) =>
  paginasDeItens
    .filter((items) => Array.isArray(items))
    .map((items) => reconstruirLinhas(items).join('\n'))
    .join('\n')

/**
 * Conta caracteres úteis (ignora espaços/quebras de linha).
 * @param {string} texto
 * @returns {number}
 */
export const contarCaracteresUteis = (texto) => String(texto ?? '').replace(/\s/g, '').length

/**
 * Detecta se o PDF possui camada de texto (não é digitalizado/imagem).
 * PDFs escaneados devolvem praticamente nada em `getTextContent()`.
 * @param {string} texto
 * @param {number} [minimo]
 * @returns {boolean}
 */
export const temCamadaDeTexto = (texto, minimo = MIN_CARACTERES_TEXTO) =>
  contarCaracteresUteis(texto) >= minimo
