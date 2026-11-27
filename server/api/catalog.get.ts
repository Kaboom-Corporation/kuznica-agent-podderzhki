import { q1 } from '../lib/db'

/** Когда каталог последний раз обновлён из фида и сколько в нём позиций — для подписи «цены на дату» в чате. */
export default defineEventHandler(async () => {
  const row = await q1<{ note: string | null; items: number }>(
    `select obj_description('catalog_items'::regclass, 'pg_class') as note,
            (select count(*)::int from catalog_items) as items`,
  )
  const m = row?.note?.match(/^feed:(.+)$/)
  return { at: m ? m[1] : null, items: row?.items ?? 0 }
})
