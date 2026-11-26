import { q, q1 } from '../../../lib/db'
import { requireManager, uuidParam } from '../../../lib/guard'

/** Карточка обращения: переписка, КП, счета, эскалации и запуски агента (инструменты, токены, ₽, сверка). */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const id = uuidParam(event)
  const conversation = await q1('select * from conversations where id = $1', [id])
  if (!conversation) throw createError({ statusCode: 404, statusMessage: 'обращение не найдено' })
  const [messages, proposals, invoices, escalations, runs] = await Promise.all([
    q('select id, role, content, meta, created_at from messages where conversation_id = $1 order by id', [id]),
    q(`select id, number, status, customer, items, subtotal_cents, discount_cents, total_cents, vat_cents, notes,
              to_char(valid_until, 'YYYY-MM-DD') as valid_until, created_at, approved_at, sent_at
         from proposals where conversation_id = $1 order by created_at`, [id]),
    q(`select i.id, i.number, i.status, i.total_cents, i.vat_cents, to_char(i.due_date, 'YYYY-MM-DD') as due_date, p.number as proposal
         from invoices i join proposals p on p.id = i.proposal_id where p.conversation_id = $1 order by i.created_at`, [id]),
    q('select id, kind, question, reason, resolved, created_at from escalations where conversation_id = $1 order by id', [id]),
    q(`select id, model, steps, input_tokens, output_tokens, embed_tokens, cost_rub, duration_ms, tools, answered, escalated, verify_issues, created_at
         from agent_runs where conversation_id = $1 order by id`, [id]),
  ])
  return { conversation, messages, proposals, invoices, escalations, runs }
})
