import { describe, expect, it } from 'vitest'
import { debrand } from '../scripts/debrand'

describe('база знаний под «Демо Софт»', () => {
  it('название, падежи и домены', () => {
    expect(debrand('Оплата заказа в Softline')).toBe('Оплата заказа в Демо Софт')
    expect(debrand('Менеджер Софтлайна свяжется, счёт выставит Софтлайн')).toBe('Менеджер Демо Софта свяжется, счёт выставит Демо Софт')
    expect(debrand('ГК Softline поставляет ПО')).toBe('Демо Софт поставляет ПО')
    expect(debrand('Пишите на info@softline.ru или заходите на store.softline.ru/kaspersky/')).toBe('Пишите на info@demo-soft.example или заходите на demo-soft.example/kaspersky/')
  })
  it('в заголовке домен становится названием', () => {
    expect(debrand('Оплата и доставка в Softline.ru', { title: true })).toBe('Оплата и доставка в Демо Софт')
  })
  it('без названия — текст как был', () => {
    const s = 'Kaspersky Endpoint Security для бизнеса — 197 010 ₽ за 50 узлов'
    expect(debrand(s)).toBe(s)
  })
})
