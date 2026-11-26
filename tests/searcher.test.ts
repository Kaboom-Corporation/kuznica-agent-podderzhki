import { describe, expect, it } from 'vitest'
import { fuseRrf } from '../server/ported/rag/searcher'

const row = (id: number) => ({ chunk_id: id, slug: `s${id}`, title: 't', heading: null, content: 'c', source: 'x', valid_to: null })

describe('fuseRrf', () => {
  it('чанк, найденный двумя каналами, обгоняет найденный одним', () => {
    const hits = fuseRrf([
      { via: 'vector', rows: [row(1), row(2)] },
      { via: 'fulltext', rows: [row(2), row(3)] },
    ])
    expect(hits.map(h => h.chunkId)).toEqual([2, 1, 3])
    expect(hits[0]!.via).toEqual(['vector', 'fulltext'])
  })

  it('балл первой позиции — 1/(60+1)', () => {
    const [h] = fuseRrf([{ via: 'trigram', rows: [row(7)] }])
    expect(h!.score).toBeCloseTo(1 / 61, 10)
  })
})
