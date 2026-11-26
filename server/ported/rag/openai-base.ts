// Настройки OpenAI-совместимого эндпоинта эмбеддингов.
//
// Модуль ЧИСТЫЙ: читает только process.env, без useRuntimeConfig и прочих автоимпортов Nitro, поэтому работает и в
// сервере, и в скриптах (npm run ingest), которые запускаются голым node без сборщика Nuxt.
// Nuxt кладёт runtimeConfig.embed* из переменных NUXT_EMBED_BASE_URL / NUXT_EMBED_API_KEY / NUXT_EMBED_MODEL /
// NUXT_EMBED_DIM — их же читаем здесь напрямую.

export const DEFAULT_EMBED_BASE_URL = 'http://localhost:11434/v1'
export const DEFAULT_EMBED_MODEL = 'bge-m3'
export const DEFAULT_EMBED_DIM = 1024

export interface EmbedConfig {
  baseUrl: string
  apiKey: string
  model: string
  dim: number
}

/**
 * База эндпоинта: у Ollama OpenAI-совместимый путь требует суффикс /v1, без него `${base}/embeddings`
 * уходит на :11434/embeddings и даёт 404 — добавляем сами.
 */
export function normalizeEmbedBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (/:11434$/.test(trimmed)) return `${trimmed}/v1`
  return trimmed
}

export function embedConfig(env: Record<string, string | undefined> = process.env): EmbedConfig {
  const dim = Number(env.NUXT_EMBED_DIM)
  return {
    baseUrl: normalizeEmbedBase(env.NUXT_EMBED_BASE_URL || DEFAULT_EMBED_BASE_URL),
    apiKey: env.NUXT_EMBED_API_KEY || '',
    model: env.NUXT_EMBED_MODEL || DEFAULT_EMBED_MODEL,
    dim: Number.isFinite(dim) && dim > 0 ? dim : DEFAULT_EMBED_DIM,
  }
}
