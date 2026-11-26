// Эмбеддинги через OpenAI-совместимый POST {base}/embeddings (Ollama, vLLM, RouterAI, OpenAI).
// Работает вне Nitro: настройки из process.env (NUXT_EMBED_*), HTTP — глобальный fetch.

import { EmbeddingUnavailableError } from './embedding-error'
import { embedConfig } from './openai-base'

export { EmbeddingUnavailableError } from './embedding-error'

/** Размер пачки текстов в одном запросе. */
const BATCH_SIZE = 32
/** Таймаут одного HTTP-запроса: без него недоступная сеть вешает синхронный путь поиска и индексации. */
const EMBED_HTTP_TIMEOUT_MS = 15_000
/**
 * Предохранитель по длине входа. Чанки из chunker.ts ≤ 2000 символов, поэтому срабатывать не должен: если сработал —
 * текст пришёл мимо нарезки, и молча терять хвост нельзя.
 */
const EMBED_INPUT_LIMIT = 8000
const CHARS_PER_TOKEN = 3

function capEmbedInput(text: string): string {
  if (text.length <= EMBED_INPUT_LIMIT) return text
  console.warn(`[embeddings] Вход обрезан: ${text.length} → ${EMBED_INPUT_LIMIT} символов. Текст пришёл мимо chunker — часть данных не попадёт в вектор.`)
  return text.slice(0, EMBED_INPUT_LIMIT)
}

/** Размерность вектора текущей конфигурации (NUXT_EMBED_DIM, по умолчанию 1024 — bge-m3). */
export function getEmbeddingDim(): number {
  return embedConfig().dim
}

interface EmbeddingsResponse {
  data?: Array<{ index?: number, embedding: number[] }>
  usage?: { prompt_tokens?: number, total_tokens?: number }
}

async function embedBatch(batch: string[]): Promise<{ vectors: number[][], tokens: number }> {
  const cfg = embedConfig()
  const url = `${cfg.baseUrl}/embeddings`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // Ollama ключа не требует; шлюзам с ключом он нужен.
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: cfg.model, input: batch.map(capEmbedInput) }),
    signal: AbortSignal.timeout(EMBED_HTTP_TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)
    throw new Error(`HTTP ${res.status} от ${url}${text ? `: ${text}` : ''}`)
  }
  const json = await res.json() as EmbeddingsResponse
  const data = json.data
  if (!Array.isArray(data) || data.length !== batch.length) {
    throw new Error(`эндпоинт вернул ${Array.isArray(data) ? data.length : 0} векторов на ${batch.length} текстов`)
  }
  const vectors = [...data]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map(d => d.embedding)
  const tokens = json.usage?.prompt_tokens ?? json.usage?.total_tokens
    ?? Math.ceil(batch.reduce((n, t) => n + t.length, 0) / CHARS_PER_TOKEN)
  return { vectors, tokens }
}

/**
 * Эмбеддинги массива текстов пачками по 32. Возвращает векторы в порядке входа и число токенов (из usage провайдера,
 * либо оценка по символам). Сбой провайдера — EmbeddingUnavailableError.
 */
export async function embedTexts(texts: string[]): Promise<{ vectors: number[][], tokens: number }> {
  const vectors: number[][] = []
  let tokens = 0
  try {
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const r = await embedBatch(texts.slice(i, i + BATCH_SIZE))
      vectors.push(...r.vectors)
      tokens += r.tokens
    }
  }
  catch (err) {
    throw err instanceof EmbeddingUnavailableError ? err : new EmbeddingUnavailableError(err)
  }
  return { vectors, tokens }
}

/** Эмбеддинг одного текста. */
export async function embedText(text: string): Promise<{ vector: number[], tokens: number }> {
  const { vectors, tokens } = await embedTexts([text])
  return { vector: vectors[0]!, tokens }
}
