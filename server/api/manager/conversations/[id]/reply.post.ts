import { q, q1 } from '../../../../lib/db'
import { requireManager, uuidParam } from '../../../../lib/guard'

/** Ответ менеджера в диалог (после эскалации). Клиент увидит его в истории чата; эскалации диалога закрываются. */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const id = uuidParam(event)
  const body = await readBody<{ text?: string }>(event)
  const text = String(body?.text ?? '').trim().slice(0, 4000)
  if (!text) throw createError({ statusCode: 400, statusMessage: 'пустой ответ' })
  const c = await q1('select id from conversations where id = $1', [id])
  if (!c) throw createError({ statusCode: 404, statusMessage: 'обращение не найдено' })
  await q(`insert into messages (conversation_id, role, content) values ($1, 'manager', $2)`, [id, text])
  await q('update escalations set resolved = true where conversation_id = $1 and not resolved', [id])
  await q(`update conversations set status = 'open', updated_at = now() where id = $1`, [id])
  return { ok: true }
})
