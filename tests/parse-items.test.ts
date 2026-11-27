import { describe, expect, it } from 'vitest'
import { draftCustomer, parseItems } from '../server/agent/tools'

// КП-101 на стенде: «ИНН Петров И.» в PDF
describe('заказчик в КП', () => {
  it('имя в поле ИНН уходит в контакт', () => {
    expect(draftCustomer({ customer_company: 'ООО Ромашка', customer_inn: 'Петров И.' }))
      .toEqual({ company: 'ООО Ромашка', inn: '', contact: 'Петров И.', email: '' })
  })
  it('настоящий ИНН остаётся, мусор с цифрами отбрасывается', () => {
    expect(draftCustomer({ customer_inn: '7701 234567', customer_contact: 'Иван Петров' }).inn).toBe('7701234567')
    expect(draftCustomer({ customer_inn: '123' })).toMatchObject({ inn: '', contact: '' })
  })
})

// Локальные модели иногда передают массив аргументов строкой JSON — принимаем и так.
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
