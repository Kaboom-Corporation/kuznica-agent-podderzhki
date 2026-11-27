/**
 * Ответ агента → безопасный HTML. Сначала экранируем всё, потом разрешаем узкий набор разметки:
 * **жирный**, `код`, списки «- » и «1. », ссылки только http(s), абзацы и переносы.
 * Ответ модели — недоверенный текст: сырой HTML из него в страницу не попадает.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function inline(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)"]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
}

export function renderMd(src: string): string {
  const lines = escapeHtml(src.replace(/\r\n?/g, '\n')).split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let para: string[] = []
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = [] } }
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }
  for (const raw of lines) {
    const line = raw.trimEnd()
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const h = /^\s*#{1,4}\s+(.*)$/.exec(line)
    if (ul || ol) {
      flushPara()
      const want = ul ? 'ul' : 'ol'
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want }
      out.push(`<li>${inline((ul ?? ol)![1]!)}</li>`)
    } else if (h) {
      flushPara(); closeList()
      out.push(`<p><strong>${inline(h[1]!)}</strong></p>`)
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
