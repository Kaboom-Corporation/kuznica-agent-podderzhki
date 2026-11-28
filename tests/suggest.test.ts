import { describe, expect, it } from 'vitest'
import { suggestNext } from '../server/agent/suggest'

const base = { earlier: [], tools: [], drafts: [], sources: [], escalation: null }

describe('suggestNext: подсказки следующего вопроса', () => {
  it('после подбора товара — цена, реестр, сроки', () => {
    expect(suggestNext({ ...base, question: 'Есть Kaspersky Endpoint?', tools: ['check_stock'] }))
      .toEqual(['Сколько это будет стоить?', 'Это есть в реестре российского ПО?', 'Какие сроки поставки?'])
  })

  it('после расчёта цены — КП первым, вопрос про цену не повторяем', () => {
    const r = suggestNext({ ...base, question: 'Сколько стоит на 25 мест?', tools: ['check_stock', 'get_price'] })
    expect(r[0]).toBe('Оформите КП на эту позицию')
    expect(r).not.toContain('Сколько это будет стоить?')
    expect(r).toHaveLength(3)
  })

  it('после черновика КП — счёт; после счёта — оплата', () => {
    const kp = { kind: 'proposal' as const, id: '1', number: 'КП-101', total: '1 ₽' }
    expect(suggestNext({ ...base, question: 'Оформите КП', drafts: [kp] })[0]).toBe('Выставите счёт по этому КП')
    const inv = { kind: 'invoice' as const, id: '2', number: 'СЧ-102', total: '1 ₽' }
    expect(suggestNext({ ...base, question: 'Выставите счёт', drafts: [kp, inv] })[0]).toBe('Как оплатить по безналу?')
  })

  it('уже спрошенные темы из истории не предлагает', () => {
    const r = suggestNext({ ...base, question: 'а сроки поставки?', earlier: ['Есть ли скидки?'], tools: ['search_kb'] })
    expect(r).not.toContain('Какие сроки поставки?')
    expect(r).not.toContain('Какие сейчас есть скидки и акции?')
  })

  it('вопрос ушёл менеджеру — подсказок нет', () => {
    expect(suggestNext({ ...base, question: 'Хочу скидку 30%', escalation: { kind: 'needs_human', reason: 'x' } })).toEqual([])
  })
})
