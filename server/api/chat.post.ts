import { ask, MAX_QUESTION_CHARS } from '../agent/loop'
import { rateLimit } from '../lib/guard'

/** Чат клиента: реплика → ответ агента. conversationId из прошлого ответа продолжает диалог. */
export default defineEventHandler(async (event) => {
  rateLimit(event)
  const body = await readBody<{ text?: string; conversationId?: string }>(event)
  const text = String(body?.text ?? '').trim()
  if (!text) throw createError({ statusCode: 400, statusMessage: 'пустое сообщение' })
  if (text.length > MAX_QUESTION_CHARS) throw createError({ statusCode: 413, statusMessage: 'слишком длинное сообщение' })
  const conversationId = body?.conversationId && /^[0-9a-f-]{36}$/i.test(body.conversationId) ? body.conversationId : undefined

  const r = await ask({ channel: 'chat', text, conversationId })
  // Клиенту — ответ, источники и черновики; разбор инструментов и сверки — только в панели менеджера.
  return {
    conversationId: r.conversationId,
    text: r.text,
    sources: r.sources.filter(s => !s.expired),
    drafts: r.drafts,
    escalated: !!r.escalation,
  }
})
