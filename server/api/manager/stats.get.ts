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
  const [byModel, proposals, gaps, learned] = await Promise.all([
    q(`select model, count(*)::int as runs, sum(cost_rub)::text as cost_rub from agent_runs
        where created_at > now() - make_interval(days => $1) group by model order by runs desc`, [days]),
    q(`select status, count(*)::int as n, sum(total_cents)::text as total_cents from proposals
        where created_at > now() - make_interval(days => $1) group by status`, [days]),
    q(`select id, conversation_id, kind, question, reason, created_at from escalations
        where not resolved order by id desc limit 50`),
    q(`select slug, title, updated_at from kb_documents where source like 'manager:%' order by id desc limit 30`),
  ])
  return { days, totals, byModel, proposals, gaps, learned }
})
