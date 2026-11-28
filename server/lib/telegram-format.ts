/**
 * Ответ агента (Markdown) → HTML, который понимает Telegram, и резка на сообщения.
 * Чистые функции без Nuxt: их гоняют юнит-тесты.
 *
 * Telegram принимает узкий набор тегов: <b> <i> <s> <code> <pre> <a href> <blockquote>.
 * Всё остальное экранируется. Ответ модели — недоверенный текст: сырой HTML из него не проходит.
 * Таблицы Telegram не рисует: узкая — моноширинным блоком, широкая — списком «заголовок: значение».
 */
import type { Draft, Source } from '../agent/tools'

/** Предел Telegram на одно сообщение. */
export const TG_LIMIT = 4096
/** Шире этого таблица на телефоне в моноширинном блоке переносится строками — показываем её списком. */
const TABLE_MAX_WIDTH = 34

export function escapeTg(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Адрес ссылки: без пробелов, скобок, кавычек, `*` и обратных кавычек — разметка не попадает внутрь href.
const URL = 'https?:\\/\\/[^\\s()<>"\'`*\\[\\]\\u0000]+'
const LINK_RE = new RegExp(`\\[([^\\]\\n\\u0000]+)\\]\\((${URL})\\)|(${URL})`, 'g')
const PH_RE = /\u0000(\d+)\u0000/g

/** Строка Markdown (уже экранированная) → строка с тегами Telegram. */
function inline(s: string): string {
  const keep: string[] = []
  const ph = (html: string) => { keep.push(html); return `\u0000${keep.length - 1}\u0000` }
  let text = s
    // код первым: внутри него звёздочки и подчёркивания — не разметка
    .replace(/`([^`\n]+)`/g, (_m, code: string) => ph(`<code>${code}</code>`))
    .replace(LINK_RE, (_m, label: string | undefined, href: string | undefined, bare: string | undefined) => {
      // точка или запятая в конце голого адреса — конец предложения, а не часть ссылки
      if (bare !== undefined) {
        const tail = /[.,;:!?]+$/.exec(bare)?.[0] ?? ''
        const url = tail ? bare.slice(0, -tail.length) : bare
        return ph(`<a href="${url}">${url}</a>`) + tail
      }
      return ph(`<a href="${href}">${label}</a>`)
    })
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/(^|[\s(«])\*([^*\s][^*\n]*?)\*(?=$|[\s.,!?:;)»])/g, '$1<i>$2</i>')
    .replace(/(^|[\s(«])_([^_\s][^_\n]*?)_(?=$|[\s.,!?:;)»])/g, '$1<i>$2</i>')
  // заглушки могут быть вложены (код внутри подписи ссылки) — раскрываем, пока есть
  for (let i = 0; i < 3 && text.includes('\u0000'); i++) text = text.replace(PH_RE, (_m, n: string) => keep[Number(n)] ?? '')
  return text
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
}

const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
/** Ячейка без разметки: в моноширинном блоке звёздочки были бы видны как есть. */
const bare = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')

function table(lines: string[]): string {
  const rows = lines.filter(l => !isTableSep(l)).map(splitRow)
  if (!rows.length) return ''
  const cols = Math.max(...rows.map(r => r.length))
  const width = Array.from({ length: cols }, (_v, i) => Math.max(...rows.map(r => bare(r[i] ?? '').length)))
  const total = width.reduce((a, b) => a + b, 0) + (cols - 1) * 2
  if (total <= TABLE_MAX_WIDTH) {
    const text = rows.map(r => width.map((w, i) => bare(r[i] ?? '').padEnd(w)).join('  ').trimEnd()).join('\n')
    return `<pre>${escapeTg(text)}</pre>`
  }
  // широкая: строка таблицы → пункт списка, первая колонка жирным, остальные «заголовок: значение»
  const hasHead = lines.length > 1 && isTableSep(lines[1]!)
  const head = hasHead ? rows[0]! : null
  const body = hasHead ? rows.slice(1) : rows
  return body.map((r) => {
    const first = inline(escapeTg(r[0] ?? ''))
    const rest = r.slice(1).map((c, i) => {
      const h = head?.[i + 1]
      return h ? `${inline(escapeTg(h))}: ${inline(escapeTg(c))}` : inline(escapeTg(c))
    }).filter(Boolean)
    return `• <b>${first}</b>${rest.length ? ` — ${rest.join('; ')}` : ''}`
  }).join('\n')
}

/**
 * Markdown → блоки HTML Telegram (абзац, список, таблица, код). Блоки разделяются пустой строкой;
 * резать сообщение можно только между ними — так теги не рвутся.
 */
export function mdToTgBlocks(src: string): string[] {
  const lines = src.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n')
  const blocks: string[] = []
  let para: string[] = []
  let quote: string[] = []
  const flush = () => {
    if (para.length) blocks.push(para.join('\n'))
    if (quote.length) blocks.push(`<blockquote>${quote.join('\n')}</blockquote>`)
    para = []
    quote = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd()
    const fence = /^\s*```/.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!)
      if (code.length) blocks.push(`<pre>${escapeTg(code.join('\n'))}</pre>`)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush()
      const rows: string[] = []
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!.trimEnd()); i++) rows.push(lines[i]!.trimEnd())
      i--
      const t = table(rows)
      if (t) blocks.push(t)
      continue
    }
    if (!line.trim()) { flush(); continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); continue }
    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) {
      if (para.length) { blocks.push(para.join('\n')); para = [] }
      quote.push(inline(escapeTg(q[1]!)))
      continue
    }
    if (quote.length) { blocks.push(`<blockquote>${quote.join('\n')}</blockquote>`); quote = [] }
    const h = /^\s*#{1,6}\s+(.*?)\s*#*$/.exec(line)
    const ul = /^(\s*)[-*•+]\s+(.*)$/.exec(line)
    const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (h) {
      if (para.length) { blocks.push(para.join('\n')); para = [] }
      // заголовок уже жирный: вложенный <b> Telegram не любит
      para.push(`<b>${inline(escapeTg(h[1]!.replace(/\*\*/g, '')))}</b>`)
    }
    else if (ul) para.push(`${ul[1]!.length >= 2 ? '   ◦' : '•'} ${inline(escapeTg(ul[2]!))}`)
    else if (ol) para.push(`${ol[1]!.length >= 2 ? '   ' : ''}${ol[2]}. ${inline(escapeTg(ol[3]!))}`)
    else para.push(inline(escapeTg(line.trim())))
  }
  flush()
  return blocks.filter(b => b.trim())
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' }

/** HTML Telegram → обычный текст: на случай, если Telegram отклонил разметку. Адрес ссылки не теряется. */
export function tgHtmlToPlain(html: string): string {
  return html
    .replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (_m, href: string, text: string) => (text === href ? href : `${text} (${href})`))
    .replace(/<\/?(b|i|s|code|pre|blockquote)>/g, '')
    .replace(/&(amp|lt|gt|quot);/g, m => ENTITIES[m] ?? m)
}

/** Слишком длинный блок без разбора на строки: режем по пробелам, разметку снимаем — теги не рвутся. */
function hardSplit(html: string, limit: number): string[] {
  const out: string[] = []
  let rest = tgHtmlToPlain(html)
  while (rest.length) {
    // экранирование удлиняет текст: берём кусок с запасом и проверяем уже экранированный
    let size = Math.min(rest.length, limit)
    let piece = escapeTg(rest.slice(0, size))
    while (piece.length > limit) { size = Math.floor(size * 0.9); piece = escapeTg(rest.slice(0, size)) }
    if (size < rest.length) {
      const sp = rest.lastIndexOf(' ', size)
      if (sp > size / 2) { size = sp; piece = escapeTg(rest.slice(0, size)) }
    }
    out.push(piece)
    rest = rest.slice(size).trimStart()
  }
  return out
}

/** Блок длиннее предела: моноширинный и цитату режем по строкам с теми же тегами, абзац — по строкам. */
function splitBlock(block: string, limit: number): string[] {
  const wrap = /^<(pre|blockquote)>([\s\S]*)<\/\1>$/.exec(block)
  const [open, close, body] = wrap ? [`<${wrap[1]}>`, `</${wrap[1]}>`, wrap[2]!] : ['', '', block]
  const room = limit - open.length - close.length
  const parts: string[] = []
  let cur = ''
  for (const line of body.split('\n')) {
    if (line.length > room) {
      if (cur) { parts.push(open + cur + close); cur = '' }
      parts.push(...hardSplit(line, limit))
      continue
    }
    if (cur && cur.length + 1 + line.length > room) { parts.push(open + cur + close); cur = '' }
    cur = cur ? `${cur}\n${line}` : line
  }
  if (cur) parts.push(open + cur + close)
  return parts
}

/** Блоки → сообщения не длиннее предела. Режем по границам блоков, внутри блока — по строкам. */
export function packTg(blocks: string[], limit = TG_LIMIT): string[] {
  const msgs: string[] = []
  let cur = ''
  for (const b of blocks.flatMap(b => (b.length > limit ? splitBlock(b, limit) : [b]))) {
    if (cur && cur.length + 2 + b.length > limit) { msgs.push(cur); cur = '' }
    cur = cur ? `${cur}\n\n${b}` : b
  }
  if (cur) msgs.push(cur)
  return msgs
}

export function mdToTelegram(src: string, limit = TG_LIMIT): string[] {
  return packTg(mdToTgBlocks(src), limit)
}

/** Подпись под ответом: источники, черновики КП и счёта, передача менеджеру. */
export function replyFooter(r: { sources?: Source[]; drafts?: Draft[]; escalated?: boolean }): string[] {
  const out: string[] = []
  for (const d of r.drafts ?? []) {
    const what = d.kind === 'proposal' ? 'Коммерческое предложение' : 'Счёт'
    out.push(`📄 ${what} № ${escapeTg(d.number)} на ${escapeTg(d.total)} подготовлен${d.kind === 'proposal' ? 'о' : ''}. `
      + 'Сначала его проверит менеджер, после проверки документ придёт сюда.')
  }
  if (r.escalated) out.push('<i>Вопрос передан менеджеру — его ответ придёт в этот чат.</i>')
  const seen = new Set<string>()
  const src = (r.sources ?? []).filter(s => !s.expired && !seen.has(s.slug) && seen.add(s.slug))
  if (src.length) out.push(`<i>Источники: ${src.map(s => escapeTg(s.heading ? `${s.title} (${s.heading})` : s.title)).join(' · ')}</i>`)
  return out
}

/** Ответ агента целиком → сообщения Telegram. */
export function formatAgentReply(r: { text: string; sources?: Source[]; drafts?: Draft[]; escalated?: boolean }, limit = TG_LIMIT): string[] {
  return packTg([...mdToTgBlocks(r.text), ...replyFooter(r)], limit)
}
