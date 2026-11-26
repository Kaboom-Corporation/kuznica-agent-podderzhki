/**
 * verify_answer — сверка ответа модели с фактами, которые она получила из инструментов.
 * Схема переписана с нашего parent-assistant (verifier.py): каждое проверяемое значение
 * в ответе — сумма, процент, дата, количество, любое другое число — должно найтись среди
 * фактов хода. Не нашлось хоть одно — ответ клиенту не уходит, обращение идёт менеджеру
 * с черновиком и списком расхождений.
 */

const MONTHS: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
}

const SP = '[\\s\\u00a0\\u202f]'
const MONEY_RE = new RegExp(`(?<![\\d.,])(\\d{1,3}(?:${SP}\\d{3})+|\\d+)(?:[,.](\\d{1,2}))?${SP}*(тыс\\.?${SP}*)?(?:₽|руб)`, 'gi')
const PCT_RE = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*%/g
const DATE_WORD_RE = new RegExp(`(?<!\\d)(\\d{1,2})${SP}+(${Object.keys(MONTHS).join('|')})(?:${SP}+(\\d{4}))?`, 'gi')
const DATE_NUM_RE = /(?<!\d)(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?![\d,])/g
const DATE_ISO_RE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g
const NUMBER_RE = /(?<![\d\p{L}])\d+(?![\d\p{L}])/gu

export interface Facts {
  today: Date
  /** суммы, которые видела модель, в копейках */
  money: Set<bigint>
  /** проценты скидок/НДС */
  percents: Set<number>
  /** даты в ISO (YYYY-MM-DD) */
  dates: Set<string>
  /** прочие числа из фактов и из вопроса клиента: количества, сроки, артикулы */
  numbers: Set<string>
  /** что модель видела в каталоге: артикул и начало названия → есть ли отметка «в реестре» */
  registry: Array<{ sku: string; title: string; inRegistry: boolean }>
}

export function emptyFacts(today = new Date()): Facts {
  const f: Facts = { today, money: new Set(), percents: new Set(), dates: new Set(), numbers: new Set(), registry: [] }
  f.dates.add(iso(today))
  return f
}

export interface Mismatch { kind: 'сумма' | 'процент' | 'дата' | 'число' | 'действие' | 'реестр'; value: string }
export interface Verdict { ok: boolean; checked: string[]; mismatches: Mismatch[] }

export function describe(m: Mismatch): string {
  if (m.kind === 'действие') return `в ответе сказано «${m.value}», но инструмент для этого не вызывался`
  if (m.kind === 'реестр') return `«${m.value}» назван «в реестре», но в каталоге у него отметки «в реестре российского ПО» нет — не пиши про реестр для этой позиции`
  return `${m.kind} «${m.value}» нет в данных магазина`
}

// Утверждения о сделанном в прошедшем времени: «подготовил КП», «счёт выставлен», «передал менеджеру».
// Будущее («подготовлю», «менеджер подготовит») не ловим — это обещание, а не ложный факт.
// Границы слова обязательны: без них «оформления заказа … счёт» читалось как «оформлен счёт».
const DONE = String.raw`(?<!\p{L})(?:подготовил[аи]?|подготовлен[аоы]?|сформировал[аи]?|сформирован[аоы]?|составил[аи]?|составлен[аоы]?|оформил[аи]?|оформлен[аоы]?|создал[аи]?|создан[аоы]?|выставил[аи]?|выставлен[аоы]?)(?!\p{L})`
const CLAIMS: Array<{ act: 'proposal' | 'invoice' | 'handoff'; re: RegExp }> = [
  { act: 'proposal', re: new RegExp(String.raw`${DONE}[^.!?\n]{0,30}?(?:КП|коммерческ\p{L}* предложени\p{L}*)|(?:КП|коммерческ\p{L}* предложени\p{L}*)[^.!?\n]{0,30}?${DONE}`, 'iu') },
  { act: 'invoice', re: new RegExp(String.raw`${DONE}[^.!?\n]{0,30}?сч[её]т(?!\p{L})|сч[её]т(?!\p{L})[^.!?\n]{0,30}?${DONE}`, 'iu') },
  { act: 'handoff', re: /(?:передал[аи]?|передан[аоы]?|переда[ёе]тся)[^.!?\n]{0,30}?менеджер/iu },
]

/** Ответ утверждает, что действие сделано, а инструмент не вызывался. */
export function checkActions(answer: string, done: { proposal: boolean; invoice: boolean; handoff: boolean }): Mismatch[] {
  const out: Mismatch[] = []
  for (const c of CLAIMS) {
    const m = c.re.exec(answer)
    if (m && !done[c.act]) out.push({ kind: 'действие', value: m[0].trim() })
  }
  return out
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Дата без года — ближайшая к сегодняшней. */
function resolveDate(day: number, month: number, year: number | null, today: Date): string | null {
  const make = (y: number) => {
    const d = new Date(y, month - 1, day)
    return d.getMonth() === month - 1 && d.getDate() === day ? d : null
  }
  if (year) {
    const d = make(year)
    return d ? iso(d) : null
  }
  const cands = [-1, 0, 1].map(k => make(today.getFullYear() + k)).filter((d): d is Date => !!d)
  if (!cands.length) return null
  cands.sort((a, b) => Math.abs(a.getTime() - today.getTime()) - Math.abs(b.getTime() - today.getTime()))
  return iso(cands[0]!)
}

const digits = (s: string) => s.replace(/\D/g, '')

/**
 * Собрать факты из результата инструмента: суммы «12 345,60 ₽», поля *_cents, проценты,
 * даты ISO, остальные числа. Работает по JSON-тексту, чтобы не зависеть от формы ответа.
 */
export function absorb(facts: Facts, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v)
  for (const m of text.matchAll(MONEY_RE)) facts.money.add(moneyCents(m))
  for (const m of text.matchAll(/"(\w*_cents)"\s*:\s*"?(-?\d+)"?/g)) facts.money.add(BigInt(m[2]!))
  for (const m of text.matchAll(/"discount_pct"\s*:\s*(\d+)/g)) facts.percents.add(Number(m[1]))
  for (const m of text.matchAll(PCT_RE)) facts.percents.add(Number(m[1]!.replace(',', '.')))
  for (const m of text.matchAll(DATE_ISO_RE)) facts.dates.add(`${m[1]}-${m[2]}-${m[3]}`)
  for (const m of text.matchAll(NUMBER_RE)) facts.numbers.add(String(Number(m[0])))
  const items = (value as { items?: unknown })?.items
  if (Array.isArray(items)) {
    for (const it of items as Array<{ sku?: unknown; name?: unknown; in_registry?: unknown }>) {
      if (typeof it?.sku !== 'string' || typeof it.name !== 'string' || typeof it.in_registry !== 'string') continue
      // «РЕД СОФТ РЕД ОС, Простая лицензия…» → «ред софт ред ос»: так модель обычно называет продукт
      const title = it.name.split(/[,(«]/)[0]!.trim().toLowerCase()
      facts.registry.push({ sku: it.sku, title, inRegistry: !it.in_registry.startsWith('нет') })
    }
  }
}

/**
 * «В реестре» можно писать только про позиции с этой отметкой в каталоге. Проверяем по абзацам:
 * в абзаце, где сказано «в реестре» (без «нет/не»), не должно быть артикула или названия позиции без отметки.
 */
export function checkRegistry(answer: string, facts: Facts): Mismatch[] {
  const out: Mismatch[] = []
  for (const block of answer.split(/\n\s*\n/)) {
    // оговорка «наличие в реестре уточнит менеджер» — не утверждение, что позиция в реестре
    const b = block.toLowerCase()
      .replace(/(налич\p{L}*|есть\s+ли|входит\s+ли)\s+в\s+реестр\p{L}*(\s+[\p{L}«»]+){0,3}?\s+уточн\p{L}*/gu, ' ')
      .replace(/уточн\p{L}*([\s,]+\p{L}+){0,3}?[\s,]+(налич\p{L}*|есть\s+ли|входит\s+ли)\s+в\s+реестр\p{L}*/gu, ' ')
    if (!/(?<!(нет|не)\s)в\s+реестр/.test(b)) continue
    for (const r of facts.registry) {
      if (r.inRegistry) continue
      const hit = b.includes(r.sku.toLowerCase()) || (r.title.length >= 6 && b.includes(r.title))
      // то же название может быть и у позиции с отметкой — тогда по названию не ругаемся
      const twin = facts.registry.some(o => o.inRegistry && o.title === r.title && !b.includes(r.sku.toLowerCase()))
      if (hit && !twin && !out.some(m => m.value === r.title || m.value === r.sku)) out.push({ kind: 'реестр', value: b.includes(r.sku.toLowerCase()) ? r.sku : r.title })
    }
  }
  return out
}

/** Цифры, которые назвал сам клиент, тоже можно повторять («вы просили 50 лицензий»). */
export function absorbQuestion(facts: Facts, question: string): void {
  for (const m of question.matchAll(NUMBER_RE)) facts.numbers.add(String(Number(m[0])))
  for (const m of question.matchAll(MONEY_RE)) facts.money.add(moneyCents(m))
  // бюджет без знака рубля: «до 400 тысяч», «400к», «1,5 млн» — модель повторит его как «400 тыс. ₽»
  for (const m of question.matchAll(/(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(тыс\p{L}*|т\.р|к(?!\p{L})|млн|миллион\p{L}*)/giu)) {
    const n = Number(m[1]!.replace(',', '.'))
    const mult = /^(млн|миллион)/i.test(m[2]!) ? 1_000_000 : 1000
    facts.money.add(BigInt(Math.round(n * mult * 100)))
  }
}

function moneyCents(m: RegExpMatchArray): bigint {
  const whole = BigInt(digits(m[1]!))
  const frac = m[2] ? BigInt(m[2].padEnd(2, '0')) : 0n
  const thousands = !!m[3]
  return thousands ? whole * 100_000n + frac * 1000n : whole * 100n + frac
}

/**
 * Сумма без копеек в ответе («12 345 ₽») совпадает с фактом, только если в факте копеек нет:
 * округлять цены модели нельзя. Исключение — «12 тыс. ₽»: округление до тысячи известной суммы.
 */
function moneyKnown(facts: Facts, cents: bigint, thousands: boolean): boolean {
  if (facts.money.has(cents)) return true
  if (thousands) {
    for (const f of facts.money) if (f >= cents - 50_000n && f < cents + 50_000n) return true
  }
  return false
}

export function verifyAnswer(answer: string, facts: Facts): Verdict {
  const v: Verdict = { ok: true, checked: [], mismatches: [] }
  // нумерация списков «3. …», номера законов «44-ФЗ» и время «09:00–18:00» из базы — не цифры сделки
  let rest = answer
    .replace(/^[ \t]*\d+[.)][ \t]/gm, ' ')
    .replace(/\d+[-‑–]ФЗ/g, ' ')
    // метки персональных данных «Почта_1», «Телефон_2» и номера документов «КП-104», «СЧ-105»
    .replace(/\p{L}+_\d+/gu, ' ')
  const consume = (s: string) => { rest = rest.replace(s, ' ') }
  const check = (kind: Mismatch['kind'], value: string, ok: boolean) => {
    v.checked.push(`${kind}: ${value}`)
    if (!ok) { v.ok = false; v.mismatches.push({ kind, value }) }
  }

  // Итог комплекта («Dr.Web + защита почты = 142 648,40 ₽») — точная сумма 2–3 цен из каталога,
  // названных в этом же ответе. Неизвестная цена в слагаемых так не пройдёт: она сама не сверится.
  const money = [...answer.matchAll(MONEY_RE)].map(m => ({ m, cents: moneyCents(m), known: moneyKnown(facts, moneyCents(m), !!m[3]) }))
  const quoted = [...new Set(money.filter(x => x.known && !x.m[3]).map(x => x.cents))]
  const isTotal = (cents: bigint) => quoted.some((a, i) => quoted.some((b, j) => j > i
    && (a + b === cents || quoted.some((c, k) => k > j && a + b + c === cents))))
  for (const { m, cents, known } of money) {
    check('сумма', m[0].trim(), known || (!m[3] && isTotal(cents)))
    consume(m[0])
  }
  for (const m of [...rest.matchAll(PCT_RE)]) {
    const n = Number(m[1]!.replace(',', '.'))
    check('процент', m[0].trim(), facts.percents.has(n))
    consume(m[0])
  }
  for (const m of [...rest.matchAll(DATE_ISO_RE)]) {
    check('дата', m[0], facts.dates.has(m[0]))
    consume(m[0])
  }
  for (const m of [...rest.matchAll(DATE_WORD_RE)]) {
    const d = resolveDate(Number(m[1]), MONTHS[m[2]!.toLowerCase()]!, m[3] ? Number(m[3]) : null, facts.today)
    check('дата', m[0], !!d && facts.dates.has(d))
    consume(m[0])
  }
  for (const m of [...rest.matchAll(DATE_NUM_RE)]) {
    const d = resolveDate(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null, facts.today)
    check('дата', m[0], !!d && facts.dates.has(d))
    consume(m[0])
  }
  for (const m of [...rest.matchAll(NUMBER_RE)]) {
    const n = String(Number(m[0]))
    // 1–2 — «один из», «2 варианта», нумерация пунктов: не факт, не проверяем
    if (Number(n) <= 2) continue
    check('число', m[0], facts.numbers.has(n))
  }
  return v
}
