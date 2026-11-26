import { q } from '../../lib/db'
import { requireManager } from '../../lib/guard'

/** Очередь менеджера: обращения, последняя реплика, черновики, эскалации и ₽ на модель. Фильтр ?status=waiting_manager. */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const status = String(getQuery(event).status || '')
  return q(
    `select c.id, c.channel, c.status, c.subject, c.customer_company, c.created_at, c.updated_at,
            (select content from messages m where m.conversation_id = c.id and m.role = 'user' order by id desc limit 1) as last_question,
            (select count(*)::int from proposals p where p.conversation_id = c.id and p.status = 'draft') as draft_proposals,
            (select count(*)::int from escalations e where e.conversation_id = c.id and not e.resolved) as open_escalations,
            (select coalesce(sum(cost_rub), 0)::text from agent_runs r where r.conversation_id = c.id) as cost_rub
       from conversations c
      where ($1 = '' or c.status = $1)
      order by c.updated_at desc
      limit 200`,
    [status],
  )
})
