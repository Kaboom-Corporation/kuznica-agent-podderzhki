import type { AIProvider, AIMessage, AICompletionOptions, AICompletionResult } from './provider'
import { attemptTimeoutMs, isOutOfFunds, outputTokenFloor, requestSignal, samplingFields, sanitizeProviderErrorText, type AIProviderError } from './openai-compat'

/**
 * Прямой Anthropic через fetch на /v1/messages (без SDK, чтобы не тащить зависимость).
 * Нативные инструменты: описания OpenAI function → Anthropic tools, tool_use → toolCalls/rawToolCalls,
 * сообщения role:'tool' → блоки tool_result. cache_control на system при cacheSystem; токены кэша в разбивке.
 */

const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_TIMEOUT_MS = 30_000
const ANTHROPIC_VERSION = '2023-06-01'

type AnthropicBlock =
  | { type: 'text', text: string, cache_control?: { type: 'ephemeral' } }
  | { type: 'tool_use', id: string, name: string, input: Record<string, unknown> }
  | { type: 'tool_result', tool_use_id: string, content: string }
type AnthropicMessage = { role: 'user' | 'assistant', content: string | AnthropicBlock[] }

type AnthropicUsage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/** Аргументы вызова из истории (JSON-строка OpenAI-формата) → объект для tool_use. Битые — пустой объект. */
function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const v = raw ? JSON.parse(raw) : {}
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  }
  catch {
    return {}
  }
}

/**
 * Весь вход вызова ВМЕСТЕ с кэшем. У Anthropic input_tokens — только часть после метки кэша, чтение и запись кэша
 * приходят отдельными полями; приводим к смыслу OpenAI-совместимых (prompt_tokens включает кэш).
 */
function inputTokensWithCache(u: AnthropicUsage | undefined): number {
  if (!u) return 0
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
}

/** Склеить подряд идущие user-сообщения: результаты параллельных инструментов должны лежать в ОДНОМ user-сообщении. */
function mergeConsecutiveUser(messages: AnthropicMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const m of messages) {
    const prev = out[out.length - 1]
    if (prev && prev.role === 'user' && m.role === 'user') {
      const toBlocks = (c: string | AnthropicBlock[]): AnthropicBlock[] => (typeof c === 'string' ? [{ type: 'text', text: c }] : c)
      prev.content = [...toBlocks(prev.content), ...toBlocks(m.content)]
    }
    else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

export function createClaudeProvider(cfg: { apiKey: string, baseUrl?: string, model: string }): AIProvider {
  const base = (cfg.baseUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '')
  const url = /\/v1\/messages$/i.test(base) ? base : /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`

  return {
    name: 'claude',
    async complete(messages: AIMessage[], options?: AICompletionOptions): Promise<AICompletionResult> {
      // Чужие id шлюзов («anthropic/claude-haiku-5.5») прямому API не годятся — берём настроенную модель.
      const requested = options?.model
      const model = requested && !requested.includes('/') ? requested : cfg.model
      const maxTokens = Math.max(options?.maxTokens || DEFAULT_MAX_TOKENS, outputTokenFloor(model))
      const withTools = !!options?.tools?.length

      const systemMessages = messages.filter(m => m.role === 'system')
      const converted: AnthropicMessage[] = messages
        .filter(m => m.role !== 'system')
        .map((m): AnthropicMessage => {
          if (m.role === 'tool') {
            if (withTools && m.tool_call_id) {
              return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] }
            }
            return { role: 'user', content: `Результат инструмента${m.name ? ` ${m.name}` : ''}: ${m.content}` }
          }
          if (withTools && m.role === 'assistant' && m.tool_calls?.length) {
            const blocks: AnthropicBlock[] = []
            if (m.content) blocks.push({ type: 'text', text: m.content })
            for (const tc of m.tool_calls) {
              blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseToolArgs(tc.function.arguments) })
            }
            return { role: 'assistant', content: blocks }
          }
          return { role: m.role as 'user' | 'assistant', content: m.content || (m.tool_calls?.length ? '(вызов инструментов)' : '') }
        })

      const systemPrompt = [options?.system, ...systemMessages.map(m => m.content)].filter(Boolean).join('\n\n')
      // Динамический хвост (дата и т.п.) — отдельный блок БЕЗ cache_control: его смена не сбрасывает кэш основной части.
      const tail = options?.systemTail?.trim()
      let system: string | AnthropicBlock[] | undefined
      if (systemPrompt) {
        system = options?.cacheSystem
          ? [
              { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
              ...(tail ? [{ type: 'text' as const, text: tail }] : []),
            ]
          : (tail ? `${systemPrompt}\n\n${tail}` : systemPrompt)
      }
      else {
        system = tail || undefined
      }

      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        ...samplingFields(model, options?.temperature),
        ...(system ? { system } : {}),
        messages: mergeConsecutiveUser(converted),
      }
      if (withTools) {
        body.tools = options!.tools!.map(t => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
        }))
        const choice = options!.toolChoice ?? 'auto'
        body.tool_choice = choice === 'required' ? { type: 'any' } : choice === 'none' ? { type: 'none' } : { type: 'auto' }
      }

      const attemptMs = attemptTimeoutMs(options, DEFAULT_TIMEOUT_MS)
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: requestSignal(attemptMs, options?.signal),
        })
      }
      catch (err) {
        throw new Error(`[claude] ${sanitizeProviderErrorText(err instanceof Error ? err.message : String(err))}`)
      }
      if (!res.ok) {
        const errText = sanitizeProviderErrorText(await res.text().catch(() => ''))
        const wrapped = new Error(`[claude] HTTP ${res.status}${errText ? `: ${errText}` : ''}`) as AIProviderError
        wrapped.statusCode = res.status
        if (isOutOfFunds(res.status, errText)) wrapped.outOfFunds = true
        throw wrapped
      }

      const response: any = await res.json()
      const content: any[] = Array.isArray(response?.content) ? response.content : []
      const text = content.filter(b => b?.type === 'text').map(b => String(b.text ?? '')).join('')
      const uses = content.filter(b => b?.type === 'tool_use')
      const toolCalls = uses.map(u => ({ id: String(u.id), name: String(u.name), arguments: (u.input ?? {}) as Record<string, unknown> }))
      const rawToolCalls = uses.map(u => ({
        id: String(u.id),
        type: 'function' as const,
        function: { name: String(u.name), arguments: JSON.stringify(u.input ?? {}) },
      }))

      const stop: string | null = response?.stop_reason ?? null
      const refused = stop === 'refusal'
      if (!text && !toolCalls.length && !refused) {
        throw new Error(`[claude] empty content (ответ без текста и без tool_use, stop_reason=${stop ?? 'n/a'})`)
      }

      const usage: AnthropicUsage | undefined = response?.usage
      return {
        text,
        inputTokens: inputTokensWithCache(usage),
        cachedInputTokens: usage?.cache_read_input_tokens || 0,
        cacheWriteInputTokens: usage?.cache_creation_input_tokens || 0,
        outputTokens: usage?.output_tokens || 0,
        model,
        provider: 'claude',
        ...(stop === 'max_tokens' ? { truncated: true } : {}),
        ...(refused ? { refused: true } : {}),
        ...(toolCalls.length ? { toolCalls, rawToolCalls } : {}),
      }
    },
  }
}
