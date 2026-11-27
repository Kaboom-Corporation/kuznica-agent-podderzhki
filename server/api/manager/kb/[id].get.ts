import { requireManager } from '../../../lib/guard'
import { getKb, kbIdParam } from '../../../lib/kb-edit'

/** Статья базы знаний целиком — текст собран из кусков. */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const doc = await getKb(kbIdParam(event))
  if (!doc) throw createError({ statusCode: 404, statusMessage: 'Статья не найдена' })
  return doc
})
