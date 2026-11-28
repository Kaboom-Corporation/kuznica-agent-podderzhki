/**
 * Каталог магазина из товарного фида YML (формат Яндекс.Маркета: <categories>, <offers>).
 * Берёт все позиции фида. Нет цены → price_cents = NULL («цена по запросу»: агент позицию находит,
 * но не считает, а передаёт менеджеру). Есть в наличии → stock = -1 (доступно к заказу), нет → 0.
 * Срока поставки в фиде нет — lead_days = NULL, агент не называет срок, а предлагает уточнить у менеджера.
 * Скидочные правила демо-магазина к чужому прайсу не относятся: price_rules очищаются, считаем по прайсу
 * (скидку 5% по просьбе клиента даёт код, server/agent/quote.ts).
 * Общий код для разовой загрузки (scripts/ingest-feed.ts) и ежедневной (server/tasks/feed/refresh.ts).
 */
import { closeSync, createReadStream, createWriteStream, openSync, readSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import type pg from 'pg'
import { toCents } from '../ported/invoices/money'
import { LOT_PREFIX } from '../agent/catalog-search'

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      return ENT[e.toLowerCase()] ?? m
    })
    .replace(/[​ ]/g, ' ')
    .trim()
}

const tag = (block: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)
  return m ? decode(m[1]!) : ''
}

const EMPTY = new Set(['', 'другое или отсутствует', 'не определено', 'Не определено'])
// В описание идут параметры, по которым клиент выбирает: тип организации и лицензии, объём, версия.
const KEEP = ['Тип организации', 'Тип лицензии', 'Пользователь', 'К-во пользователей до', 'К-во узлов', 'Версия',
  'Лицензионная программа', 'Модель лицензирования', 'Сертификаты и стандарты', 'Назначение', 'Тип устройства']

export interface FeedItem {
  sku: string; name: string; vendor: string; category: string; unit: string; term_months: number | null
  price_cents: bigint | null; stock: number; in_registry: boolean; description: string; url: string | null
}

export function parseOffer(block: string, categoryPath: (id: string) => string): FeedItem | null {
  const head = /<offer\s([^>]*)>/.exec(block)
  if (!head) return null
  const id = /\bid="([^"]+)"/.exec(head[1]!)?.[1]
  const available = /\bavailable="true"/.test(head[1]!)
  const price = toCents(tag(block, 'price'))
  const name = tag(block, 'name')
  if (!id || !name) return null

  const params = new Map<string, string[]>()
  for (const m of block.matchAll(/<param name="([^"]+)"[^>]*>([\s\S]*?)<\/param>/g)) {
    const k = decode(m[1]!)
    const v = decode(m[2]!)
    if (EMPTY.has(v)) continue
    params.set(k, [...(params.get(k) ?? []), v])
  }
  const p1 = (k: string) => params.get(k)?.[0] ?? ''
  const term = /^(\d+)\s*мес/.exec(p1('Срок действия'))
  const registry = p1('Номер записи в реестре отечественного ПО')
  const hardware = p1('Тип продукта') === 'электроника'

  const extra = KEEP.filter(k => params.has(k)).map(k => `${k}: ${params.get(k)!.join(', ')}`)
  if (registry) extra.push(`№ в реестре отечественного ПО: ${registry}`)
  const delivery = p1('Тип поставки')
  if (delivery) extra.push(`Поставка: ${delivery}`)
  // Партия: «Кол-во от 25 до 49 шт.» в sales_notes. У Касперского одна и та же лицензия идёт под разными
  // артикулами на 25–49, 50–99, 100–149 мест с разной ценой за место — без этого поля КП на 50 мест
  // считалось по цене партии 100–149 (стенд 27.11, КП-103). Первым, чтобы не отрезалось при сокращении описания.
  const lot = /Кол-во\s+от\s*(\d+)(?:\s*до\s*(\d+))?/i.exec(tag(block, 'sales_notes'))
  const lotText = lot ? `${LOT_PREFIX} от ${lot[1]}${lot[2] ? ` до ${lot[2]}` : ''}` : ''
  const description = [lotText, tag(block, 'description'), ...extra].filter(Boolean).join(' • ').slice(0, 900)

  return {
    sku: `SL-${id}`,
    name,
    vendor: tag(block, 'vendor') || 'без вендора',
    category: categoryPath(tag(block, 'categoryId')),
    unit: hardware ? 'шт.' : 'лицензия',
    term_months: term ? Number(term[1]) : null,
    price_cents: price != null && price > 0n ? price : null,
    stock: available ? -1 : 0,
    in_registry: !!registry,
    description,
    url: tag(block, 'url') || null,
  }
}

export interface ParsedFeed {
  /** Позиции; пусто, если разбор шёл с onItem (тогда позиции сразу уходят в базу). */
  items: FeedItem[]
  /** loaded — позиции, попавшие в каталог; priced — из них с ценой. */
  offers: number; categories: number; loaded: number; priced: number; available: number; registry: number
}

/**
 * Разбор потоком: фид магазина — сотни мегабайт после распаковки, целиком в память не читаем.
 * С onItem позиции не копятся: 55 тыс. позиций в массиве — это ~450 МБ, а у приложения на стенде потолок 512 МБ.
 */
export async function parseFeed(
  source: AsyncIterable<string | Buffer>,
  onItem?: (item: FeedItem) => void | Promise<void>,
): Promise<ParsedFeed> {
  const cats = new Map<string, { name: string; parent: string | null }>()
  const path = (id: string): string => {
    const names: string[] = []
    let cur: string | null = id
    for (let guard = 0; cur && guard < 6; guard++) {
      const c = cats.get(cur)
      if (!c) break
      names.unshift(c.name)
      cur = c.parent
    }
    return names.join(' / ') || 'без категории'
  }

  const items: FeedItem[] = []
  let offers = 0
  let loaded = 0
  let priced = 0
  let available = 0
  let registry = 0
  let buf = ''
  let inOffers = false
  for await (const chunk of source) {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (!inOffers) {
      for (const m of buf.matchAll(/<category id="([^"]+)"(?:\s+parentId="([^"]+)")?[^>]*>([\s\S]*?)<\/category>/g)) {
        cats.set(m[1]!, { name: decode(m[3]!), parent: m[2] ?? null })
      }
      const at = buf.indexOf('<offers>')
      if (at < 0) {
        // разобранные категории отрезаем; нет ни одной закрытой — буфер не трогаем (раньше тут терялись 10 символов)
        const done = buf.lastIndexOf('</category>')
        if (done >= 0) buf = buf.slice(done + 11)
        continue
      }
      inOffers = true
      buf = buf.slice(at + 8)
    }
    let end: number
    while ((end = buf.indexOf('</offer>')) >= 0) {
      offers++
      const item = parseOffer(buf.slice(0, end), path)
      buf = buf.slice(end + 8)
      if (!item) continue
      loaded++
      if (item.price_cents != null) priced++
      if (item.stock < 0) available++
      if (item.in_registry) registry++
      if (onItem) await onItem(item)
      else items.push(item)
    }
  }
  return { items, offers, categories: cats.size, loaded, priced, available, registry }
}

/** gzip — по сигнатуре 1f 8b: магазин отдаёт .yml.gz со сжатием HTTP, и fetch распаковывает его сам. */
function isGzip(file: string): boolean {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(2)
    return readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x1F && head[1] === 0x8B
  }
  finally {
    closeSync(fd)
  }
}

/** Файл фида, сжатый или нет. Поток в utf8, чтобы многобайтная кириллица не рвалась на стыке кусков. */
export function feedFileStream(file: string): AsyncIterable<string> {
  const raw = createReadStream(file, { highWaterMark: 1 << 20 })
  const s = isGzip(file) ? raw.pipe(createGunzip()) : raw
  s.setEncoding('utf8')
  return s as AsyncIterable<string>
}

/** Скачать фид во временный файл и отдать его поток. Таймаут — 5 минут на загрузку. */
export async function withFeedUrl<T>(url: string, fn: (s: AsyncIterable<string>) => Promise<T>): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!res.ok || !res.body) throw new Error(`фид не скачался: HTTP ${res.status}`)
  const dir = await mkdtemp(join(tmpdir(), 'feed-'))
  const file = join(dir, 'feed')
  try {
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(file))
    return await fn(feedFileStream(file))
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Файл или https-адрес фида → поток. */
export function withFeed<T>(src: string, fn: (s: AsyncIterable<string>) => Promise<T>): Promise<T> {
  return /^https?:\/\//.test(src) ? withFeedUrl(src, fn) : fn(feedFileStream(src))
}

/**
 * Защита от битого фида: если позиций стало меньше половины того, что уже в базе,
 * каталог не трогаем — лучше вчерашние цены, чем пустой магазин.
 */
export function feedLooksBroken(newCount: number, currentCount: number): boolean {
  if (newCount === 0) return true
  return currentCount > 0 && newCount < currentCount / 2
}

const COLS = 11
async function insertItems(client: pg.PoolClient, part: FeedItem[]): Promise<void> {
  if (!part.length) return
  const values: unknown[] = []
  const rows = part.map((r, j) => {
    values.push(r.sku, r.name, r.vendor, r.category, r.unit, r.term_months, r.price_cents?.toString() ?? null, r.stock, r.in_registry, r.description, r.url)
    return `(${Array.from({ length: COLS }, (_, k) => `$${j * COLS + k + 1}`).join(',')})`
  })
  await client.query(
    `insert into catalog_items (sku, name, vendor, category, unit, term_months, price_cents, stock, in_registry, description, url)
     values ${rows.join(',')} on conflict (sku) do nothing`,
    values,
  )
}

export interface LoadResult { feed: ParsedFeed; applied: boolean; current: number }

/**
 * Заменить каталог фидом одной транзакцией: агент в это время видит старый каталог, а не пустой.
 * Позиции пишутся пачками по 500 прямо из потока. Фид оказался битым (feedLooksBroken) — откат, каталог прежний.
 */
export async function loadFeed(client: pg.PoolClient, source: AsyncIterable<string | Buffer>): Promise<LoadResult> {
  try {
    await client.query('begin')
    const current = Number((await client.query('select count(*)::int as n from catalog_items')).rows[0]?.n ?? 0)
    await client.query('delete from catalog_items')
    await client.query('delete from price_rules')
    let part: FeedItem[] = []
    const feed = await parseFeed(source, async (item) => {
      part.push(item)
      if (part.length >= 500) {
        await insertItems(client, part)
        part = []
      }
    })
    await insertItems(client, part)
    // фид без единой цены — тоже битый: каталог «всё по запросу» хуже вчерашнего
    if (feedLooksBroken(feed.loaded, current) || feed.priced === 0) {
      await client.query('rollback')
      return { feed, applied: false, current }
    }
    // Когда каталог обновлён — комментарием к таблице: без новой таблицы и миграции на стенде
    await client.query(`comment on table catalog_items is 'feed:${new Date().toISOString()}'`)
    await client.query('commit')
    return { feed, applied: true, current }
  }
  catch (e) {
    await client.query('rollback')
    throw e
  }
}

export function feedSummary(f: ParsedFeed): string {
  return `категорий: ${f.categories}, позиций в фиде: ${f.offers}, загружено: ${f.loaded}, из них с ценой: ${f.priced}, без цены (по запросу): ${f.loaded - f.priced}, в наличии ${f.available}, в реестре ПО: ${f.registry}`
}
