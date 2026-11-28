import { describe, expect, it } from 'vitest'
import { formatAgentReply, mdToTelegram, mdToTgBlocks, packTg, replyFooter, TG_LIMIT, tgHtmlToPlain } from '../server/lib/telegram-format'

/** Теги Telegram в куске вложены правильно и закрыты — иначе Telegram отклонит сообщение. */
function balanced(html: string): boolean {
  const stack: string[] = []
  for (const m of html.matchAll(/<(\/?)(b|i|s|code|pre|a|blockquote)(?:\s[^>]*)?>/g)) {
    if (!m[1]) stack.push(m[2]!)
    else if (stack.pop() !== m[2]) return false
  }
  return stack.length === 0
}
/** Кроме разрешённых тегов, в HTML нет ни одного «<». */
const onlyAllowedTags = (html: string) => !/<(?!\/?(b|i|s|code|pre|blockquote)>|a href="|\/a>)/.test(html)

describe('mdToTelegram: разметка', () => {
  it('жирный, курсив, код, зачёркнутый', () => {
    const [html] = mdToTelegram('**Цена** — *с НДС*, артикул `KES-50`, ~~старая~~')
    expect(html).toBe('<b>Цена</b> — <i>с НДС</i>, артикул <code>KES-50</code>, <s>старая</s>')
  })
  it('экранирует HTML из ответа модели', () => {
    const [html] = mdToTelegram('<script>alert(1)</script> & <b onclick=x>')
    expect(html).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b onclick=x&gt;')
  })
  it('ссылки только http(s), кавычка не ломает href', () => {
    const [html] = mdToTelegram('[каталог](https://shop.example/a?x=1&y=2) и [жми](javascript:alert(1)) и https://b.example/"onclick=1')
    expect(html).toContain('<a href="https://shop.example/a?x=1&amp;y=2">каталог</a>')
    expect(html).not.toContain('href="javascript')
    for (const m of html!.matchAll(/href="([^"]*)"/g)) expect(m[1]).not.toMatch(/[<>"]/)
    expect(onlyAllowedTags(html!)).toBe(true)
  })
  it('точка после голого адреса — не часть ссылки', () => {
    const [html] = mdToTelegram('Подробнее: https://shop.example/dostavka.')
    expect(html).toBe('Подробнее: <a href="https://shop.example/dostavka">https://shop.example/dostavka</a>.')
  })
  it('звёздочки внутри кода и подчёркивания в словах не становятся разметкой', () => {
    const [html] = mdToTelegram('Ключ `a*b*c` и файл snake_case_name, 5 * 3 = 15')
    expect(html).toBe('Ключ <code>a*b*c</code> и файл snake_case_name, 5 * 3 = 15')
  })
  it('заголовки — жирным, списки — текстом с маркерами', () => {
    const [html] = mdToTelegram('## Варианты\n- **Dr.Web** — 1 000 ₽\n- Kaspersky\n\n1. раз\n2. два')
    expect(html).toBe('<b>Варианты</b>\n• <b>Dr.Web</b> — 1 000 ₽\n• Kaspersky\n\n1. раз\n2. два')
  })
  it('блок кода — <pre> без разбора разметки внутри', () => {
    const [html] = mdToTelegram('```\n**не жирный** <x>\n```')
    expect(html).toBe('<pre>**не жирный** &lt;x&gt;</pre>')
  })
  it('цитата', () => {
    expect(mdToTelegram('> срок — 3 дня\n> оплата — счёт')[0]).toBe('<blockquote>срок — 3 дня\nоплата — счёт</blockquote>')
  })
  it('узкая таблица — моноширинным блоком с выравниванием', () => {
    const [html] = mdToTelegram('| Тариф | Цена |\n|---|---|\n| **Базовый** | 100 |\n| Про | 2500 |')
    expect(html).toBe('<pre>Тариф    Цена\nБазовый  100\nПро      2500</pre>')
  })
  it('широкая таблица — списком «заголовок: значение»', () => {
    const md = '| Продукт | Цена за год | Наличие | Реестр |\n|---|---|---|---|\n| Kaspersky Endpoint Security Стандартный | 3 500 ₽ | есть | да |\n| Dr.Web Desktop Security Suite | 2 100 ₽ | под заказ | да |'
    const [html] = mdToTelegram(md)
    expect(html).toBe('• <b>Kaspersky Endpoint Security Стандартный</b> — Цена за год: 3 500 ₽; Наличие: есть; Реестр: да\n'
      + '• <b>Dr.Web Desktop Security Suite</b> — Цена за год: 2 100 ₽; Наличие: под заказ; Реестр: да')
  })
  it('пустые строки и разделители не дают пустых блоков', () => {
    expect(mdToTgBlocks('раз\n\n\n---\n\nдва')).toEqual(['раз', 'два'])
  })
  it('сколько угодно звёздочек вперемешку — теги всё равно сбалансированы', () => {
    for (const s of ['**a *b* c**', '*a **b** c*', '**не закрыт', 'a ** b ** c', '***жирный курсив***', '`код **внутри**` **снаружи**'])
      for (const html of mdToTelegram(s)) expect(balanced(html), `${s} → ${html}`).toBe(true)
  })
})

describe('mdToTelegram: резка по 4096', () => {
  it('короткий ответ — одно сообщение', () => {
    expect(mdToTelegram('Привет')).toEqual(['Привет'])
  })
  it('режет по абзацам, ни один кусок не длиннее предела', () => {
    const para = 'Абзац с ценой 1 000 ₽ и **жирным**. '.repeat(40).trim()
    const md = Array.from({ length: 10 }, () => para).join('\n\n')
    const msgs = mdToTelegram(md)
    expect(msgs.length).toBeGreaterThan(1)
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(TG_LIMIT)
      expect(balanced(m)).toBe(true)
      // граница — между абзацами: кусок начинается и кончается целым абзацем
      expect(m.startsWith('Абзац')).toBe(true)
      expect(m.endsWith('.')).toBe(true)
    }
    expect(msgs.join('\n\n')).toBe(mdToTgBlocks(md).join('\n\n'))
  })
  it('огромный абзац без пустых строк режется по строкам', () => {
    const md = Array.from({ length: 300 }, (_v, i) => `- позиция ${i} — **${i * 10} ₽**`).join('\n')
    const msgs = mdToTelegram(md, 1000)
    expect(msgs.length).toBeGreaterThan(5)
    for (const m of msgs) { expect(m.length).toBeLessThanOrEqual(1000); expect(balanced(m)).toBe(true) }
    expect(msgs.at(-1)).toContain('позиция 299')
  })
  it('огромная строка без переносов режется по пробелам, разметка снимается, экранирование не ломается', () => {
    const md = `**начало** ${'слово & <тег> '.repeat(800)}`
    const msgs = mdToTelegram(md)
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(TG_LIMIT)
      expect(m).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/)
      expect(m).not.toContain('<')
    }
    expect(msgs.map(tgHtmlToPlain).join(' ')).toContain('слово & <тег>')
  })
  it('длинный блок кода режется на несколько <pre>', () => {
    const md = '```\n' + Array.from({ length: 400 }, (_v, i) => `строка ${i} <x>`).join('\n') + '\n```'
    const msgs = mdToTelegram(md, 1000)
    expect(msgs.length).toBeGreaterThan(1)
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(1000)
      expect(m.startsWith('<pre>') && m.endsWith('</pre>')).toBe(true)
    }
  })
  it('packTg склеивает мелкие блоки, пока помещаются', () => {
    expect(packTg(['a', 'b', 'c'], 4)).toEqual(['a\n\nb', 'c'])
  })
})

describe('tgHtmlToPlain', () => {
  it('снимает теги, возвращает символы и сохраняет адрес ссылки', () => {
    expect(tgHtmlToPlain('<b>Цена</b> &lt;5&gt; &amp; <a href="https://x.ru/?a=1&amp;b=2">тут</a> <a href="https://y.ru">https://y.ru</a>'))
      .toBe('Цена <5> & тут (https://x.ru/?a=1&b=2) https://y.ru')
  })
})

describe('подпись ответа', () => {
  const src = { slug: 'dostavka', title: 'Доставка', heading: 'Сроки', expired: false }
  it('источники — одной строкой, без повторов и устаревших', () => {
    const out = replyFooter({ sources: [src, src, { slug: 'old', title: 'Старое', heading: null, expired: true }, { slug: 'faq', title: 'Вопросы <и> ответы', heading: null, expired: false }] })
    expect(out).toEqual(['<i>Источники: Доставка (Сроки) · Вопросы &lt;и&gt; ответы</i>'])
  })
  it('черновик КП: клиенту — что КП уйдёт после проверки менеджером, без самого документа', () => {
    const [line] = replyFooter({ drafts: [{ kind: 'proposal', id: 'x', number: 'КП-101', total: '175 000,00 ₽' }] })
    expect(line).toContain('КП-101')
    expect(line).toContain('175 000,00 ₽')
    expect(line).toContain('проверит менеджер')
  })
  it('передача менеджеру — отдельной строкой; без источников и черновиков подписи нет', () => {
    expect(replyFooter({ escalated: true })).toEqual(['<i>Вопрос передан менеджеру — его ответ придёт в этот чат.</i>'])
    expect(replyFooter({})).toEqual([])
  })
  it('formatAgentReply: ответ, затем подпись', () => {
    const [msg] = formatAgentReply({ text: 'Срок — **3 дня**.', sources: [src] })
    expect(msg).toBe('Срок — <b>3 дня</b>.\n\n<i>Источники: Доставка (Сроки)</i>')
  })
})
