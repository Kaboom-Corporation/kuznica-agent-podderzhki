import { afterEach, describe, expect, it, vi } from 'vitest'
import { embedTexts, EmbeddingUnavailableError } from '../server/ported/rag/embeddings'
import { embedConfig, normalizeEmbedBase } from '../server/ported/rag/openai-base'

afterEach(() => vi.unstubAllGlobals())

describe('embedConfig', () => {
  it('значения по умолчанию', () => {
    const c = embedConfig({})
    expect(c).toEqual({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'bge-m3', dim: 1024 })
  })
  it('Ollama без /v1 дополняется', () => {
    expect(normalizeEmbedBase('http://host:11434/')).toBe('http://host:11434/v1')
  })
})

describe('embedTexts', () => {
  it('режет на пачки по 32 и сохраняет порядок', async () => {
    const calls: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const input = JSON.parse(init.body).input as string[]
      calls.push(input.length)
      const data = input.map((t, index) => ({ index, embedding: [t.length] })).reverse()
      return new Response(JSON.stringify({ data, usage: { prompt_tokens: input.length } }), { status: 200 })
    }))
    const texts = Array.from({ length: 70 }, (_, i) => 'x'.repeat(i + 1))
    const r = await embedTexts(texts)
    expect(calls).toEqual([32, 32, 6])
    expect(r.vectors.map(v => v[0])).toEqual(texts.map(t => t.length))
    expect(r.tokens).toBe(70)
  })

  it('сбой провайдера — EmbeddingUnavailableError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    await expect(embedTexts(['a'])).rejects.toBeInstanceOf(EmbeddingUnavailableError)
  })
})
