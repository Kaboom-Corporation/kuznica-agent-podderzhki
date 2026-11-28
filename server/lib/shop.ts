import { buildTsQueries, LOT_PREFIX } from '../agent/catalog-search'
import { rub } from '../agent/quote'
import { q, q1 } from './db'

/** Позиция витрины: деньги строкой «12 345,60 ₽», без цены — null («по запросу»). */
export interface ShopItem {
  sku: string
  name: string
  vendor: string
  category: string
  unit: string
  term_months: number | null
  price: string | null
  /** партия у позиций, где цена за место зависит от объёма: «от 25 до 49» */
  lot: string | null
  /** -1 — доступно к заказу (фид не даёт количества), 0 — нет, >0 — штук на складе */
  stock: number
  lead_days: number | null
  in_registry: boolean
}

export interface ShopCard extends ShopItem {
  description: string
  url: string | null
}

type Row = Omit<ShopItem, 'price' | 'lot'> & { price_cents: bigint | null; head: string }
// head — первый пункт описания: там фид кладёт партию («Кол-во в заказе: от 25 до 49»)
const COLS = `sku, name, vendor, category, unit, term_months, price_cents, stock, lead_days, in_registry, split_part(description, ' • ', 1) as head`
export const PAGE = 24
/** Кеш числа позиций по запросу и разделу (каталог обновляется раз в сутки) */
const totals = new Map<string, { at: number; n: number }>()

const view = ({ price_cents, head, ...r }: Row): ShopItem => ({
  ...r,
  price: price_cents == null ? null : rub(price_cents),
  lot: head.startsWith(LOT_PREFIX) ? head.slice(LOT_PREFIX.length).trim() : null,
})

/**
 * Поиск витрины: тот же полнотекст, что у агента (catalog-search), но постранично.
 * Сначала все слова запроса, если ничего — любое. Позиции с ценой выше «по запросу».
 */
export async function shopSearch(opts: { query?: string; category?: string; page?: number }) {
  const page = Math.max(1, Math.min(200, Math.floor(opts.page || 1)))
  const cat = opts.category?.trim() || ''
  const tq = opts.query?.trim() ? buildTsQueries(opts.query) : null
  // в запросе одни числа и знаки — искать нечего
  if (opts.query?.trim() && !tq) return { items: [] as ShopItem[], total: 0, page, pages: 0 }
  const run = async (ts: string | null) => {
    const params: unknown[] = []
    const where: string[] = []
    if (ts) { params.push(ts); where.push(`search_tsv @@ to_tsquery('russian', $${params.length})`) }
    if (cat) { params.push(cat); where.push(`(category = $${params.length} or category like $${params.length} || ' / %')`) }
    const w = where.length ? `where ${where.join(' and ')}` : ''
    const order = ts
      ? `ts_rank(search_tsv, to_tsquery('russian', $1)) desc, (price_cents is null), name`
      : `(price_cents is null), in_registry desc, name`
    // Число позиций — отдельным запросом и из кеша: оконный count(*) over() заставлял сортировать весь каталог на каждой странице
    const key = `${ts ?? ''}\u0000${cat}`
    const hit = totals.get(key)
    const totalP = hit && Date.now() - hit.at < 600_000
      ? Promise.resolve(hit.n)
      : q1<{ n: number }>(`select count(*)::int as n from catalog_items ${w}`, params.slice()).then((r) => {
          if (totals.size > 500) totals.clear()
          totals.set(key, { at: Date.now(), n: r?.n ?? 0 })
          return r?.n ?? 0
        })
    params.push(PAGE, (page - 1) * PAGE)
    const [rows, total] = await Promise.all([
      q<Row>(`select ${COLS} from catalog_items ${w}
       order by ${order} limit $${params.length - 1} offset $${params.length}`, params),
      totalP,
    ])
    return { items: rows.map(view), total }
  }
  let r = await run(tq?.all ?? null)
  // все слова вместе не нашлись — ищем по любому, как агент
  if (!r.total && tq && tq.any !== tq.all) r = await run(tq.any)
  return { ...r, page, pages: Math.ceil(r.total / PAGE) }
}

/** Разделы верхнего уровня с числом позиций. Каталог меняется раз в сутки — кешируем на 10 минут. */
let cats: { at: number; list: { name: string; count: number }[] } | null = null
export async function shopCategories() {
  if (cats && Date.now() - cats.at < 600_000) return cats.list
  const list = await q<{ name: string; count: number }>(
    `select split_part(category, ' / ', 1) as name, count(*)::int as count
     from catalog_items group by 1 order by 2 desc, 1 limit 40`)
  cats = { at: Date.now(), list }
  return list
}

export async function shopCard(sku: string): Promise<ShopCard | null> {
  const r = await q1<Row & { description: string; url: string | null }>(
    `select ${COLS}, description, url from catalog_items where sku = $1`, [sku])
  if (!r) return null
  const { description, url, ...rest } = r
  return { ...view(rest), description, url }
}

export const SKU_RE = /^[\w.\-]{1,64}$/
