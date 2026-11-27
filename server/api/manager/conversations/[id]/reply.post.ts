import { q, q1 } from '../../../../lib/db'
import { requireManager, uuidParam } from '../../../../lib/guard'
import { learnFromManager } from '../../../../lib/learn'

/**
 * Ответ менеджера в диалог (после эскалации). Клиент увидит его в истории чата; эскалации диалога закрываются.
 * remember (по умолчанию да): пара «вопрос клиента → ответ» идёт в базу знаний, и дальше агент отвечает на такой вопрос сам.
 */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const id = uuidParam(event)
  const body = await readBody<{ text?: string; remember?: boolean }>(event)
  const text = String(body?.text ?? '').trim().slice(0, 4000)
  if (!text) throw createError({ statusCode: 400, statusMessage: 'пустой ответ' })
  const c = await q1('select id from conversations where id = $1', [id])
  if (!c) throw createError({ statusCode: 404, statusMessage: 'обращение не найдено' })
  // Вопрос, на который отвечает менеджер: последняя открытая эскалация, иначе последнее сообщение клиента
  const esc = await q1<{ question: string }>(
    `select question from escalations where conversation_id = $1 and not resolved order by created_at desc limit 1`, [id])
  const last = esc ? null : await q1<{ content: string }>(
    `select content from messages where conversation_id = $1 and role = 'user' order by created_at desc limit 1`, [id])
  const question = esc?.question ?? last?.content ?? ''

  await q(`insert into messages (conversation_id, role, content) values ($1, 'manager', $2)`, [id, text])
  await q('update escalations set resolved = true where conversation_id = $1 and not resolved', [id])
  await q(`update conversations set status = 'open', updated_at = now() where id = $1`, [id])

  let learned = null
  if (body?.remember !== false) {
    try {
      learned = await learnFromManager(id, question, text)
    }
    catch (e) {
      console.warn(`ответ менеджера не попал в базу знаний: ${(e as Error).message}`)
    }
  }
  return { ok: true, learned }
})
