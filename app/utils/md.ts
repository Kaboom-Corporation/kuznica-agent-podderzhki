/**
 * Ответ агента → безопасный HTML. Сначала экранируем всё, потом разрешаем узкий набор разметки:
 * **жирный**, `код`, списки «- » и «1. », ссылки только http(s), абзацы и переносы.
 * Ответ модели — недоверенный текст: сырой HTML из него в страницу не попадает.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Адрес ссылки: без пробелов, скобок, кавычек, `*` и обратных кавычек — разметка не может попасть внутрь href.
const URL = 'https?:\\/\\/[^\\s()<>"\'`*\\[\\]\\u0000]+'
// Один проход: [текст](адрес) или голый адрес. Регулярки не бегают по уже собранному HTML.
const LINK_RE = new RegExp(`\\[([^\\]\\n\\u0000]+)\\]\\((${URL})\\)|(${URL})`, 'g')
const PH_RE = /\u0000(\d+)\u0000/g

function inline(s: string): string {
  const links: string[] = []
  const a = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
  // ссылки → заглушки \0N\0 (в исходном тексте \0 вырезан, подделать заглушку нельзя)
  const text = s.replace(LINK_RE, (_m, label: string | undefined, href: string | undefined, bare: string | undefined) => {
    links.push(label !== undefined ? a(href!, label) : a(bare!, bare!))
    return `\u0000${links.length - 1}\u0000`
  })
  return text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(PH_RE, (_m, i: string) => links[Number(i)] ?? '')
}

/** headings: «## » → настоящий заголовок (просмотр статьи БЗ); в чате заголовки — жирной строкой. */
export function renderMd(src: string, opts: { headings?: boolean } = {}): string {
  const lines = escapeHtml(src.replace(/\r\n?/g, '\n').replace(/\u0000/g, '')).split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let para: string[] = []
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = [] } }
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }
  for (const raw of lines) {
    const line = raw.trimEnd()
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const h = /^\s*(#{1,4})\s+(.*)$/.exec(line)
    if (ul || ol) {
      flushPara()
      const want = ul ? 'ul' : 'ol'
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want }
      out.push(`<li>${inline((ul ?? ol)![1]!)}</li>`)
    } else if (h) {
      flushPara(); closeList()
      if (opts.headings) {
        const n = Math.min(4, h[1]!.length + 1)
        out.push(`<h${n}>${inline(h[2]!)}</h${n}>`)
      }
      else out.push(`<p><strong>${inline(h[2]!)}</strong></p>`)
    } else if (!line.trim()) {
      flushPara(); closeList()
    } else {
      closeList()
      para.push(line)
    }
  }
  flushPara(); closeList()
  return out.join('')
}

/** «123456» копеек → «1 234,56 ₽». */
export function rub(cents: string | number | null | undefined): string {
  const n = Number(cents ?? 0) / 100
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽'
}

const FORMS: Record<string, [string, string, string]> = { лицензия: ['лицензия', 'лицензии', 'лицензий'] }
/** «50 лицензия» → «50 лицензий»; «шт.» и незнакомые единицы — как есть. */
export function qtyUnit(qty: number, unit: string): string {
  const f = FORMS[unit]
  if (!f) return `${qty} ${unit}`
  const n10 = qty % 10, n100 = qty % 100
  const form = n10 === 1 && n100 !== 11 ? f[0] : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? f[1] : f[2]
  return `${qty} ${form}`
}
