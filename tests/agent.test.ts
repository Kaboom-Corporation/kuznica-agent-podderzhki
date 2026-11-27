import { describe, expect, it } from 'vitest'
import { buildQuote, GOODWILL_RULE, rub, vatInside, type CatalogItem, type PriceRule } from '../server/agent/quote'
import { absorb, absorbQuestion, checkActions, emptyFacts, verifyAnswer } from '../server/agent/verify'

const item = (sku: string, price: bigint, extra: Partial<CatalogItem> = {}): CatalogItem => ({
  sku, name: sku, vendor: 'Вендор', category: 'antivirus', unit: 'лицензия', term_months: 12,
  price_cents: price, stock: -1, lead_days: 0, in_registry: true, description: '', ...extra,
})
const rule = (code: string, pct: number, extra: Partial<PriceRule> = {}): PriceRule => ({
  code, title: code, applies_to: '*', min_qty: 1, discount_pct: pct, requires: null, stackable: false, note: '', ...extra,
})

describe('quote', () => {
  it('берёт лучшее несуммируемое правило и прибавляет суммируемые', () => {
    const rules = [rule('vol10', 5, { min_qty: 10 }), rule('vol50', 10, { min_qty: 50 }), rule('edu', 15, { requires: 'edu', stackable: true })]
    const q = buildQuote([{ item: item('AV-1', 150000n), qty: 50 }], rules, new Set(['edu']), 22)
    expect(q.lines[0]!.discount_pct).toBe(25)
    expect(q.lines[0]!.rules).toEqual(['vol50', 'edu'])
    expect(q.subtotal_cents).toBe(7_500_000n)
    expect(q.total_cents).toBe(5_625_000n)
  })
  it('условие без подтверждения не применяется, но подсказывается', () => {
    const q = buildQuote([{ item: item('AV-1', 100000n), qty: 1 }], [rule('gov', 7, { requires: 'gov' })], new Set(), 22)
    expect(q.lines[0]!.discount_pct).toBe(0)
    expect(q.possible.map(p => p.code)).toEqual(['gov'])
  })
  // заказчик, чат 27.11: до 5% агент даёт сам по просьбе клиента, без купона
  it('скидка 5% по просьбе: только с asked_discount, не суммируется, не подсказывается', () => {
    const vol = rule('vol10', 3, { min_qty: 10 })
    const asked = buildQuote([{ item: item('AV-1', 100000n), qty: 10 }], [vol, GOODWILL_RULE], new Set(['asked_discount']), 22)
    expect(asked.lines[0]!.discount_pct).toBe(5)
    expect(asked.lines[0]!.rules).toEqual(['GOODWILL5'])
    const silent = buildQuote([{ item: item('AV-1', 100000n), qty: 10 }], [vol, GOODWILL_RULE], new Set(), 22)
    expect(silent.lines[0]!.discount_pct).toBe(3)
    expect(silent.possible).toEqual([])
    const bigger = buildQuote([{ item: item('AV-1', 100000n), qty: 50 }], [rule('vol50', 10, { min_qty: 50 }), GOODWILL_RULE], new Set(['asked_discount']), 22)
    expect(bigger.lines[0]!.discount_pct).toBe(10)
  })
  it('НДС внутри цены и формат рублей', () => {
    expect(vatInside(12_200n, 22)).toBe(2_200n)
    expect(rub(1_234_560n)).toBe('12 345,60 ₽')
  })
})

describe('verify', () => {
  const today = new Date(2026, 10, 26)
  it('бюджет клиента без знака рубля можно повторить', () => {
    const f = emptyFacts(today)
    absorbQuestion(f, 'бюджет примерно до 400 тысяч, максимум 1,5 млн')
    expect(verifyAnswer('С вашим бюджетом до 400 тыс. руб. (а лучше не больше 1 500 000 ₽) подойдёт…', f).ok).toBe(true)
    expect(verifyAnswer('Выйдет 450 тыс. ₽.', f).ok).toBe(false)
  })
  it('версия из названия товара — не дата; выдуманная версия не проходит', () => {
    const f = emptyFacts(today)
    absorb(f, { items: [{ sku: 'SL-517991', name: 'Astra Linux Special Edition 1.8 «Орел» для рабочей станции', price: '3 100,00 ₽' }] })
    expect(verifyAnswer('Astra Linux Special Edition 1.8 «Орел» (SL-517991) — 3 100,00 ₽.', f).ok).toBe(true)
    const bad = verifyAnswer('Astra Linux Special Edition 1.9 — 3 100,00 ₽.', f)
    expect(bad.ok).toBe(false)
    expect(bad.mismatches).toEqual([{ kind: 'дата', value: '1.9' }])
  })
  it('итог комплекта — сумма названных цен из каталога, не больше', () => {
    const f = emptyFacts(today)
    absorb(f, { items: [{ price: '80 818,40 ₽' }, { price: '61 830,00 ₽' }, { price: '135 765,00 ₽' }] })
    expect(verifyAnswer('Dr.Web 80 818,40 ₽ + почта 61 830,00 ₽ = 142 648,40 ₽.', f).ok).toBe(true)
    expect(verifyAnswer('Всё вместе 80 818,40 ₽ + 61 830,00 ₽ + 135 765,00 ₽ = 278 413,40 ₽.', f).ok).toBe(true)
    // слагаемое не названо в ответе — итог не принимаем
    expect(verifyAnswer('Комплект — 142 648,40 ₽.', f).ok).toBe(false)
    expect(verifyAnswer('Dr.Web 80 818,40 ₽ + почта 61 830,00 ₽ = 142 650,00 ₽.', f).ok).toBe(false)
  })
  it('пропускает цифры из инструментов и ловит выдуманные', () => {
    const f = emptyFacts(today)
    absorb(f, { total: '56 250,00 ₽', discount_pct: 25, lead_days: 10, valid_until: '2026-12-10' })
    absorbQuestion(f, 'нужно 50 лицензий')
    expect(verifyAnswer('Итог 56 250 ₽ со скидкой 25%, 50 лицензий, КП действует до 10 декабря.', f).ok).toBe(true)
    const bad = verifyAnswer('Итог 55 000 ₽, скидка 30%, поставка за 7 дней.', f)
    expect(bad.ok).toBe(false)
    expect(bad.mismatches.map(m => m.kind)).toEqual(['сумма', 'процент', 'число'])
  })
  it('не путает нумерацию, законы и метки ПДн с цифрами', () => {
    const f = emptyFacts(today)
    expect(verifyAnswer('3. Для закупки по 44-ФЗ напишем на Почта_3.', f).ok).toBe(true)
  })
  it('ловит «подготовил КП» без вызова инструмента', () => {
    const none = { proposal: false, invoice: false, handoff: false }
    expect(checkActions('Подготовил черновик КП. Менеджер проверит и отправит вам.', none).map(m => m.kind)).toEqual(['действие'])
    expect(checkActions('Счёт выставлен, оплатите до пятницы.', none)).toHaveLength(1)
    expect(checkActions('Я передал ваш вопрос менеджеру.', none)).toHaveLength(1)
    // обещания и вопросы — не ложный факт
    expect(checkActions('Подготовлю КП, как только уточните количество. Нужен ли счёт?', none)).toHaveLength(0)
    expect(checkActions('Подготовил черновик КП КП-104.', { ...none, proposal: true })).toHaveLength(0)
    // «оформления», «созданию» — другое слово, не «оформлен» / «создан»
    expect(checkActions('После оформления заказа вам будет выслан счет на оплату.', none)).toHaveLength(0)
    expect(checkActions('Для создания КП уточните количество.', none)).toHaveLength(0)
  })
})
