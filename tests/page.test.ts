import { describe, expect, it } from 'vitest'
import { cleanTitle, normalizePage, skuFromUrl, urlPath } from '../server/agent/page'

describe('urlPath', () => {
  it('путь без хоста, query, hash и краевых слэшей', () => {
    expect(urlPath('https://store.softline.ru/Kaspersky/kl4863rakfe-4998/?utm=1#tab')).toBe('kaspersky/kl4863rakfe-4998')
    expect(urlPath('store.softline.ru/anydesk/-402267/')).toBe('anydesk/-402267')
    expect(urlPath('https://store.softline.ru/')).toBe('')
    expect(urlPath('http://[::bad')).toBeNull()
    expect(urlPath(undefined)).toBeNull()
  })
})

describe('skuFromUrl', () => {
  it('кандидат из хвоста адреса карточки', () => {
    expect(skuFromUrl('https://store.softline.ru/kaspersky/kl4863rakfe-4998/')).toBe('SL-4998')
    expect(skuFromUrl('store.softline.ru/anydesk/-402267/')).toBe('SL-402267')
  })
  it('у страницы продукта хвост тоже бывает числом — это лишь кандидат, сверяет pageSku по каталогу', () => {
    expect(skuFromUrl('https://store.softline.ru/redsoft/red-os-1/')).toBe('SL-1')
  })
  it('продукт без номера, раздел, главная — нет кандидата', () => {
    expect(skuFromUrl('https://store.softline.ru/microsoft/microsoft-power-bi/')).toBeUndefined()
    expect(skuFromUrl('https://store.softline.ru/adobe/')).toBeUndefined()
    expect(skuFromUrl('https://store.softline.ru/')).toBeUndefined()
  })
})

describe('cleanTitle', () => {
  it('одна короткая строка без кавычек и управляющих символов', () => {
    expect(cleanTitle('  Купить «РЕД ОС»\n— лицензии  ')).toBe('Купить РЕД ОС — лицензии')
    expect(cleanTitle('x'.repeat(500))!.length).toBe(120)
    expect(cleanTitle('  ')).toBeUndefined()
  })
})

describe('normalizePage', () => {
  it('артикул, адрес и заголовок', () => {
    expect(normalizePage({ sku: 'SL-1', url: 'https://store.softline.ru/a/b-2/', title: 'Kaspersky' }))
      .toEqual({ sku: 'SL-1', url: 'https://store.softline.ru/a/b-2/', title: 'Kaspersky' })
  })
  it('мусор и пустое — undefined', () => {
    expect(normalizePage(undefined)).toBeUndefined()
    expect(normalizePage('SL-1')).toBeUndefined()
    expect(normalizePage({ sku: 'a b c<script>' })).toBeUndefined()
    expect(normalizePage({ url: 'http://[::bad', title: ' ' })).toBeUndefined()
  })
  it('кривой артикул отбрасывается, адрес остаётся', () => {
    expect(normalizePage({ sku: 'a b', url: 'https://store.softline.ru/adobe/' })).toEqual({ url: 'https://store.softline.ru/adobe/' })
  })
})
