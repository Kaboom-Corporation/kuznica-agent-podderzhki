import type { AIProvider, AIMessage, AICompletionOptions, AICompletionResult } from './provider'

/**
 * OpenAI-совместимый провайдер (RouterAI, OpenRouter, Ollama, vLLM …): chat completions, нативный function calling,
 * разбивка токенов по кэшу промпта, таймаут и внешняя отмена, признак обрыва по длине. Стриминга здесь нет.
 * Ключи и адрес приходят только аргументами createOpenAICompatProvider.
 */

export interface OpenAICompatConfig {
  name: string
  baseUrl: string
  apiKey: string
  model: string
}

/** URL chat completions: baseUrl с суффиксом `/v1` и без него. */
export function chatCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(clean)) return clean
  return /\/v1$/i.test(clean) ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`
}

// ── форма запроса (из request-shape.ts) ──────────────────────────────────────

/** Claude 4.7+ и 5.x не принимают temperature: им не шлём вовсе. */
export function modelRejectsSampling(model: string): boolean {
  const m = /claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d+))?/.exec(model)
  if (!m) return false
  const major = Number(m[1])
  const minor = m[2] && m[2].length <= 2 ? Number(m[2]) : 0
  return major >= 5 || (major === 4 && minor >= 7)
}

/** Модели, размышляющие по умолчанию (Claude 5.x), делят max_tokens между размышлением и ответом: ниже 2048 ответ пустеет. */
export function outputTokenFloor(model: string): number {
  const m = /claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)/.exec(model)
  return m && Number(m[1]) >= 5 ? 2048 : 0
}

/** Урезать размышление (reasoning.effort=low), если вызывающий просит и модель размышляет. */
export function thinkingFields(model: string, noThinking?: boolean): { reasoning?: { effort: 'low' } } {
  return noThinking && outputTokenFloor(model) > 0 ? { reasoning: { effort: 'low' } } : {}
}

export function samplingFields(model: string, temperature?: number): { temperature?: number } {
  return modelRejectsSampling(model) ? {} : { temperature: temperature ?? 0.3 }
}

/** Таймаут попытки: свой/по умолчанию либо остаток общего дедлайна вызывающего (deadlineMs, момент как Date.now()). */
export function attemptTimeoutMs(options: { timeoutMs?: number, deadlineMs?: number } | undefined, defaultMs: number, now: number = Date.now()): number {
  const own = options?.timeoutMs
  const deadline = options?.deadlineMs
  if (deadline === undefined) return own ?? defaultMs
  const left = Math.max(deadline - now, 1)
  return own === undefined ? left : Math.min(own, left)
}

/** Сигнал одного запроса: таймаут попытки ИЛИ внешняя отмена, что раньше. */
export function requestSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return external ? AbortSignal.any([external, timeout]) : timeout
}

// ── ошибки (из out-of-funds.ts / cascading-provider: только распознавание) ───

export type AIProviderError = Error & { statusCode?: number, outOfFunds?: boolean }

/** Убрать из текста ошибки ключи и заголовки авторизации. */
export function sanitizeProviderErrorText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/\b(?:sk|pk|key)-[A-Za-z0-9_\-]{8,}/g, '***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/** HTTP 402 или текст про исчерпанный баланс — «деньги кончились» (вызывающий решает, что делать: уведомить, переключить). */
export function isOutOfFunds(status: number | undefined, bodyText: string): boolean {
  if (status === 402) return true
  return /insufficient[_ ]?(?:funds|quota|balance)|out of (?:funds|credits)|недостаточно средств|billing/i.test(bodyText)
}

// ── сообщения ────────────────────────────────────────────────────────────────

type TextBlock = { type: 'text', text: string, cache_control?: { type: 'ephemeral' } }
type OpenAIChatMessage = {
  role: string
  content: string | null | TextBlock[]
  tool_calls?: Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>
  tool_call_id?: string
  name?: string
}

type OpenAIUsage = {
  prompt_tokens?: number | null
  completion_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  prompt_tokens_details?: { cached_tokens?: number | null, cache_write_tokens?: number | null } | null
}

/**
 * Разбивка входа по кэшу промпта: ЧАСТИ prompt_tokens, а не добавки к нему (так отдаёт RouterAI/OpenRouter),
 * либо плоскими полями в стиле Anthropic. Нет разбивки — поля остаются undefined.
 */
function cacheBreakdown(usage: OpenAIUsage | null | undefined): Pick<AICompletionResult, 'cachedInputTokens' | 'cacheWriteInputTokens'> {
  if (!usage) return {}
  const read = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens
  const write = usage.prompt_tokens_details?.cache_write_tokens ?? usage.cache_creation_input_tokens
  return {
    ...(typeof read === 'number' ? { cachedInputTokens: read } : {}),
    ...(typeof write === 'number' ? { cacheWriteInputTokens: write } : {}),
  }
}

function buildChatMessages(messages: AIMessage[], system?: string): OpenAIChatMessage[] {
  const systemParts: string[] = []
  if (system) systemParts.push(system)
  const out: OpenAIChatMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(msg.content)
      continue
    }
    if (msg.role === 'tool') {
      out.push({ role: 'tool', content: msg.content, tool_call_id: msg.tool_call_id, name: msg.name })
      continue
    }
    const m: OpenAIChatMessage = { role: msg.role, content: msg.content }
    // assistant с tool_calls и пустым текстом: OpenAI требует content:null, не ''.
    if (msg.tool_calls?.length) {
      m.tool_calls = msg.tool_calls
      if (!msg.content) m.content = null
    }
    out.push(m)
  }
  if (systemParts.length > 0) out.unshift({ role: 'system', content: systemParts.join('\n\n') })
  return out
}

/**
 * Кэш system для Claude через шлюз: system блоком с cache_control, динамический хвост — отдельным блоком без него.
 * Не-Claude модели: хвост просто приклеивается к system.
 */
function applySystemCache(chatMessages: OpenAIChatMessage[], model: string, cacheSystem?: boolean, systemTail?: string): void {
  const tail = systemTail?.trim()
  const first = chatMessages[0]
  const hasSystem = first?.role === 'system' && typeof first.content === 'string'
  if (cacheSystem && /claude/i.test(model)) {
    if (hasSystem) {
      first!.content = [
        { type: 'text', text: first!.content as string, cache_control: { type: 'ephemeral' } },
        ...(tail ? [{ type: 'text' as const, text: tail }] : []),
      ]
    }
    else if (tail) {
      chatMessages.unshift({ role: 'system', content: tail })
    }
    return
  }
  if (!tail) return
  if (hasSystem) first!.content = `${first!.content as string}\n\n${tail}`
  else chatMessages.unshift({ role: 'system', content: tail })
}

function parseRawToolCalls(rawFromApi: unknown): Pick<AICompletionResult, 'toolCalls' | 'rawToolCalls'> {
  if (!Array.isArray(rawFromApi) || rawFromApi.length === 0) return {}
  const rawToolCalls: NonNullable<AICompletionResult['rawToolCalls']> = rawFromApi.map((tc: any) => ({
    id: String(tc?.id ?? ''),
    type: 'function' as const,
    function: { name: String(tc?.function?.name ?? ''), arguments: String(tc?.function?.arguments ?? '{}') },
  }))
  const toolCalls = rawToolCalls.map((tc) => {
    let args: Record<string, unknown> = {}
    try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {} }
    catch { /* битые arguments — пустой объект, вызывающий увидит отсутствие полей */ }
    return { id: tc.id, name: tc.function.name, arguments: args }
  })
  return { toolCalls, rawToolCalls }
}

const DEFAULT_TIMEOUT_MS = 30_000

export function createOpenAICompatProvider(cfg: { name: string, baseUrl: string, apiKey: string, model: string }): AIProvider {
  const url = chatCompletionsUrl(cfg.baseUrl)

  return {
    name: cfg.name,
    async complete(messages: AIMessage[], options?: AICompletionOptions): Promise<AICompletionResult> {
      // Чужой Anthropic-алиас (claude-haiku) шлюзу не годится — берём настроенную модель.
      const requested = options?.model
      const model = options?.gatewayModel || (requested && !requested.startsWith('claude-') ? requested : cfg.model)

      const chatMessages = buildChatMessages(messages, options?.system)
      const body: Record<string, unknown> = {
        model,
        messages: chatMessages,
        max_tokens: Math.max(options?.maxTokens || 4096, outputTokenFloor(model)),
        ...samplingFields(model, options?.temperature),
        ...thinkingFields(model, options?.noThinking),
      }
      if (options?.tools?.length) {
        body.tools = options.tools
        body.tool_choice = options.toolChoice ?? 'auto'
      }
      if (options?.jsonMode) body.response_format = { type: 'json_object' }
      applySystemCache(chatMessages, model, options?.cacheSystem, options?.systemTail)

      const attemptMs = attemptTimeoutMs(options, DEFAULT_TIMEOUT_MS)
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: requestSignal(attemptMs, options?.signal),
        })
      }
      catch (err) {
        throw new Error(`[${cfg.name}] ${sanitizeProviderErrorText(err instanceof Error ? err.message : String(err))}`)
      }

      if (!res.ok) {
        const errText = sanitizeProviderErrorText(await res.text().catch(() => ''))
        const wrapped = new Error(`[${cfg.name}] HTTP ${res.status}${errText ? `: ${errText}` : ''}`) as AIProviderError
        wrapped.statusCode = res.status
        if (isOutOfFunds(res.status, errText)) wrapped.outOfFunds = true
        throw wrapped
      }

      const response: any = await res.json()
      const choice = response?.choices?.[0]
      const text: string = choice?.message?.content || ''
      const usage: OpenAIUsage = response?.usage || {}
      const { toolCalls, rawToolCalls } = parseRawToolCalls(choice?.message?.tool_calls)
      const refused = choice?.finish_reason === 'content_filter'
        || (typeof choice?.message?.refusal === 'string' && choice.message.refusal.length > 0)

      // HTTP 200 без текста и без tool_calls — не успех.
      if (!text && !toolCalls?.length && !refused) {
        throw new Error(`[${cfg.name}] empty content (HTTP 200 без текста и без tool_calls, finish_reason=${choice?.finish_reason ?? 'n/a'})`)
      }

      return {
        text,
        inputTokens: usage.prompt_tokens || 0,
        ...cacheBreakdown(usage),
        outputTokens: usage.completion_tokens || 0,
        model,
        provider: cfg.name,
        ...(choice?.finish_reason === 'length' ? { truncated: true } : {}),
        ...(refused ? { refused: true } : {}),
        ...(toolCalls ? { toolCalls, rawToolCalls } : {}),
      }
    },
  }
}
