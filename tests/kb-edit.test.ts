import { describe, expect, it } from 'vitest'
import { joinChunks, validateKb } from '../server/lib/kb-edit'
import { chunkMarkdown } from '../server/ported/rag/chunker'

// Никита, 27.11: «базы знаний нету как будто на редактировании для менеджера» — правка статьи в панели
describe('правка базы знаний', () => {
  it('статья, склеенная из кусков, режется обратно на те же куски', () => {
    const md = '## Пробная версия\nПробную версию даёт производитель на 30 дней.\n\n## Продление\nПродление дешевле новой лицензии, если срок не истёк.'
    const chunks = chunkMarkdown(md)
    const again = chunkMarkdown(joinChunks(chunks))
    expect(again.map(c => [c.heading, c.content.trim()])).toEqual(chunks.map(c => [c.heading, c.content.trim()]))
  })
  it('заголовок раздела не повторяется, если раздел разрезан на несколько кусков', () => {
    const text = joinChunks([
      { heading: 'Оплата', content: 'Счёт на юрлицо.' },
      { heading: 'Оплата', content: 'Карта для физлиц.' },
      { heading: null, content: 'Без раздела.' },
    ])
    expect(text.match(/## Оплата/g)).toHaveLength(1)
    expect(text).toContain('Карта для физлиц.')
  })
  it('пустой заголовок и слишком короткий текст не сохраняются', () => {
    expect(() => validateKb('  ', 'Достаточно длинный текст статьи')).toThrow(/заголовок/i)
    expect(() => validateKb('Статья', 'коротко')).toThrow(/короткий/)
    expect(() => validateKb('Статья', 'а'.repeat(40_001))).toThrow(/длиннее/)
  })
  it('пробелы в заголовке и переводы строк Windows приводятся в порядок', () => {
    const r = validateKb('  Пробная   версия ', 'Строка один\r\nСтрока два, текста хватает')
    expect(r.title).toBe('Пробная версия')
    expect(r.content).not.toContain('\r')
  })
})
