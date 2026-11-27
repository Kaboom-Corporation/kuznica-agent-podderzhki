import { requireManager } from '../../../lib/guard'
import { saveKb, validateKb } from '../../../lib/kb-edit'

/** Новая статья базы знаний из панели. */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const body = await readBody<{ title?: string; content?: string }>(event)
  const { title, content } = validateKb(body?.title, body?.content)
  return await saveKb(null, title, content)
})
