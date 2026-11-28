/**
 * Страница магазина, с которой пишет клиент (витрина стенда или виджет на сайте магазина).
 * Карточка узнаётся по адресу: в фиде store.softline.ru хвост адреса карточки — номер позиции, артикул
 * каталога — SL-<номер> (…/kaspersky/kl4863rakfe-4998/ → SL-4998). Номер — только кандидат: карточкой
 * страница считается, если адрес позиции в каталоге совпадает с ней целиком (у страницы продукта
 * …/redsoft/red-os-1/ хвост «-1» — не артикул). Страница без карточки даёт заголовок — подсказку, о чём вопрос.
 */
import { q1 } from '../lib/db'
import { SKU_RE } from '../lib/shop'

export interface PageInput {
  sku?: string
  url?: string
  title?: string
}

/** Путь адреса без хоста, query, hash и краевых слэшей, в нижнем регистре; null — не адрес. */
export function urlPath(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
    return decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, '').toLowerCase()
  }
  catch { return null }
}

/** Кандидат в артикул из адреса: последний сегмент пути кончается на -<число>. */
export function skuFromUrl(url: string | undefined): string | undefined {
  const last = urlPath(url)?.split('/').filter(Boolean).at(-1) ?? ''
  const m = /-(\d{1,12})$/.exec(last)
  return m ? `SL-${m[1]}` : undefined
}

/** Заголовок страницы чужого сайта идёт в подсказку модели: одна строка, без кавычек и управляющих символов, коротко. */
export function cleanTitle(title: string | undefined): string | undefined {
  if (!title) return undefined
  const t = title.replace(/[\u0000-\u001f\u007f«»"`<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).trim()
  return t.length >= 2 ? t : undefined
}

/** Тело запроса → контекст страницы. Кривое молча отбрасывается; пусто — undefined. */
export function normalizePage(raw: unknown): PageInput | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const sku = typeof r.sku === 'string' && SKU_RE.test(r.sku) ? r.sku : undefined
  const url = typeof r.url === 'string' && r.url.length <= 2048 && urlPath(r.url) !== null ? r.url : undefined
  const title = cleanTitle(typeof r.title === 'string' ? r.title : undefined)
  if (!sku && !url && !title) return undefined
  return { ...(sku ? { sku } : {}), ...(url ? { url } : {}), ...(title ? { title } : {}) }
}

/** Артикул открытой карточки: явный или из адреса, если адрес позиции в каталоге — ровно эта страница. */
export async function pageSku(page: PageInput | undefined): Promise<string | undefined> {
  if (!page) return undefined
  if (page.sku) return page.sku
  const sku = skuFromUrl(page.url)
  const path = urlPath(page.url)
  if (!sku || !path) return undefined
  const row = await q1<{ sku: string }>(
    `select sku from catalog_items where sku = $1 and lower(trim(both '/' from regexp_replace(url, '^https?://[^/]+', ''))) = $2`,
    [sku, path],
  )
  return row?.sku
}

/** Подсказка, когда карточки нет, а заголовок страницы есть. */
export function titleHint(title: string): string {
  return ` Клиент пишет со страницы магазина «${title}». Если в вопросе нет названия товара — скорее всего, он про продукт с этой страницы: найди его в каталоге (check_stock) по названию. Если спрашивает о другом — ищи как обычно.`
}
