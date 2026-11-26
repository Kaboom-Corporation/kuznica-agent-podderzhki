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
}

export function emptyFacts(today = new Date()): Facts {
  const f: Facts = { today, money: new Set(), percents: new Set(), dates: new Set(), numbers: new Set() }
  f.dates.add(iso(today))
  return f
}

export interface Mismatch { kind: 'сумма' | 'процент' | 'дата' | 'число' | 'действие'; value: string }
export interface Verdict { ok: boolean; checked: string[]; mismatches: Mismatch[] }

export function describe(m: Mismatch): string {
  if (m.kind === 'действие') return `в ответе сказано «${m.value}», но инструмент для этого не вызывался`
  return `${m.kind} «${m.value}» нет в данных магазина`
}

// Утверждения о сделанном в прошедшем времени: «подготовил КП», «счёт выставлен», «передал менеджеру».
// Будущее («подготовлю», «менеджер подготовит») не ловим — это обещание, а не ложный факт.
const DONE = String.raw`(?:подготовил[аи]?|подготовлен[аоы]?|сформировал[аи]?|сформирован[аоы]?|составил[аи]?|составлен[аоы]?|оформил[аи]?|оформлен[аоы]?|создал[аи]?|создан[аоы]?|выставил[аи]?|выставлен[аоы]?)`
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
}

/** Цифры, которые назвал сам клиент, тоже можно повторять («вы просили 50 лицензий»). */
export function absorbQuestion(facts: Facts, question: string): void {
  for (const m of question.matchAll(NUMBER_RE)) facts.numbers.add(String(Number(m[0])))
  for (const m of question.matchAll(MONEY_RE)) facts.money.add(moneyCents(m))
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

  for (const m of answer.matchAll(MONEY_RE)) {
    check('сумма', m[0].trim(), moneyKnown(facts, moneyCents(m), !!m[3]))
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
