/**
 * Цены моделей в рублях за ОДИН токен (прайс шлюза RouterAI на 26.11.2026, с НДС).
 * Новая часть поверх наработки: перевод usage провайдера в рубли.
 *
 * Прямой Anthropic (id `claude-haiku-5-5`, без префикса) отдан по тем же ценам, что `anthropic/claude-haiku-5.5`
 * через шлюз: настоящий прайс Anthropic в долларах, здесь он приближён рублёвым прайсом шлюза. Для точного учёта
 * при работе напрямую цены надо заменить.
 */

export interface ModelPrice {
  /** Обычный (не кэшированный) входной токен. */
  prompt: number
  /** Выходной токен. */
  completion: number
  /** Чтение из кэша промпта. Нет — кэш этой модели не оплачивается отдельно, берётся prompt. */
  cache_read?: number
  /** Запись в кэш промпта. Нет — берётся prompt. */
  cache_write?: number
}

export const MODEL_PRICES_RUB: Readonly<Record<string, ModelPrice>> = {
  'anthropic/claude-haiku-5.5': {
    prompt: 1.070069e-05,
    completion: 5.350345e-05,
    cache_read: 1.070069e-06,
    cache_write: 1.33758625e-05,
  },
  'anthropic/claude-sonnet-5.5': {
    prompt: 2.140138e-04,
    completion: 1.070069e-03,
    cache_read: 1.070069e-05,
    cache_write: 2.6751725e-04,
  },
  'deepseek/deepseek-v4-flash': {
    prompt: 8.61405545e-06,
    completion: 1.72281109e-05,
    cache_read: 1.72281109e-06,
  },
  'qwen/qwen3-embedding-8b': {
    prompt: 1.070069e-06,
    completion: 0,
  },
}

// Прямой Anthropic: те же цены, что у шлюза (см. примечание в шапке).
const DIRECT_ALIASES: Readonly<Record<string, string>> = {
  'claude-haiku-5-5': 'anthropic/claude-haiku-5.5',
  'claude-sonnet-5-5': 'anthropic/claude-sonnet-5.5',
}

const FREE: ModelPrice = { prompt: 0, completion: 0 }
const warned = new Set<string>()

/** Цена модели. Локальные `ollama/*` бесплатны; неизвестная модель — ноль с одним предупреждением в лог. */
export function priceOf(model: string): ModelPrice {
  const id = DIRECT_ALIASES[model] ?? model
  const hit = MODEL_PRICES_RUB[id]
  if (hit) return hit
  if (id.startsWith('ollama/')) return FREE
  if (!warned.has(id)) {
    warned.add(id)
    console.warn(`[pricing] нет цены для модели «${id}», стоимость считается нулём`)
  }
  return FREE
}

/**
 * Стоимость одного вызова в рублях. input — ВЕСЬ вход вместе с кэшем (как prompt_tokens): cacheRead и cacheWrite —
 * его части, поэтому обычная цена берётся только с остатка, и кэш не считается дважды.
 */
export function costRub(
  model: string,
  u: { input: number, output: number, cacheRead?: number, cacheWrite?: number },
): number {
  const p = priceOf(model)
  const input = Math.max(0, u.input)
  const read = Math.min(Math.max(0, u.cacheRead ?? 0), input)
  const write = Math.min(Math.max(0, u.cacheWrite ?? 0), input - read)
  const fresh = input - read - write
  return fresh * p.prompt
    + read * (p.cache_read ?? p.prompt)
    + write * (p.cache_write ?? p.prompt)
    + Math.max(0, u.output) * p.completion
}
