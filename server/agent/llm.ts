/**
 * Выбор модели. Все три пути говорят по OpenAI-совместимому протоколу с инструментами:
 *  - gateway   — RouterAI/OpenRouter (NUXT_LLM_BASE_URL + NUXT_LLM_API_KEY), цены в ₽ из прайса шлюза;
 *  - anthropic — прямой Anthropic через его OpenAI-совместимую точку (NUXT_ANTHROPIC_API_KEY);
 *  - ollama    — локальная модель (NUXT_OLLAMA_BASE_URL, по умолчанию localhost:11434), 0 ₽.
 * NUXT_LLM_PROVIDER выбирает явно; иначе первый настроенный по этому порядку.
 */
import { createOpenAICompatProvider } from '../ported/ai/openai-compat'
import type { AIProvider } from '../ported/ai/provider'

export interface Llm {
  provider: AIProvider
  kind: 'gateway' | 'anthropic' | 'ollama'
  /** id модели для запроса */
  model: string
  /** id модели для прайса (costRub) */
  priceId: string
  /** таймаут одного вызова */
  timeoutMs: number
}

const env = (k: string) => (process.env[k] ?? '').trim()

export function pickLlm(override?: Partial<{ kind: Llm['kind']; model: string }>): Llm {
  const kind = override?.kind
    || (env('NUXT_LLM_PROVIDER') as Llm['kind'])
    || (env('NUXT_LLM_API_KEY') ? 'gateway' : env('NUXT_ANTHROPIC_API_KEY') ? 'anthropic' : 'ollama')

  if (kind === 'gateway') {
    const model = override?.model || env('NUXT_LLM_MODEL') || 'anthropic/claude-haiku-5.5'
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
  if (kind === 'anthropic') {
    const model = override?.model || env('NUXT_ANTHROPIC_MODEL') || 'claude-haiku-5-5'
    return {
      kind,
      model,
      priceId: model,
      timeoutMs: 60_000,
      provider: createOpenAICompatProvider({
        name: 'anthropic',
        baseUrl: env('NUXT_ANTHROPIC_BASE_URL') || 'https://api.anthropic.com/v1',
        apiKey: env('NUXT_ANTHROPIC_API_KEY'),
        model,
      }),
    }
  }
  const model = override?.model || env('NUXT_OLLAMA_MODEL') || 'qwen3:8b'
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
