/**
 * Оценка одного ответа агента по ожиданиям из eval/questions-softline.json.
 * Чистые функции — без базы и модели, чтобы их можно было проверить тестами.
 */

export type Kind = 'answer' | 'clarify' | 'proposal' | 'escalate'

export interface EvalItem {
  id: string
  channel: 'chat' | 'email'
  category?: string
  question?: string
  turns?: string[]
  expect: {
    kind: Kind
    skus_any?: string[]
    price_from_catalog?: boolean
    must_include?: string[]
    must_not_include?: string[]
    source_slug?: string | null
  }
  note?: string
}

export interface Observed {
  text: string
  escalated: boolean
  proposalSkus: string[] // позиции созданных КП
  sourceSlugs: string[] // документы базы знаний, на которые опирался ответ
  verifyOk: boolean
}

export interface Catalog { sku: string; name: string; price_cents: bigint }

export interface Score {
  pass: boolean
  got: Kind
  checks: Record<string, boolean>
  fails: string[]
}

/** Текст для сравнения: регистр, ё, пробелы и NBSP внутри чисел, «,00». */
export function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/(\d)[\s  ]+(?=\d)/g, '$1').replace(/,00\b/g, '')
}

/** Как цена может быть записана в ответе: «6 739,20 ₽», «6739.20», «6739,2», для круглых — «14 500». */
export function priceForms(cents: bigint): string[] {
  const r = (cents / 100n).toString()
  const k = (cents % 100n).toString().padStart(2, '0')
  if (k === '00') return [r]
  return [`${r},${k}`, `${r}.${k}`, ...(k.endsWith('0') ? [`${r},${k[0]}`] : [])]
}

export function hasPrice(text: string, cents: bigint): boolean {
  const t = norm(text)
  return priceForms(cents).some(f => new RegExp(`(^|[^\\d])${f.replace('.', '\\.')}($|[^\\d])`).test(t))
}

/** Что агент сделал: эскалация важнее КП, КП важнее вопроса, иначе — ответ. */
export function gotKind(o: Observed): Kind {
  if (o.escalated) return 'escalate'
  if (o.proposalSkus.length) return 'proposal'
  if (/\?\s*$|\?\s*\n/m.test(o.text.trim()) && !/\d[\d\s ]*,\d\d\s*₽/.test(o.text)) return 'clarify'
  return 'answer'
}

/** Значимые слова названия (для «назвал нужный товар» без цены): латиница и цифры моделей. */
function nameHit(text: string, name: string): boolean {
  const words = norm(name).match(/[a-z][a-z0-9+.-]{2,}/g) ?? []
  const t = norm(text)
  const key = words.slice(0, 3)
  return key.length > 0 && key.every(w => t.includes(w))
}

export function score(item: EvalItem, o: Observed, catalog: Catalog[]): Score {
  const e = item.expect
  const got = gotKind(o)
  const checks: Record<string, boolean> = {}
  // уточнить вместо ответа — допустимо там, где ждали ответ без цены; наоборот — нет
  checks.kind = got === e.kind || (e.kind === 'clarify' && got === 'answer' && /\?/.test(o.text))
  const t = norm(o.text)
  for (const s of e.must_include ?? []) checks[`есть «${s}»`] = t.includes(norm(s))
  for (const s of e.must_not_include ?? []) checks[`нет «${s}»`] = !t.includes(norm(s))
  const want = catalog.filter(c => (e.skus_any ?? []).includes(c.sku))
  if (want.length && e.kind !== 'clarify') {
    checks['нужный товар'] = want.some(c => o.proposalSkus.includes(c.sku) || hasPrice(o.text, c.price_cents) || nameHit(o.text, c.name))
  }
  if (e.price_from_catalog && want.length) checks['цена из каталога'] = want.some(c => hasPrice(o.text, c.price_cents)) || o.proposalSkus.some(s => want.some(c => c.sku === s))
  if (e.source_slug) checks[`источник ${e.source_slug}`] = o.sourceSlugs.includes(e.source_slug)
  checks['сверка чисел'] = o.verifyOk || o.escalated
  const fails = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
  return { pass: fails.length === 0, got, checks, fails }
}
