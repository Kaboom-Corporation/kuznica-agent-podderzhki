/**
 * Каталог магазина из товарного фида YML (формат Яндекс.Маркета: <categories>, <offers>).
 * Запуск: npm run ingest:feed -- путь/к/feed.xml
 * Берёт позиции с ценой; есть в наличии → stock = -1 (доступно к заказу), нет → 0.
 * Срока поставки в фиде нет — lead_days = NULL, агент не называет срок, а предлагает уточнить у менеджера.
 * Скидочные правила демо-магазина к чужому прайсу не относятся: price_rules очищаются, считаем по прайсу.
 * Сам фид в репозиторий не кладём — путь передаётся аргументом.
 */
import { createReadStream, existsSync } from 'node:fs'
import { db } from '../server/lib/db.ts'
import { toCents } from '../server/ported/invoices/money.ts'


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
  price_cents: bigint; stock: number; in_registry: boolean; description: string; url: string | null
}

export function parseOffer(block: string, categoryPath: (id: string) => string): FeedItem | null {
  const head = /<offer\s([^>]*)>/.exec(block)
  if (!head) return null
  const id = /\bid="([^"]+)"/.exec(head[1]!)?.[1]
  const available = /\bavailable="true"/.test(head[1]!)
  const price = toCents(tag(block, 'price'))
  if (!id || price == null || price <= 0n) return null

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
  const description = [tag(block, 'description'), ...extra].filter(Boolean).join(' • ').slice(0, 900)

  return {
    sku: `SL-${id}`,
    name: tag(block, 'name'),
    vendor: tag(block, 'vendor') || 'без вендора',
    category: categoryPath(tag(block, 'categoryId')),
    unit: hardware ? 'шт.' : 'лицензия',
    term_months: term ? Number(term[1]) : null,
    price_cents: price,
    stock: available ? -1 : 0,
    in_registry: !!registry,
    description,
    url: tag(block, 'url') || null,
  }
}

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const FEED = process.argv[2]
  if (!FEED) { console.error('укажи путь к фиду: npm run ingest:feed -- feed.xml'); process.exit(2) }
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
  let buf = ''
  let inOffers = false
  for await (const chunk of createReadStream(FEED, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
    buf += chunk
    if (!inOffers) {
      for (const m of buf.matchAll(/<category id="([^"]+)"(?:\s+parentId="([^"]+)")?[^>]*>([\s\S]*?)<\/category>/g)) {
        cats.set(m[1]!, { name: decode(m[3]!), parent: m[2] ?? null })
      }
      const at = buf.indexOf('<offers>')
      if (at < 0) { buf = buf.slice(Math.max(0, buf.lastIndexOf('</category>') + 11)); continue }
      inOffers = true
      buf = buf.slice(at + 8)
    }
    let end: number
    while ((end = buf.indexOf('</offer>')) >= 0) {
      offers++
      const item = parseOffer(buf.slice(0, end), path)
      if (item) items.push(item)
      buf = buf.slice(end + 8)
    }
  }

  const pool = db()
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('delete from catalog_items')
    await client.query('delete from price_rules')
    const COLS = 11
    for (let i = 0; i < items.length; i += 500) {
      const part = items.slice(i, i + 500)
      const values: unknown[] = []
      const rows = part.map((r, j) => {
        values.push(r.sku, r.name, r.vendor, r.category, r.unit, r.term_months, r.price_cents.toString(), r.stock, r.in_registry, r.description, r.url)
        return `(${Array.from({ length: COLS }, (_, k) => `$${j * COLS + k + 1}`).join(',')})`
      })
      await client.query(
        `insert into catalog_items (sku, name, vendor, category, unit, term_months, price_cents, stock, in_registry, description, url)
         values ${rows.join(',')} on conflict (sku) do nothing`,
        values,
      )
    }
    await client.query('commit')
    const avail = items.filter(i => i.stock < 0).length
    console.log(`категорий: ${cats.size}, позиций в фиде: ${offers}, загружено с ценой: ${items.length} (в наличии ${avail}), в реестре ПО: ${items.filter(i => i.in_registry).length}`)
  }
  catch (e) {
    await client.query('rollback')
    throw e
  }
  finally {
    client.release()
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1) })
