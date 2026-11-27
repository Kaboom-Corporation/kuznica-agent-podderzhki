import { requireManager } from '../../../lib/guard'
import { kbIdParam, saveKb, validateKb } from '../../../lib/kb-edit'

/** Правка статьи: текст режется на куски заново, эмбеддинги пересчитываются. Агент видит правку со следующего вопроса. */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const id = kbIdParam(event)
  const body = await readBody<{ title?: string; content?: string }>(event)
  const { title, content } = validateKb(body?.title, body?.content)
  return await saveKb(id, title, content)
})
