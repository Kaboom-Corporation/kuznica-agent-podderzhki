import { describe, expect, it } from 'vitest'
import { feedLooksBroken, parseFeed } from '../server/lib/feed'

const YML = `<?xml version="1.0" encoding="UTF-8"?><yml_catalog><shop>
<categories><category id="1">Антивирусы</category><category id="2" parentId="1">Для бизнеса</category></categories>
<offers>
<offer id="100" available="true"><name>Защита рабочих станций</name><price>1500.50</price><categoryId>2</categoryId><vendor>Вендор</vendor></offer>
<offer id="101" available="false"><name>Без наличия</name><price>900</price><categoryId>2</categoryId></offer>
<offer id="102" available="true"><name>Без цены</name><categoryId>1</categoryId></offer>
</offers></shop></yml_catalog>`

// Фид режем на куски по 7 символов: теги и кириллица рвутся на стыке, как в настоящем потоке
async function* chunks(s: string, n = 7) {
  for (let i = 0; i < s.length; i += n) yield s.slice(i, i + n)
}

describe('ежедневный фид', () => {
  it('разбирает фид потоком: категории, цена, наличие', async () => {
    const f = await parseFeed(chunks(YML))
    expect(f.offers).toBe(3)
    expect(f.categories).toBe(2)
    expect(f.items.map(i => [i.sku, i.price_cents, i.stock, i.category])).toEqual([
      ['SL-100', 150050n, -1, 'Антивирусы / Для бизнеса'],
      ['SL-101', 90000n, 0, 'Антивирусы / Для бизнеса'],
    ])
  })
  it('битый или урезанный фид каталог не заменяет', () => {
    expect(feedLooksBroken(0, 0)).toBe(true)
    expect(feedLooksBroken(4000, 10000)).toBe(true)
    expect(feedLooksBroken(9000, 10000)).toBe(false)
    expect(feedLooksBroken(500, 0)).toBe(false)
  })
})
