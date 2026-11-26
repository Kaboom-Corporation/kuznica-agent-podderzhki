import { q } from '../../lib/db'
import { uuidParam } from '../../lib/guard'

/** История диалога для клиента (после перезагрузки страницы). id диалога знает только сам клиент. */
export default defineEventHandler(async (event) => {
  const id = uuidParam(event)
  const messages = await q<{ role: string; content: string; created_at: Date }>(
    `select role, content, created_at from messages where conversation_id = $1 and role in ('user','assistant','manager') order by id`,
    [id],
  )
  return { conversationId: id, messages }
})
