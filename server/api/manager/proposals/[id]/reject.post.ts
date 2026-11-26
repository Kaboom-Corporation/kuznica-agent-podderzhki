import { q1 } from '../../../../lib/db'
import { requireManager, uuidParam } from '../../../../lib/guard'

/** Менеджер отклоняет черновик КП (агент ошибся в составе). Клиенту ничего не уходит. */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const id = uuidParam(event)
  const r = await q1<{ number: string }>(`update proposals set status = 'rejected' where id = $1 and status = 'draft' returning number`, [id])
  if (!r) throw createError({ statusCode: 409, statusMessage: 'КП не найдено или уже не черновик' })
  return { number: r.number, status: 'rejected' }
})
