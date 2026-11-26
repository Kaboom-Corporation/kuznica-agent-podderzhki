import { describe, expect, it } from 'vitest'
import { buildTsQueries, queryWords } from '../server/agent/catalog-search'
import { decode, parseOffer } from '../scripts/ingest-feed'

describe('catalog-search', () => {
  it('выкидывает числа и пунктуацию, бренды пишет обоими способами', () => {
    expect(queryWords('Касперский на 5 компов!')).toEqual(['касперский', 'на', 'компов'])
    const q = buildTsQueries('касперский на 5 компов')!
    expect(q.all).toBe('(касперский:* | kaspersky:*) & на:* & (компов:* | пк:* | компьютер:*)')
    expect(q.any).toContain(' | ')
  })
  it('пустой запрос — без tsquery', () => {
    expect(buildTsQueries('5 ?')).toBeNull()
  })
  it('спецсимволы tsquery не пролезают', () => {
    expect(buildTsQueries("ab' & cd:* | !ef")!.all).toBe('ab:* & cd:* & ef:*')
  })
})

describe('фид YML', () => {
  const offer = `<offer id="42" available="true">
    <name>Kaspersky Small Office Security &quot;5 ПК&quot;, 12 мес.</name>
    <vendor>«Лаборатория Касперского»</vendor>
    <url>https://shop.example/k-42/</url>
    <price>6739.20</price>
    <categoryId>7</categoryId>
    <description>Тип лицензии: полная версия</description>
    <param name="Срок действия">12 мес.</param>
    <param name="Тип организации">Коммерческая</param>
    <param name="Номер записи в реестре отечественного ПО">369</param>
    <param name="Версия">другое или отсутствует</param>
    <param name="Тип продукта">софт</param>
  `
  it('разбирает позицию с ценой', () => {
    const it = parseOffer(offer, id => (id === '7' ? 'Антивирусы' : '?'))!
    expect(it).toMatchObject({
      sku: 'SL-42', vendor: '«Лаборатория Касперского»', category: 'Антивирусы', unit: 'лицензия',
      term_months: 12, price_cents: 673920n, stock: -1, in_registry: true, url: 'https://shop.example/k-42/',
    })
    expect(it.name).toContain('"5 ПК"')
    expect(it.description).toContain('Тип организации: Коммерческая')
    expect(it.description).not.toContain('другое или отсутствует')
  })
  it('без цены и не в наличии', () => {
    expect(parseOffer(offer.replace('6739.20', '0.00'), () => '')).toBeNull()
    expect(parseOffer(offer.replace('available="true"', 'available="false"'), () => '')!.stock).toBe(0)
  })
  it('сущности XML', () => {
    expect(decode('A &amp; B &#8212; &#x41;')).toBe('A & B — A')
  })
})
