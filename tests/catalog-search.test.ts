import { describe, expect, it } from 'vitest'
import { analogQuery, buildTsQueries, clarifyFirst, queryWords, russianVendor, seatCount, selectionQueries, termMonths } from '../server/agent/catalog-search'
import { decode, parseOffer } from '../server/lib/feed'

describe('первая реплика — только уточнения', () => {
  it('«не знаю, что нужно» без названного продукта', () => {
    expect(clarifyFirst('не знаю что нам нужно, хочу защитить почту и файлы для 50 сотрудников')).toBe(true)
  })
  it('названный продукт, просьба об аналоге или уже идущий разговор — нет', () => {
    expect(clarifyFirst('не знаю, что выбрать в касперском для 5 пк')).toBe(false)
    expect(clarifyFirst('не знаю, есть ли российский аналог windows')).toBe(false)
    expect(clarifyFirst('не знаю что нужно', ['хочу защитить почту'])).toBe(false)
    expect(clarifyFirst('сколько стоит kaspersky standard')).toBe(false)
  })
})

describe('российский разработчик', () => {
  it('Касперский и Dr.Web — российские, хотя отметки реестра в фиде нет', () => {
    expect(russianVendor('Доктор Веб')).toBe(true)
    expect(russianVendor('«Лаборатория Касперского»')).toBe(true)
    expect(russianVendor('Группа Астра')).toBe(true)
  })
  it('иностранные и пустые — нет', () => {
    expect(russianVendor('PRO32')).toBe(false)
    expect(russianVendor('Zoho')).toBe(false)
    expect(russianVendor('MDaemon')).toBe(false)
    expect(russianVendor(null)).toBe(false)
  })
})

describe('подбор «не знаю, что нужно»', () => {
  const first = 'не знаю что нам нужно, хочу защитить почту и файлы для 50 сотрудников'
  it('первая реплика — за уточнениями, после ответа открываем каталог', () => {
    expect(selectionQueries(first)).toEqual([])
    expect(selectionQueries('у нас Windows, бюджет до 400 тысяч', [first])).toContain('kaspersky endpoint security для бизнеса')
  })
  it('цена за узел или за комплект', async () => {
    const { perSeat } = await import('../server/agent/catalog-search')
    expect(perSeat('Kaspersky Endpoint Security для бизнеса Расширенный лицензия Base на 1 год по количеству узлов')).toBe(true)
    expect(perSeat('Kaspersky Endpoint Security для бизнеса Стандартный базовая лицензия на 1 год. Количество узлов')).toBe(true)
    expect(perSeat('Доктор Веб Комплексная защита + Центр управления на 1 год на 50 ПК')).toBe(false)
  })
  it('знает товар или просит аналог — не подбор', () => {
    expect(selectionQueries('сколько стоит Kaspersky Standard?', ['добрый день'])).toEqual([])
    expect(selectionQueries('а есть российский аналог?', [first])).toEqual([])
  })
})

describe('catalog-search', () => {
  it('выкидывает числа и пунктуацию, бренды пишет обоими способами', () => {
    expect(queryWords('Касперский на 5 компов!')).toEqual(['касперский', 'компов'])
    const q = buildTsQueries('сколько стоит касперский на 5 компов')!
    expect(q.all).toBe('(касперский:* | kaspersky:*) & (компов:* | пк:* | компьютер:*)')
    expect(q.any).toContain(' | ')
  })
  it('редакции по-русски ищутся и латиницей', () => {
    expect(buildTsQueries('касперский стандарт')!.all).toBe('(касперский:* | kaspersky:*) & (стандарт:* | standard:*)')
  })
  it('число мест из запроса', () => {
    expect(seatCount('касперский на 3 устройства на год')).toBe(3)
    expect(seatCount('защита на 50 сотрудников')).toBe(50)
    expect(seatCount('windows 11 pro')).toBeNull()
  })
  it('срок из запроса', () => {
    expect(termMonths('касперский на год')).toBe(12)
    expect(termMonths('dr.web на 3 года')).toBe(36)
    expect(termMonths('подписка 24 мес')).toBe(24)
    expect(termMonths('windows 11 pro')).toBeNull()
  })
  it('dr.web и кириллическая «х86» из фида', () => {
    expect(buildTsQueries('dr.web x86')!.all).toBe('(dr:* | доктор:* | drweb:*) & (web:* | веб:*) & (x86:* | х86:*)')
  })
  it('пустой запрос — без tsquery', () => {
    expect(buildTsQueries('5 ?')).toBeNull()
  })
  it('спецсимволы tsquery не пролезают', () => {
    expect(buildTsQueries("ab' & cd:* | !ef")!.all).toBe('ab:* & cd:* & ef:*')
  })
  it('российский аналог: класс из вопроса', () => {
    expect(analogQuery('чем заменить виндовс, чтобы было в реестре?')).toBe('astra linux special edition рабочей станции')
    expect(analogQuery('нужна российская ос на 10 машин')).toBe('astra linux special edition рабочей станции')
    expect(analogQuery('есть отечественный аналог vmware?')).toBe('ред виртуализация')
  })
  it('российский аналог: класс из первой реплики, а не из уточнений', () => {
    const earlier = ['не знаю что нам нужно, хочу защитить почту и файлы для 50 сотрудников', 'у нас Windows, почта на своём Exchange']
    expect(analogQuery('а есть российский аналог?', earlier)).toBe('доктор веб комплексная защита на 1 год на 50 пк')
  })
  it('российский аналог: не просят — null', () => {
    expect(analogQuery('сколько стоит касперский?')).toBeNull()
    expect(analogQuery('а есть российский аналог?')).toBeNull()
    expect(analogQuery('господи, а что с ценой?')).toBeNull()
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
