import { describe, expect, it } from 'vitest'
import { renderMd, rub } from '../app/utils/md'

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
  it('нумерованный список', () => {
    expect(renderMd('1. раз\n2. два')).toBe('<ol><li>раз</li><li>два</li></ol>')
  })
})

describe('rub', () => {
  it('копейки в рубли', () => {
    expect(rub('123456').replace(/\s/g, ' ')).toBe('1 234,56 ₽')
  })
})
