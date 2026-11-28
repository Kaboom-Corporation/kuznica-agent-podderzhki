import { q, q1 } from '../../../lib/db'
import { requireManager, uuidParam } from '../../../lib/guard'
import { MAX_DISCOUNT_PCT, pctOf, vatInside, type CatalogItem } from '../../../agent/quote'

/**
 * Менеджер правит черновик КП: количество, скидку по строке, убирает лишнюю позицию.
 * Суммы пересчитывает код по цене из каталога — с клиента цену не берём. Только для черновика.
 * Скидка вручную — до MAX_DISCOUNT_PCT, как потолок правил.
 */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const id = uuidParam(event)
  const body = await readBody<{ items?: unknown; notes?: unknown }>(event)
  const raw = Array.isArray(body?.items) ? body.items : []
  const items = raw
    .map((x: any) => ({ sku: String(x?.sku ?? '').trim(), qty: Math.floor(Number(x?.qty)), pct: Math.floor(Number(x?.discount_pct ?? 0)) }))
    .filter(x => x.sku)
  if (!items.length) throw createError({ statusCode: 400, statusMessage: 'в КП должна остаться хотя бы одна позиция' })
  if (new Set(items.map(i => i.sku)).size !== items.length) throw createError({ statusCode: 400, statusMessage: 'позиция повторяется' })
  for (const i of items) {
    if (!Number.isFinite(i.qty) || i.qty < 1 || i.qty > 100_000) throw createError({ statusCode: 400, statusMessage: `${i.sku}: количество от 1 до 100 000` })
    if (!Number.isFinite(i.pct) || i.pct < 0 || i.pct > MAX_DISCOUNT_PCT) throw createError({ statusCode: 400, statusMessage: `${i.sku}: скидка от 0 до ${MAX_DISCOUNT_PCT}%` })
  }

  const p = await q1<{ status: string; items: Array<{ sku: string; discount_pct: number; rules?: string[] }> }>(
    'select status, items from proposals where id = $1', [id])
  if (!p) throw createError({ statusCode: 404, statusMessage: 'КП не найдено' })
  if (p.status !== 'draft') throw createError({ statusCode: 409, statusMessage: 'править можно только черновик' })

  // Позиции — только из этого КП: менеджер меняет состав, а не подбирает товар (это делает агент по каталогу)
  const unknown = items.filter(i => !p.items.some(o => o.sku === i.sku))
  if (unknown.length) throw createError({ statusCode: 400, statusMessage: `${unknown.map(i => i.sku).join(', ')}: нет в этом КП` })
  const found = await q<CatalogItem>('select * from catalog_items where sku = any($1)', [items.map(i => i.sku)])

  const lines = items.map((i) => {
    const item = found.find(f => f.sku === i.sku)
    if (!item || item.price_cents == null) throw createError({ statusCode: 409, statusMessage: `${i.sku}: цены в каталоге больше нет` })
    const before = p.items.find(o => o.sku === i.sku)!
    const unit = BigInt(item.price_cents)
    const gross = unit * BigInt(i.qty)
    const discount = pctOf(gross, i.pct)
    return {
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      qty: i.qty,
      unit_cents: unit,
      gross_cents: gross,
      discount_pct: i.pct,
      // скидку поменял человек — правила агента к строке больше не относятся
      rules: i.pct === before.discount_pct ? (before.rules ?? []) : (i.pct ? ['MANAGER'] : []),
      discount_cents: discount,
      sum_cents: gross - discount,
    }
  })
  const subtotal = lines.reduce((s, l) => s + l.gross_cents, 0n)
  const discount = lines.reduce((s, l) => s + l.discount_cents, 0n)
  const total = subtotal - discount
  const vat = vatInside(total, Number(useRuntimeConfig().vatPercent) || 22)
  const notes = typeof body?.notes === 'string' ? body.notes.slice(0, 2000) : null

  const r = await q1<{ number: string }>(
    `update proposals set items = $2, subtotal_cents = $3, discount_cents = $4, total_cents = $5, vat_cents = $6,
            notes = coalesce($7, notes)
      where id = $1 and status = 'draft' returning number`,
    [id, JSON.stringify(lines, (_k, v) => typeof v === 'bigint' ? v.toString() : v), subtotal, discount, total, vat, notes],
  )
  if (!r) throw createError({ statusCode: 409, statusMessage: 'КП уже не черновик' })
  return { number: r.number, total_cents: total.toString() }
})
