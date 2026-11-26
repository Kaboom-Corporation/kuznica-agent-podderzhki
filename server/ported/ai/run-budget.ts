/**
 * Бюджет одного запуска цикла агента (модель вызывает инструменты, результат каждого уходит в историю).
 *
 * Проблема: результат инструмента целиком уходит в историю цикла, а каждая следующая итерация пересылает модели всю
 * накопленную историю заново, поэтому стоимость запуска растёт примерно как квадрат числа шагов. Два предохранителя,
 * оба без сети и БД:
 *  - capToolPayload — потолок символов на результат ОДНОГО инструмента в истории модели;
 *  - RunTokenBudget — потолок токенов на весь запуск: итерации с инструментами плюс итоговый ответ.
 *
 * Считаются ОПЛАЧИВАЕМЫЕ токены, а не сырой объём запроса. Постоянная часть запроса (system и описания инструментов)
 * пересылается на каждой итерации, но не меняется и кэшируется: чтение из кэша стоит 0,1 обычного входного токена,
 * запись — 1,25. Бюджет, считающий сырой вход, пропускал бы втрое меньше шагов, чем позволяют деньги.
 *
 * Новая часть поверх наработки: рядом с токенами бюджет копит рубли (spentRub) по ценам из ./pricing.
 */

import { costRub } from './pricing'
import type { AIMessage } from './provider'

/** Результат одного инструмента для модели, символов. В токенах это ~8–12 тыс. */
export const DEFAULT_MAX_TOOL_PAYLOAD_CHARS = 30_000
/** Меньше нельзя: в ответ должны влезть инструкция модели и хоть какое-то начало результата. */
export const MIN_TOOL_PAYLOAD_CHARS = 2_000
/** ОПЛАЧИВАЕМЫХ токенов на один запуск: вход (взвешенный по кэшу) + выход всех вызовов, включая итоговый ответ. */
export const DEFAULT_MAX_RUN_TOKENS = 200_000
export const MIN_RUN_TOKENS = 10_000
/** Оценка, когда провайдер не вернул usage: ~3 символа на токен (кириллица и JSON дают 2,5–4). */
export const CHARS_PER_TOKEN = 3
/** Веса входных токенов: чтение из кэша промпта — 0,1 цены обычного входного токена, запись в кэш — 1,25. */
export const CACHE_READ_WEIGHT = 0.1
export const CACHE_WRITE_WEIGHT = 1.25
/** Запас под ответы модели: ход с инструментами (maxTokens 4096) + итоговый ответ (maxTokens 1024). */
export const OUTPUT_RESERVE_TOKENS = 5_000

type Env = Record<string, string | undefined>

/**
 * Целое из env. Пусто, не число или ≤ 0 → fallback (0 не значит «без лимита»: снять предохранитель так нельзя).
 * Меньше min → min. Разделители разрядов «_» и пробелы допустимы: «200_000».
 */
export function readLimit(raw: string | undefined, fallback: number, min: number): number {
  const s = (raw ?? '').replace(/[\s_]/g, '')
  if (!s) return fallback
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(min, Math.floor(n))
}

export function maxToolPayloadChars(env: Env = process.env): number {
  return readLimit(env.AGENT_MAX_TOOL_PAYLOAD_CHARS, DEFAULT_MAX_TOOL_PAYLOAD_CHARS, MIN_TOOL_PAYLOAD_CHARS)
}

export function maxRunTokens(env: Env = process.env): number {
  return readLimit(env.AGENT_MAX_RUN_TOKENS, DEFAULT_MAX_RUN_TOKENS, MIN_RUN_TOKENS)
}

export function charsToTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN)
}

/** Размер запроса к модели в символах: постоянная часть (system, определения инструментов) плюс история. */
export function requestChars(messages: AIMessage[], fixedChars: number): number {
  let n = fixedChars
  for (const m of messages) {
    n += m.content?.length ?? 0
    for (const tc of m.tool_calls ?? []) n += tc.function.name.length + tc.function.arguments.length
  }
  return n
}

/** Размер ответа модели в символах: текст и аргументы вызовов инструментов. */
export function responseChars(r: { text: string, rawToolCalls?: AIMessage['tool_calls'] }): number {
  let n = r.text?.length ?? 0
  for (const tc of r.rawToolCalls ?? []) n += tc.function.name.length + tc.function.arguments.length
  return n
}

// ── Потолок результата инструмента ───────────────────────────────

export interface CappedPayload {
  /** Что уходит модели: исходный JSON или JSON-обёртка с началом результата. Всегда валидный JSON. */
  body: string
  truncated: boolean
  /** Длина исходного JSON результата. */
  totalChars: number
}

/** Запас под поля обёртки и инструкцию при первом приближении (дальше подгоняется по факту). */
const ENVELOPE_GUESS = 1_500

/** Результат инструмента в JSON-строку. BigInt и циклические ссылки не роняют шаг: модель узнаёт причину. */
export function stringifyToolPayload(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  }
  catch {
    return JSON.stringify({ error: 'Результат инструмента не удалось сериализовать в JSON.' })
  }
}

/** Начало строки длиной до n, не разрывая суррогатную пару (эмодзи) на конце. */
function cutPreview(s: string, n: number): string {
  if (n >= s.length) return s
  let end = Math.max(0, n)
  const code = end > 0 ? s.charCodeAt(end - 1) : 0
  if (code >= 0xD800 && code <= 0xDBFF) end--
  return s.slice(0, end)
}

/** Пометку верификатора («результат не подтвердился в БД») не теряем: она в конце объекта и при обрезке ушла бы. */
function pickVerification(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  return (payload as Record<string, unknown>)._verification
}

export function truncationInstruction(toolName: string, totalChars: number, shownChars: number): string {
  return `Результат ${toolName} слишком большой (${totalChars} символов) и обрезан: в preview только начало`
    + ` (${shownChars} символов) — кусок JSON, оборванный на середине. НЕ делай выводов о том, чего нет в показанной части:`
    + ' остального ты не видел. Нужны данные дальше — запроси точечно: поиск по тексту или фильтр, конкретная запись'
    + ' по id, повтор с меньшим limit (с того же offset), постранично. Если называешь количества и итоги —'
    + ' только по прочитанному и с пометкой, что данные неполные.'
}

/**
 * Результат инструмента для истории модели. Влезает в maxChars — уходит как есть. Не влезает — уходит JSON-обёртка
 * `{ truncated, tool, totalChars, shownChars, instruction, _verification?, preview }`, где preview — начало исходного
 * JSON строкой. Режется строка-превью, а не сериализованный объект, поэтому тело всегда валидный JSON; длина тела
 * (вместе с экранированием кавычек в превью) не больше maxChars.
 */
export function capToolPayload(toolName: string, payload: unknown, maxChars: number): CappedPayload {
  const full = stringifyToolPayload(payload)
  if (full.length <= maxChars) return { body: full, truncated: false, totalChars: full.length }

  const verification = pickVerification(payload)
  const build = (n: number): string => {
    const preview = cutPreview(full, n)
    return JSON.stringify({
      truncated: true,
      tool: toolName,
      totalChars: full.length,
      shownChars: preview.length,
      instruction: truncationInstruction(toolName, full.length, preview.length),
      ...(verification !== undefined ? { _verification: verification } : {}),
      preview,
    })
  }
  // Экранирование (кавычки, обратные слэши, управляющие символы) раздувает превью — подгоняем по факту:
  // уменьшаем пропорционально тому, во сколько символов тела обошёлся один символ превью.
  let n = Math.max(0, maxChars - ENVELOPE_GUESS)
  let body = build(n)
  const overhead = body.length > maxChars ? build(0).length : 0
  for (let i = 0; i < 12 && body.length > maxChars && n > 0; i++) {
    const perChar = Math.max(1, (body.length - overhead) / n)
    n = Math.max(0, Math.min(n - 1, Math.floor((maxChars - overhead) / perChar) - 16))
    body = build(n)
  }
  return { body, truncated: true, totalChars: full.length }
}

// ── Бюджет токенов на запуск ─────────────────────────────────────

export interface UsageLike {
  /** Весь вход вызова вместе с кэшем (как prompt_tokens OpenAI; claude.ts приводит Anthropic к тому же виду). */
  inputTokens: number
  outputTokens: number
  /** Сколько из inputTokens прочитано из кэша промпта. ЧАСТЬ входа, а не добавка. undefined — разбивки нет. */
  cachedInputTokens?: number
  /** Сколько из inputTokens записано в кэш промпта. Тоже ЧАСТЬ входа. */
  cacheWriteInputTokens?: number
}

/**
 * Оплачиваемые токены входа одного вызова: не покрытая кэшем часть по полной цене, прочитанное из кэша — 0,1,
 * записанное — 1,25. Округление вверх — считаем в свою пользу.
 *
 * Разбивки нет → вход как есть. Разбивка больше входа (провайдер соврал или задваивает cached_tokens) → зажимаем:
 * ни «свежая» часть не уходит в минус, ни кэш не раздувает расход сверх размера самого запроса.
 */
export function billableInputTokens(usage: UsageLike): number {
  const total = Math.max(0, usage.inputTokens)
  const read = Math.min(Math.max(0, usage.cachedInputTokens ?? 0), total)
  const write = Math.min(Math.max(0, usage.cacheWriteInputTokens ?? 0), total - read)
  const fresh = total - read - write
  return Math.ceil(fresh + CACHE_READ_WEIGHT * read + CACHE_WRITE_WEIGHT * write)
}

/** Оплачиваемые токены вызова (вход с учётом кэша + выход). Без кэш-разбивки равен inputTokens + outputTokens. */
export function billableTotalTokens(usage: UsageLike): number {
  return billableInputTokens(usage) + Math.max(0, usage.outputTokens)
}

/**
 * Счётчик токенов одного запуска. Источник — usage провайдера; провайдер вернул 0 (mock, стрим без usage) — оценка по
 * символам (CHARS_PER_TOKEN).
 *
 * spent — ОПЛАЧИВАЕМЫЕ токены (вход взвешен по кэшу, выход как есть); inputTokens/outputTokens/rawSpent — сырые,
 * для журнала. spentRub — деньги по ценам модели (только вызовы, где передана модель).
 *
 * Решение «ещё одна итерация или итог» принимается ДО вызова модели: итерация пересылает всю историю, и итоговый
 * ответ после неё — тоже. Поэтому итерация разрешена, только если в остатке помещаются две такие пересылки и запас
 * под ответы.
 */
export class RunTokenBudget {
  readonly limit: number
  /** Оплачиваемые токены запуска — то, с чем сравнивается limit. */
  spent = 0
  /** Потрачено рублей по ценам моделей (см. ./pricing). */
  spentRub = 0
  /** Сырой вход всех вызовов, вместе с кэшем (объём пересылки, не деньги). */
  inputTokens = 0
  outputTokens = 0
  /** Сырой расход вход+выход: рядом со spent в журнале видно, сколько сэкономил кэш. */
  rawSpent = 0
  cachedInputTokens = 0
  /** Сколько входных токенов за запуск ушло в ЗАПИСЬ кэша. Запись есть, чтения нет — кэш не попадает. */
  cacheWriteInputTokens = 0
  /** Разбивка входа по вызовам [вход, из кэша, в кэш] — для журнала. */
  readonly perCall: Array<[number, number, number]> = []
  calls = 0
  /** Побочных вызовов (recordAside), например чтение большого результата отдельным агентом. */
  asideCalls = 0
  /** Вызовов, где хотя бы одна часть usage посчитана по символам (провайдер её не вернул). */
  estimatedCalls = 0
  private lastBillableInput = 0
  private lastChars = 0
  /** Сколько прошлый вызов цикла ЗАПИСАЛ в кэш: в следующем вызове этот префикс читается, а не пишется заново. */
  private lastCacheWrite = 0

  constructor(limit: number) {
    this.limit = limit
  }

  /** Учесть вызов модели. sentChars — размер запроса (requestChars), receivedChars — ответа (responseChars). */
  record(usage: UsageLike, sentChars: number, receivedChars: number, model?: string): number {
    const spent = this.tally(usage, sentChars, receivedChars, model)
    this.lastBillableInput = spent.billableInput
    this.lastChars = sentChars
    this.lastCacheWrite = spent.write
    return spent.billable
  }

  /**
   * Учесть ПОБОЧНЫЙ вызов модели: не итерацию цикла, а вспомогательный разбор. Деньги общие, поэтому spent и счётчики
   * те же. Прогноз следующей итерации такой вызов НЕ сдвигает: у него другой размер и нет кэша постоянной части,
   * от него оценка следующей итерации уехала бы в разы.
   */
  recordAside(usage: UsageLike, sentChars: number, receivedChars: number, model?: string): number {
    this.asideCalls++
    return this.tally(usage, sentChars, receivedChars, model).billable
  }

  private tally(usage: UsageLike, sentChars: number, receivedChars: number, model?: string): { billable: number, billableInput: number, write: number } {
    const inReported = usage.inputTokens > 0
    const outReported = usage.outputTokens > 0
    const input = inReported ? usage.inputTokens : charsToTokens(sentChars)
    const output = outReported ? usage.outputTokens : charsToTokens(receivedChars)
    // Вход посчитан по символам — разбивка по кэшу к нему не относится: берём как есть.
    const billableInput = inReported ? billableInputTokens({ ...usage, inputTokens: input }) : input
    if (!inReported || !outReported) this.estimatedCalls++
    this.calls++
    this.inputTokens += input
    this.outputTokens += output
    const read = inReported ? Math.min(Math.max(0, usage.cachedInputTokens ?? 0), input) : 0
    const write = inReported ? Math.min(Math.max(0, usage.cacheWriteInputTokens ?? 0), input - read) : 0
    this.cachedInputTokens += read
    this.cacheWriteInputTokens += write
    if (this.perCall.length < 20) this.perCall.push([input, read, write])
    this.rawSpent += input + output
    this.spent += billableInput + output
    if (model) this.spentRub += costRub(model, { input, output, cacheRead: read, cacheWrite: write })
    return { billable: billableInput + output, billableInput, write }
  }

  /**
   * Сколько ОПЛАЧИВАЕМЫХ токенов будет на входе следующего вызова. Первый вызов — по символам. Дальше — оплачиваемый
   * вход прошлого вызова плюс прирост истории с тех пор (новое кэш не покрывает). Прирост может быть отрицательным
   * (историю сворачивает сжатие), поэтому разница считается со знаком.
   *
   * Вызов ЗАПИСАЛ кэш — в следующем этот же префикс будет ПРОЧИТАН: записанное считаем по цене чтения, а не записи.
   * Прогноз оптимистичен (считает, что кэш сработает снова); промах защиту не пробивает: canAffordIteration требует
   * вместить ДВЕ пересылки плюс запас, а следующий прогноз промах уже увидит.
   */
  estimateNextInput(sentChars: number): number {
    if (this.calls === 0) return charsToTokens(sentChars)
    const delta = Math.ceil((sentChars - this.lastChars) / CHARS_PER_TOKEN)
    const rewrite = Math.round((CACHE_WRITE_WEIGHT - CACHE_READ_WEIGHT) * this.lastCacheWrite)
    return Math.max(0, this.lastBillableInput - rewrite + delta)
  }

  /** Можно ли сделать ещё одну итерацию и после неё всё ещё уложиться с итоговым ответом. */
  canAffordIteration(sentChars: number): boolean {
    const next = this.estimateNextInput(sentChars)
    return this.spent + 2 * next + OUTPUT_RESERVE_TOKENS <= this.limit
  }

  /**
   * Сколько символов истории нужно освободить, чтобы ещё одна итерация прошла по бюджету (0 — она проходит и так).
   * Обратная задача к canAffordIteration: вход следующего вызова должен уложиться в половину остатка.
   */
  charsToFreeForIteration(sentChars: number): number {
    const next = this.estimateNextInput(sentChars)
    const allowed = Math.floor((this.limit - this.spent - OUTPUT_RESERVE_TOKENS) / 2)
    if (next <= allowed) return 0
    return (next - allowed) * CHARS_PER_TOKEN
  }
}

// ── Тексты для остановки по бюджету ──────────────────────────────

/** Сколько и каких шагов сделано: «7 (Поиск по базе ×6, Расчёт цены)». Метка — до первого двоеточия. */
export function describeSteps(executed: string[]): string {
  if (executed.length === 0) return 'ни одного — инструменты не вызывались'
  const counts = new Map<string, number>()
  for (const e of executed) {
    const label = e.split(':')[0]?.trim() || e
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return `${executed.length} (${[...counts].map(([l, c]) => (c > 1 ? `${l} ×${c}` : l)).join(', ')})`
}

/** Запрос итогового ответа, когда цикл остановлен бюджетом: что успели, чего нет, как сузить. */
export function budgetStopPrompt(executed: string[]): string {
  return 'Лимит объёма на этот запрос исчерпан: инструменты больше вызывать нельзя. Ответь пользователю по тому, что уже'
    + ' получено: что удалось выяснить и сделать и что НЕ успел прочитать или проверить. Частичные данные не выдавай за'
    + ' полные: количества, проценты и выводы — только по прочитанному и с пометкой, что это часть. Предложи, как сузить'
    + ' запрос. Кратко на русском, обычным текстом: без вызовов инструментов, без разметки вызовов и без служебных имён'
    + ` инструментов.\n\nУспел выполнить шагов: ${describeSteps(executed)}.`
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

/** Пометка пользователю в конце ответа — не зависит от того, послушалась ли модель. */
export function budgetStopNote(steps: number, limit: number): string {
  const limitText = `${Math.round(limit / 1000)} тыс.`
  const when = steps > 0 ? `после ${steps} ${plural(steps, 'шага', 'шагов', 'шагов')}` : 'ещё до вызова инструментов'
  return `\n\n⚠️ Запрос оказался слишком объёмным: агент остановился на лимите одного запроса (${limitText} токенов)`
    + ` ${when} и ответил по тому, что успел прочитать, — выводы могут быть неполными.`
    + ' Чтобы получить полный ответ, сузьте запрос.'
}
