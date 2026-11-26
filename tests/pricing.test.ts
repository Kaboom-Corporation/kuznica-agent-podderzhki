import { describe, expect, it } from 'vitest'
import { costRub } from '../server/ported/ai/pricing'
import { RunTokenBudget, billableInputTokens } from '../server/ported/ai/run-budget'

describe('costRub', () => {
  it('haiku без кэша: вход + выход', () => {
    const c = costRub('anthropic/claude-haiku-5.5', { input: 1000, output: 100 })
    expect(c).toBeCloseTo(1000 * 1.070069e-05 + 100 * 5.350345e-05, 10)
  })

  it('кэш не считается дважды: input включает cacheRead и cacheWrite', () => {
    const c = costRub('anthropic/claude-haiku-5.5', { input: 1000, output: 0, cacheRead: 600, cacheWrite: 200 })
    const expected = 200 * 1.070069e-05 + 600 * 1.070069e-06 + 200 * 1.33758625e-05
    expect(c).toBeCloseTo(expected, 10)
  })

  it('модель без цены записи кэша: запись по цене входа', () => {
    const c = costRub('deepseek/deepseek-v4-flash', { input: 100, output: 0, cacheWrite: 100 })
    expect(c).toBeCloseTo(100 * 8.61405545e-06, 12)
  })

  it('прямой Anthropic = цена шлюза, ollama бесплатна', () => {
    const u = { input: 500, output: 50 }
    expect(costRub('claude-haiku-5-5', u)).toBe(costRub('anthropic/claude-haiku-5.5', u))
    expect(costRub('ollama/llama3', u)).toBe(0)
  })

  it('эмбеддинги: только вход', () => {
    expect(costRub('qwen/qwen3-embedding-8b', { input: 1000, output: 0 })).toBeCloseTo(1000 * 1.070069e-06, 12)
  })

  it('кэш больше входа зажимается', () => {
    const c = costRub('anthropic/claude-haiku-5.5', { input: 100, output: 0, cacheRead: 500 })
    expect(c).toBeCloseTo(100 * 1.070069e-06, 12)
  })
})

describe('RunTokenBudget', () => {
  it('оплачиваемый вход взвешен по кэшу', () => {
    expect(billableInputTokens({ inputTokens: 1000, outputTokens: 0, cachedInputTokens: 800 })).toBe(280)
  })

  it('копит токены и рубли', () => {
    const b = new RunTokenBudget(200_000)
    b.record({ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 500 }, 0, 0, 'anthropic/claude-haiku-5.5')
    expect(b.spent).toBe(500 + 50 + 100)
    expect(b.spentRub).toBeCloseTo(costRub('anthropic/claude-haiku-5.5', { input: 1000, output: 100, cacheRead: 500 }), 12)
  })
})
