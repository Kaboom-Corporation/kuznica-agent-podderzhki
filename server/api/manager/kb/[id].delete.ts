import { requireManager } from '../../../lib/guard'
import { deleteKb, kbIdParam } from '../../../lib/kb-edit'

/** Удалить статью. Статья магазина вернётся при следующей перезаливке базы (scripts/ingest.ts). */
export default defineEventHandler(async (event) => {
  requireManager(event)
  if (!await deleteKb(kbIdParam(event))) throw createError({ statusCode: 404, statusMessage: 'Уже удалена' })
  return { ok: true }
})
