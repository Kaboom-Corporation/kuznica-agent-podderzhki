import { q1 } from '../../../../lib/db'
import { requireManager } from '../../../../lib/guard'

/** Закрыть эскалацию (пробел в базе знаний закрыт или вопрос решён вне чата). */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'неверный id' })
  const r = await q1('update escalations set resolved = true where id = $1 returning id', [id])
  if (!r) throw createError({ statusCode: 404, statusMessage: 'эскалация не найдена' })
  return { ok: true }
})
