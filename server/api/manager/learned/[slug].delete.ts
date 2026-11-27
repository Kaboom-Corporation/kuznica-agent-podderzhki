import { q } from '../../../lib/db'
import { requireManager } from '../../../lib/guard'

/** «Забыть» ответ менеджера: убрать из базы знаний. Трогает только документы из ответов менеджера, не базу магазина. */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const slug = String(getRouterParam(event, 'slug') ?? '')
  if (!/^manager-[0-9a-f]{8}-\d+$/.test(slug)) throw createError({ statusCode: 400, statusMessage: 'не тот документ' })
  const rows = await q(`delete from kb_documents where slug = $1 and source like 'manager:%' returning id`, [slug])
  if (!rows.length) throw createError({ statusCode: 404, statusMessage: 'уже удалён' })
  return { ok: true }
})
