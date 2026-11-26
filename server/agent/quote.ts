/**
 * Расчёт цены — только кодом. Модель сумм не считает: она получает готовые цифры
 * из get_price / draft_proposal, а verify.ts потом сверяет, что она их не переврала.
 * Деньги в копейках (bigint), проценты целые.
 */

export type Condition = 'renewal' | 'partner' | 'gov' | 'edu'
export const CONDITIONS: Condition[] = ['renewal', 'partner', 'gov', 'edu']

export interface CatalogItem {
  sku: string
  name: string
  vendor: string
  category: string
  unit: string
  term_months: number | null
  price_cents: bigint
  stock: number
  lead_days: number | null
  url?: string | null
  in_registry: boolean
  description: string
}

export interface PriceRule {
  code: string
  title: string
  applies_to: string
  min_qty: number
  discount_pct: number
  requires: Condition | null
  stackable: boolean
  note: string
}

export interface QuoteLine {
  sku: string
  name: string
  unit: string
  qty: number
  unit_cents: bigint
  gross_cents: bigint
  discount_pct: number
  rules: string[]
  discount_cents: bigint
  sum_cents: bigint
}

export interface Quote {
  lines: QuoteLine[]
  subtotal_cents: bigint
  discount_cents: bigint
  total_cents: bigint
  vat_cents: bigint
  vat_percent: number
  /** правила, которые подошли бы, если клиент подтвердит условие */
  possible: { code: string; title: string; requires: Condition; discount_pct: number; sku: string }[]
}

/** Потолок суммарной скидки на строку, чтобы сложение правил не ушло в ноль. */
export const MAX_DISCOUNT_PCT = 40

export function ruleMatches(rule: PriceRule, item: CatalogItem): boolean {
  const a = rule.applies_to.trim()
  if (a === '*') return true
  const [kind, ...rest] = a.split(':')
  const value = rest.join(':').trim().toLowerCase()
  if (kind === 'category') return item.category.toLowerCase() === value
  if (kind === 'vendor') return item.vendor.toLowerCase() === value
  if (kind === 'sku') return item.sku.toLowerCase() === value
  return false
}

/** Скидка на строку: лучшее несуммируемое правило + все суммируемые, не выше потолка. */
export function lineDiscount(item: CatalogItem, qty: number, rules: PriceRule[], conditions: Set<Condition>) {
  const fit = rules.filter(r => ruleMatches(r, item) && qty >= r.min_qty && r.discount_pct > 0)
  const active = fit.filter(r => !r.requires || conditions.has(r.requires))
  const possible = fit.filter(r => r.requires && !conditions.has(r.requires))
  const single = active.filter(r => !r.stackable).sort((a, b) => b.discount_pct - a.discount_pct)[0]
  const stack = active.filter(r => r.stackable)
  const applied = [...(single ? [single] : []), ...stack]
  const pct = Math.min(MAX_DISCOUNT_PCT, applied.reduce((s, r) => s + r.discount_pct, 0))
  return { pct, applied, possible }
}

/** Процент от суммы в копейках с округлением половины вверх. */
export function pctOf(cents: bigint, pct: number): bigint {
  return (cents * BigInt(pct) + 50n) / 100n
}

/** Цены каталога — с НДС. Выделяем НДС из итога: total * p / (100 + p). */
export function vatInside(totalCents: bigint, vatPercent: number): bigint {
  if (vatPercent <= 0) return 0n
  const p = BigInt(vatPercent)
  return (totalCents * p * 2n + (100n + p)) / ((100n + p) * 2n)
}

export function buildQuote(
  wanted: { item: CatalogItem; qty: number }[],
  rules: PriceRule[],
  conditions: Set<Condition>,
  vatPercent: number,
): Quote {
  const lines: QuoteLine[] = []
  const possible: Quote['possible'] = []
  for (const { item, qty } of wanted) {
    const gross = item.price_cents * BigInt(qty)
    const d = lineDiscount(item, qty, rules, conditions)
    const discount = pctOf(gross, d.pct)
    lines.push({
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      qty,
      unit_cents: item.price_cents,
      gross_cents: gross,
      discount_pct: d.pct,
      rules: d.applied.map(r => r.code),
      discount_cents: discount,
      sum_cents: gross - discount,
    })
    for (const r of d.possible) {
      possible.push({ code: r.code, title: r.title, requires: r.requires!, discount_pct: r.discount_pct, sku: item.sku })
    }
  }
  const subtotal = lines.reduce((s, l) => s + l.gross_cents, 0n)
  const discount = lines.reduce((s, l) => s + l.discount_cents, 0n)
  const total = subtotal - discount
  return {
    lines,
    subtotal_cents: subtotal,
    discount_cents: discount,
    total_cents: total,
    vat_cents: vatInside(total, vatPercent),
    vat_percent: vatPercent,
    possible,
  }
}

/** «12 345,60 ₽» — так цифры видит модель и так их ищет verify.ts. */
export function rub(cents: bigint): string {
  const neg = cents < 0n
  const abs = neg ? -cents : cents
  const r = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  const k = (abs % 100n).toString().padStart(2, '0')
  return `${neg ? '−' : ''}${r},${k} ₽`
}

/** Квота в вид для модели: суммы строками в рублях, без bigint. */
export function quoteForModel(qt: Quote) {
  return {
    lines: qt.lines.map(l => ({
      sku: l.sku,
      name: l.name,
      qty: l.qty,
      unit: l.unit,
      price: rub(l.unit_cents),
      gross: rub(l.gross_cents),
      discount_pct: l.discount_pct,
      rules: l.rules,
      discount: rub(l.discount_cents),
      sum: rub(l.sum_cents),
    })),
    subtotal: rub(qt.subtotal_cents),
    discount: rub(qt.discount_cents),
    total: rub(qt.total_cents),
    vat: `${rub(qt.vat_cents)} (НДС ${qt.vat_percent}% в том числе)`,
    possible_if_confirmed: qt.possible.map(p => ({ ...p, hint: conditionHint(p.requires) })),
  }
}

export function conditionHint(c: Condition): string {
  return {
    renewal: 'скидка за продление — спросите номер действующей лицензии',
    partner: 'партнёрская скидка — только для зарегистрированных партнёров, подтверждает менеджер',
    gov: 'условия для госзаказчика — нужен ИНН организации и закон (44-ФЗ/223-ФЗ)',
    edu: 'скидка для образования — нужна лицензия на образовательную деятельность',
  }[c]
}
