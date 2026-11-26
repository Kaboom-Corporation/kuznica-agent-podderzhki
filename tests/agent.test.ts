import { describe, expect, it } from 'vitest'
import { buildQuote, rub, vatInside, type CatalogItem, type PriceRule } from '../server/agent/quote'
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
  })
})
