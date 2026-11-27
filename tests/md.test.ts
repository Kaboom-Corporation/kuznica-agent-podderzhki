import { describe, expect, it } from 'vitest'
import { qtyUnit, renderMd, rub } from '../app/utils/md'

describe('renderMd', () => {
  it('экранирует HTML из ответа модели', () => {
    const html = renderMd('<img src=x onerror=alert(1)> и <script>x</script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;img')
  })
  it('не пропускает javascript: в ссылках', () => {
    const html = renderMd('[жми](javascript:alert(1))')
    expect(html).not.toContain('href="javascript')
  })
  it('жирный, списки и ссылки', () => {
    const html = renderMd('**Вариант 1**\n- Dr.Web — 1 000 ₽\n- Kaspersky\n\nСм. https://example.com/a')
    expect(html).toContain('<strong>Вариант 1</strong>')
    expect(html).toContain('<ul><li>Dr.Web — 1 000 ₽</li><li>Kaspersky</li></ul>')
    expect(html).toContain('<a href="https://example.com/a"')
  })
  it('вложенный адрес в ссылке не ломает атрибут href', () => {
    const html = renderMd('[x](https://a.ru/(https://b.ru/"onmouseover=alert(1)) и **https://c.ru/**')
    // ни одного тега внутри значения href и ни одного незакрытого атрибута
    for (const m of html.matchAll(/href="([^"]*)"/g)) expect(m[1]).not.toMatch(/[<>]/)
    expect(html).not.toMatch(/\sonmouseover=/)
    expect(html).toContain('<strong><a href="https://c.ru/"')
  })
  it('нельзя подделать заглушку ссылки', () => {
    const html = renderMd('\u00000\u0000 https://a.ru')
    expect(html.match(/<a /g)?.length).toBe(1)
  })
  it('нумерованный список', () => {
    expect(renderMd('1. раз\n2. два')).toBe('<ol><li>раз</li><li>два</li></ol>')
  })
})

describe('qtyUnit', () => {
  it('согласует лицензии с числом, «шт.» не трогает', () => {
    expect([1, 3, 11, 12, 21, 50, 104].map(n => qtyUnit(n, 'лицензия'))).toEqual(
      ['1 лицензия', '3 лицензии', '11 лицензий', '12 лицензий', '21 лицензия', '50 лицензий', '104 лицензии'])
    expect(qtyUnit(5, 'шт.')).toBe('5 шт.')
  })
})

describe('rub', () => {
  it('копейки в рубли', () => {
    expect(rub('123456').replace(/\s/g, ' ')).toBe('1 234,56 ₽')
  })
})
