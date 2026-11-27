import { describe, expect, it } from 'vitest'
import { parseItems } from '../server/agent/tools'

// Стенд 27.11: draft_proposal ×5 с ошибкой — qwen передавал items строкой JSON, а не массивом.
describe('позиции из аргументов модели', () => {
  it('массив как есть', () => {
    expect(parseItems([{ sku: 'SL-5320', qty: 1 }])).toEqual([{ sku: 'SL-5320', qty: 1 }])
  })
  it('массив строкой JSON', () => {
    expect(parseItems('[{"sku":"SL-3853","qty":"50"}]')).toEqual([{ sku: 'SL-3853', qty: 50 }])
  })
  it('мусор — пусто', () => {
    expect(parseItems('SL-3853 50 шт')).toEqual([])
    expect(parseItems(null)).toEqual([])
  })
})
