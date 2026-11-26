/**
 * Агентный цикл: модель ↔ инструменты, не больше MAX_STEPS шагов. Схема — по avito-ai-buddy (agent.go):
 *  - модель ответила по памяти, не заглянув в базу, — код сам делает поиск и даёт второй заход;
 *  - черновики и эскалации копит код, а не модель;
 *  - перед отправкой ответ проходит verify_answer (по parent-assistant): каждое число должно быть в фактах хода.
 *    Не прошёл — одна попытка исправить, потом менеджер с черновиком и списком расхождений.
 * Персональные данные клиента маскируются до модели и возвращаются только в ответ клиенту.
 */
import { q, q1, toJson } from '../lib/db'
import { maskPii } from '../ported/ai/pii/mask'
import { costRub } from '../ported/ai/pricing'
import type { AIMessage } from '../ported/ai/provider'
import { pickLlm, type Llm } from './llm'
import { systemPrompt, systemTail } from './prompt'
import { analogQuery } from './catalog-search'
import { TOOL_DEFS, runTool, type Turn, type Source, type Draft, type Escalation } from './tools'
import { absorbQuestion, checkActions, checkRegistry, describe, emptyFacts, verifyAnswer, type Verdict } from './verify'

export const MAX_STEPS = 8
/** Потолок входа на одно обращение: дальше цикл обрывается, чтобы запрос не стоил как десять. */
export const MAX_INPUT_TOKENS = 120_000
export const MAX_QUESTION_CHARS = 4000

export interface AgentReply {
  conversationId: string
  text: string
  sources: Source[]
  drafts: Draft[]
  escalation: Escalation | null
  verify: Verdict
  run: { model: string; steps: number; inputTokens: number; outputTokens: number; costRub: number; durationMs: number; tools: Turn['calls'] }
}

export interface AskInput {
  conversationId?: string
  channel: 'chat' | 'email'
  text: string
  customer?: { name?: string; email?: string; company?: string }
  subject?: string
  llm?: Llm
  today?: Date
}

const HANDOFF_TEXT = 'Чтобы не ошибиться в цифрах, я передал ваш вопрос менеджеру — он ответит в рабочее время. Если удобно, оставьте телефон или почту для связи.'

export async function ask(input: AskInput): Promise<AgentReply> {
  const started = Date.now()
  const llm = input.llm ?? pickLlm()
  const today = input.today ?? new Date()
  const question = input.text.slice(0, MAX_QUESTION_CHARS).trim()
  if (!question) throw new Error('пустой вопрос')

  const conversationId = await ensureConversation(input)
  const history = await q<{ role: string; content: string }>(
    `select role, content from (select role, content, id from messages where conversation_id = $1 and role in ('user','assistant','manager') order by id desc limit 10) h order by id`,
    [conversationId],
  )
  await q(`insert into messages (conversation_id, role, content) values ($1, 'user', $2)`, [conversationId, question])

  // История и вопрос маскируются одним проходом, чтобы метки совпадали между репликами.
  const joined = [...history.map(h => h.content), question].join('\n␞\n')
  const pii = maskPii(joined)
  const maskedParts = pii.masked.split('\n␞\n')
  const maskedQuestion = maskedParts.at(-1) ?? question

  const msgs: AIMessage[] = history.map((h, i) => ({
    role: h.role === 'user' ? 'user' : 'assistant',
    content: maskedParts[i] ?? h.content,
  }))
  msgs.push({ role: 'user', content: maskedQuestion })

  const t: Turn = {
    conversationId,
    question: maskedQuestion,
    facts: emptyFacts(today),
    sources: [],
    drafts: [],
    escalation: null,
    searched: false,
    embedTokens: 0,
    calls: [],
    vatPercent: Number(process.env.NUXT_SELLER_VAT_PERCENT || 22),
  }
  // Прошлые ответы уже прошли сверку, их цифры можно повторять; цифры клиента — тоже.
  for (const part of maskedParts) absorbQuestion(t.facts, part)

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, rub: 0 }
  const system = systemPrompt(process.env.NUXT_PUBLIC_SHOP_NAME || 'Демо Софт')
  let steps = 0
  let forcedSearch = false
  let forcedCatalog = false
  const earlierUser = history.flatMap((h, i) => h.role === 'user' ? [maskedParts[i] ?? h.content] : [])
  let retriedVerify = false
  let final = ''
  let verdict: Verdict = { ok: true, checked: [], mismatches: [] }

  while (steps < MAX_STEPS && usage.input < MAX_INPUT_TOKENS) {
    steps++
    let res: Awaited<ReturnType<typeof llm.provider.complete>>
    try {
      res = await llm.provider.complete(msgs, {
        system,
        systemTail: systemTail(today),
        cacheSystem: true,
        tools: TOOL_DEFS as any,
        gatewayModel: llm.model,
        model: llm.model,
        maxTokens: 1500,
        temperature: 0.2,
        noThinking: true,
        timeoutMs: llm.timeoutMs,
      })
    }
    catch (err) {
      // Модель упала или не ответила: клиент не должен остаться без ответа — передаём менеджеру с причиной.
      console.error(`[agent] ${llm.kind}:${llm.model} шаг ${steps}:`, (err as Error).message)
      if (process.env.NUXT_AGENT_DEBUG) console.error('[agent] сообщения:', msgs.map(m => `${m.role}${(m as any).tool_calls ? `→${(m as any).tool_calls.map((c: any) => c.function.name)}` : ''}:${String(m.content ?? '').length}`).join(' | '))
      t.escalation ??= { kind: 'low_confidence', reason: `модель недоступна на шаге ${steps}: ${(err as Error).message.slice(0, 300)}` }
      final = ''
      break
    }
    usage.input += res.inputTokens
    usage.output += res.outputTokens
    usage.cacheRead += res.cachedInputTokens ?? 0
    usage.cacheWrite += res.cacheWriteInputTokens ?? 0
    usage.rub += costRub(llm.priceId, {
      input: res.inputTokens, output: res.outputTokens,
      cacheRead: res.cachedInputTokens, cacheWrite: res.cacheWriteInputTokens,
    })

    if (!res.toolCalls?.length) {
      // Просят российский аналог, а в каталог модель не заглянула — ищет код и даёт второй заход.
      const analog = forcedCatalog || t.calls.some(c => c.name === 'check_stock') || t.drafts.length || t.escalation
        ? null
        : analogQuery(maskedQuestion, earlierUser)
      if (analog) {
        forcedCatalog = true
        const id = 'auto-catalog'
        const out = await runTool('check_stock', { query: analog }, t)
        msgs.push(
          { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'check_stock', arguments: JSON.stringify({ query: analog }) } }] },
          { role: 'tool', tool_call_id: id, name: 'check_stock', content: toJson(out) },
        )
        continue
      }
      // Ответ по памяти на содержательный вопрос: поиск делает код и даёт модели второй заход.
      if (!forcedSearch && !t.searched && !t.drafts.length && !t.escalation && maskedQuestion.split(/\s+/).length >= 5) {
        forcedSearch = true
        const id = 'auto-search'
        const out = await runTool('search_kb', { query: maskedQuestion }, t)
        msgs.push(
          { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'search_kb', arguments: JSON.stringify({ query: maskedQuestion }) } }] },
          { role: 'tool', tool_call_id: id, name: 'search_kb', content: toJson(out) },
        )
        continue
      }
      final = res.text.trim()
      verdict = verifyAnswer(final, t.facts)
      const claims = checkActions(final, {
        proposal: t.drafts.some(d => d.kind === 'proposal'),
        invoice: t.drafts.some(d => d.kind === 'invoice'),
        handoff: !!t.escalation,
      })
      claims.push(...checkRegistry(final, t.facts))
      if (claims.length) verdict = { ok: false, checked: [...verdict.checked, ...claims.map(c => `${c.kind}: ${c.value}`)], mismatches: [...verdict.mismatches, ...claims] }
      if (!verdict.ok && !retriedVerify && steps < MAX_STEPS) {
        retriedVerify = true
        msgs.push(
          { role: 'assistant', content: final },
          {
            role: 'user',
            content: `[проверка магазина, клиент этого не видит] В ответе есть то, чего нет в данных инструментов: ${verdict.mismatches.map(describe).join('; ')}. Перепиши ответ: возьми цифры из инструментов слово в слово или вызови нужный инструмент (КП — draft_proposal, счёт — draft_invoice, менеджер — handoff_to_manager). Если данных нет — убери это из ответа или передай менеджеру. Клиент прошлый вариант не видел: не извиняйся и не упоминай проверку, просто дай исправленный ответ.`,
          },
        )
        continue
      }
      break
    }

    msgs.push({ role: 'assistant', content: res.text || '', tool_calls: res.rawToolCalls })
    for (const call of res.toolCalls) {
      // метки ПДн в аргументах (почта клиента для КП) — обратно в настоящие значения только внутри магазина
      const args = JSON.parse(pii.restore(JSON.stringify(call.arguments ?? {})))
      const out = await runTool(call.name, args, t)
      msgs.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: toJson(out) })
    }
  }

  if (!final) {
    final = HANDOFF_TEXT
    t.escalation ??= { kind: 'low_confidence', reason: `цикл не уложился в ${MAX_STEPS} шагов или потолок токенов` }
  }
  else if (!verdict.ok) {
    t.escalation = { kind: 'verify_failed', reason: `черновик ответа: ${final}\nрасхождения: ${verdict.mismatches.map(describe).join('; ')}` }
    final = HANDOFF_TEXT
  }

  const text = pii.restore(final)
  const durationMs = Date.now() - started
  const answered = !t.escalation && (t.sources.some(s => !s.expired) || t.drafts.length > 0 || !t.searched)

  await q(
    `insert into messages (conversation_id, role, content, meta) values ($1, 'assistant', $2, $3)`,
    [conversationId, text, toJson({ sources: t.sources, drafts: t.drafts, escalation: t.escalation, verify: verdict })],
  )
  if (t.escalation) {
    await q(`insert into escalations (conversation_id, kind, question, reason) values ($1, $2, $3, $4)`,
      [conversationId, t.escalation.kind, question, t.escalation.reason])
    await q(`update conversations set status = 'waiting_manager', updated_at = now() where id = $1`, [conversationId])
  }
  await q(
    `insert into agent_runs (conversation_id, channel, model, steps, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       embed_tokens, cost_rub, duration_ms, tools, answered, escalated, verify_issues)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [conversationId, input.channel, `${llm.kind}:${llm.model}`, steps, usage.input, usage.output, usage.cacheRead, usage.cacheWrite,
      t.embedTokens, usage.rub.toFixed(4), durationMs, toJson(t.calls), answered, !!t.escalation, toJson(verdict.mismatches)],
  )

  return {
    conversationId,
    text,
    sources: t.sources,
    drafts: t.drafts,
    escalation: t.escalation,
    verify: verdict,
    run: { model: `${llm.kind}:${llm.model}`, steps, inputTokens: usage.input, outputTokens: usage.output, costRub: usage.rub, durationMs, tools: t.calls },
  }
}

async function ensureConversation(input: AskInput): Promise<string> {
  if (input.conversationId && /^[0-9a-f-]{36}$/i.test(input.conversationId)) {
    const row = await q1<{ id: string }>('select id from conversations where id = $1', [input.conversationId])
    if (row) return row.id
  }
  const row = await q1<{ id: string }>(
    `insert into conversations (channel, customer_name, customer_email, customer_company, subject) values ($1,$2,$3,$4,$5) returning id`,
    [input.channel, input.customer?.name ?? null, input.customer?.email ?? null, input.customer?.company ?? null, input.subject ?? null],
  )
  return row!.id
}
