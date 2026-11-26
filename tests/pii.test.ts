import { describe, expect, it } from 'vitest'
import { maskPii } from '../server/ported/ai/pii/mask'

describe('maskPii', () => {
  it('прячет телефон и почту и возвращает обратно', () => {
    const src = 'Звоните +7 (900) 123-45-67 или пишите ivan.petrov@example.ru'
    const r = maskPii(src)
    expect(r.masked).not.toContain('123-45-67')
    expect(r.masked).not.toContain('example.ru')
    expect(r.masked).toMatch(/Телефон_1/)
    expect(r.masked).toMatch(/Почта_1/)
    expect(r.found).toBe(2)
    expect(r.restore(r.masked)).toBe(src)
  })

  it('один номер в разной записи — одна метка', () => {
    const r = maskPii('Тел 8 900 123 45 67, позже +79001234567')
    expect(r.masked.match(/Телефон_1/g)?.length).toBe(2)
    expect(r.masked).not.toMatch(/Телефон_2/)
  })

  it('прячет ФИО с инициалами и СНИЛС, ИНН физлица', () => {
    const src = 'Ответчик Иванов Иван Иванович, СНИЛС 112-233-445 95, ИНН 500100732259.'
    const r = maskPii(src)
    expect(r.masked).not.toContain('Иванов')
    expect(r.masked).not.toContain('112-233-445 95')
    expect(r.masked).not.toContain('500100732259')
    expect(r.restore(r.masked)).toBe(src)
  })

  it('номер банковской карты по Luhn', () => {
    const r = maskPii('Карта 4111 1111 1111 1111 для возврата')
    expect(r.masked).not.toContain('4111')
    expect(r.found).toBeGreaterThan(0)
  })

  it('словарь людей', () => {
    const r = maskPii('Скажите Волку, что счёт готов', {
      people: [{ key: 'client:1', kind: 'client', fullName: 'Дмитрий Волк' }],
    })
    expect(r.masked).not.toContain('Волку')
    expect(r.masked).toContain('Клиент_1')
    expect(r.restore(r.masked)).toBe('Скажите Волку, что счёт готов')
  })

  it('текст без ПДн не меняется', () => {
    const src = 'Нужна лицензия на 10 рабочих мест, срок — год.'
    const r = maskPii(src)
    expect(r.masked).toBe(src)
    expect(r.found).toBe(0)
    expect(r.restore(src)).toBe(src)
  })
})
