import { describe, expect, it } from 'vitest'
import { gotKind, hasPrice, score, type EvalItem, type Observed } from '../scripts/eval-score'

const base: Observed = { text: '', escalated: false, proposalSkus: [], sourceSlugs: [], verifyOk: true }
const cat = [{ sku: 'SL-1', name: 'Kaspersky Small Office Security на 5 ПК', price_cents: 673920n }]

describe('eval-score', () => {
  it('цена в любом написании', () => {
    expect(hasPrice('стоит 6 739,20 ₽', 673920n)).toBe(true)
    expect(hasPrice('стоит 6739.20', 673920n)).toBe(true)
    expect(hasPrice('стоит 16 739,20 ₽', 673920n)).toBe(false)
    expect(hasPrice('итого 14 500,00 ₽', 1450000n)).toBe(true)
  })
  it('что сделал агент', () => {
    expect(gotKind({ ...base, text: 'Сколько у вас сотрудников?' })).toBe('clarify')
    expect(gotKind({ ...base, text: 'Astra Linux на 12 мес. — 3 100 ₽.\nСколько у вас рабочих мест?' })).toBe('answer')
    expect(gotKind({ ...base, text: 'Цена 6 739,20 ₽. Оформить КП?' })).toBe('answer')
    expect(gotKind({ ...base, escalated: true, proposalSkus: ['SL-1'] })).toBe('escalate')
  })
  it('вопрос о цене: товар, цена, запреты', () => {
    const item: EvalItem = { id: 's1', channel: 'chat', question: '?', expect: { kind: 'answer', skus_any: ['SL-1'], price_from_catalog: true, must_not_include: ['рабочих дней'] } }
    expect(score(item, { ...base, text: 'KSOS на 5 ПК — 6 739,20 ₽ за год.' }, cat).pass).toBe(true)
    const bad = score(item, { ...base, text: 'KSOS — 5 999 ₽, привезём за 3 рабочих дней' }, cat)
    expect(bad.fails).toEqual(expect.arrayContaining(['цена из каталога', 'нет «рабочих дней»']))
  })
  it('КП засчитывается по позициям черновика', () => {
    const item: EvalItem = { id: 's2', channel: 'chat', question: '?', expect: { kind: 'proposal', skus_any: ['SL-1'], price_from_catalog: true } }
    expect(score(item, { ...base, text: 'Черновик КП готов.', proposalSkus: ['SL-1'] }, cat).pass).toBe(true)
  })
})
