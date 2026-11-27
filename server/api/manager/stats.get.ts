import { q, q1 } from '../../lib/db'
import { requireManager } from '../../lib/guard'

/** Сводка за ?days= (по умолчанию 7): обращения, доля без человека, ₽ на обращение, пробелы базы знаний. */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const days = Math.min(Math.max(Number(getQuery(event).days) || 7, 1), 90)
  const totals = await q1(
    `select count(distinct conversation_id)::int as conversations,
            count(*)::int as runs,
            count(*) filter (where escalated)::int as escalated_runs,
            coalesce(sum(cost_rub), 0)::text as cost_rub,
            coalesce(avg(cost_rub), 0)::numeric(12,4)::text as avg_cost_rub,
            coalesce(percentile_cont(0.5) within group (order by duration_ms), 0)::int as median_ms,
            count(*) filter (where jsonb_array_length(verify_issues) > 0)::int as verify_issues
       from agent_runs where created_at > now() - make_interval(days => $1)`,
    [days],
  )
  // «Закрыто агентом» по определению организаторов: обращение обошлось без менеджера (ни передачи, ни ответа
  // человека, ни отклонённого КП) — в том числе когда менеджер лишь подтвердил черновик КП одной кнопкой.
  const closed = await q1<{ total: number; by_agent: number; with_proposal: number }>(
    `with c as (
       select distinct conversation_id as id from agent_runs where created_at > now() - make_interval(days => $1)
     ), f as (
       select c.id,
              exists (select 1 from escalations e where e.conversation_id = c.id) as escalated,
              exists (select 1 from messages m where m.conversation_id = c.id and m.role = 'manager') as manager_wrote,
              exists (select 1 from proposals p where p.conversation_id = c.id and p.status = 'rejected') as rejected,
              exists (select 1 from proposals p where p.conversation_id = c.id and p.status in ('approved', 'sent')) as proposal_ok
         from c
     )
     select count(*)::int as total,
            count(*) filter (where not escalated and not manager_wrote and not rejected)::int as by_agent,
            count(*) filter (where not escalated and not manager_wrote and not rejected and proposal_ok)::int as with_proposal
       from f`,
    [days],
  )
  const [byModel, proposals, gaps, learned] = await Promise.all([
    q(`select model, count(*)::int as runs, sum(cost_rub)::text as cost_rub from agent_runs
        where created_at > now() - make_interval(days => $1) group by model order by runs desc`, [days]),
    q(`select status, count(*)::int as n, sum(total_cents)::text as total_cents from proposals
        where created_at > now() - make_interval(days => $1) group by status`, [days]),
    q(`select id, conversation_id, kind, question, reason, created_at from escalations
        where not resolved order by id desc limit 50`),
    q(`select slug, title, updated_at from kb_documents where source like 'manager:%' order by id desc limit 30`),
  ])
  return { days, totals, closed, byModel, proposals, gaps, learned }
})
