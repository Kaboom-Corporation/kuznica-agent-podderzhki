import { describe, expect, it } from 'vitest'
import { chunkMarkdown, chunkText } from '../server/ported/rag/chunker'

describe('chunkMarkdown', () => {
  it('режет по заголовкам ## и хранит заголовок', () => {
    const md = '# Название\n\nВступление длиной достаточной для чанка.\n\n## Доставка\n\nДоставляем лицензии по e-mail в течение часа.\n\n## Оплата\n\nСчёт выставляем в рублях, оплата по безналу.'
    const chunks = chunkMarkdown(md)
    expect(chunks.map(c => c.heading)).toEqual([null, 'Доставка', 'Оплата'])
    expect(chunks[1]!.content).toContain('по e-mail')
  })

  it('заголовок внутри блока кода не считается разделом', () => {
    const md = '## Пример\n\n```\n## не заголовок\n```\n\nТекст после блока кода для длины.'
    expect(chunkMarkdown(md)).toHaveLength(1)
  })

  it('длинный раздел режется с перекрытием и не длиннее chunkSize', () => {
    const para = Array.from({ length: 30 }, (_, i) => `Абзац номер ${i} с достаточно длинным текстом внутри.`).join('\n\n')
    const chunks = chunkText(para, { chunkSize: 300, overlap: 50 })
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300)
  })
})
