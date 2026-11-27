/**
 * Выбор модели. Требование заказчика (чат задачи 27.11): только модели с открытыми весами
 * (Apache 2.0 или похожая лицензия), не больше 128 ГБ видеопамяти при квантовании от Q4.
 * Оба пути говорят по OpenAI-совместимому протоколу с инструментами:
 *  - ollama  — по умолчанию: своя модель на своём сервере (NUXT_OLLAMA_BASE_URL, NUXT_OLLAMA_MODEL,
 *              по умолчанию qwen3.5:9b, Apache 2.0), 0 ₽ за запрос, данные клиентов не уходят наружу;
 *  - gateway — та же открытая модель у провайдера (NUXT_LLM_BASE_URL + NUXT_LLM_API_KEY + NUXT_LLM_MODEL),
 *              если своего сервера с видеокартой нет. Модель задаётся явно — закрытой по умолчанию нет.
 * NUXT_LLM_PROVIDER выбирает явно; иначе ollama.
 */
import { createOpenAICompatProvider } from '../ported/ai/openai-compat'
import type { AIProvider } from '../ported/ai/provider'

export interface Llm {
  provider: AIProvider
  kind: 'gateway' | 'ollama'
  /** id модели для запроса */
  model: string
  /** id модели для прайса (costRub) */
  priceId: string
  /** таймаут одного вызова */
  timeoutMs: number
}

const env = (k: string) => (process.env[k] ?? '').trim()

export function pickLlm(override?: Partial<{ kind: Llm['kind']; model: string }>): Llm {
  const kind = override?.kind || (env('NUXT_LLM_PROVIDER') as Llm['kind']) || 'ollama'

  if (kind === 'gateway') {
    const model = override?.model || env('NUXT_LLM_MODEL')
    if (!model) throw new Error('NUXT_LLM_PROVIDER=gateway: задайте NUXT_LLM_MODEL — открытую модель провайдера')
    return {
      kind,
      model,
      priceId: model,
      timeoutMs: 60_000,
      provider: createOpenAICompatProvider({
        name: 'gateway',
        baseUrl: env('NUXT_LLM_BASE_URL') || 'https://routerai.ru/api/v1',
        apiKey: env('NUXT_LLM_API_KEY'),
        model,
      }),
    }
  }
  const model = override?.model || env('NUXT_OLLAMA_MODEL') || 'qwen3.5:9b'
  return {
    kind: 'ollama',
    model,
    priceId: `ollama/${model}`,
    // локальная модель на большом промпте с инструментами думает долго
    timeoutMs: 120_000,
    provider: createOpenAICompatProvider({
      name: 'ollama',
      baseUrl: env('NUXT_OLLAMA_BASE_URL') || 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model,
    }),
  }
}
