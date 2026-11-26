// Гибридный поиск по базе знаний: pgvector (cosine) + полнотекст (russian) + триграммы (pg_trgm),
// сведённые по RRF. Если эмбеддинги недоступны, молча остаются полнотекст и триграммы.

import { q } from '../../lib/db'
import { embedText } from './embeddings'

/** Константа RRF: чем больше, тем меньше вес верхних позиций каждого списка. */
export const RRF_K = 60
/** Минимальная word_similarity, с которой триграммный кандидат допускается в выдачу. */
const TRGM_MIN = 0.3

export interface KbHit {
  chunkId: number
  slug: string
  title: string
  heading: string | null
  content: string
  /** Суммарный RRF-балл. */
  score: number
  source: string
  /** Дата окончания действия документа (YYYY-MM-DD) или null, если действует бессрочно. */
  validTo: string | null
  /** Какие каналы нашли чанк: 'vector' | 'fulltext' | 'trigram'. */
  via: string[]
}

export interface KbSearchResult {
  hits: KbHit[]
  embedTokens: number
}

interface Row {
  chunk_id: number
  slug: string
  title: string
  heading: string | null
  content: string
  source: string
  valid_to: string | null
}

const SELECT = `kc.id AS chunk_id, kd.slug, kd.title, kc.heading, kc.content, kd.source,
       to_char(kd.valid_to, 'YYYY-MM-DD') AS valid_to`
const FROM = `kb_chunks kc JOIN kb_documents kd ON kd.id = kc.document_id`

function currentFilter(includeExpired: boolean): string {
  return includeExpired ? 'TRUE' : '(kd.valid_to IS NULL OR kd.valid_to >= current_date)'
}

/** Литерал pgvector из массива чисел. */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`
}

/**
 * Слияние ранжированных списков по Reciprocal Rank Fusion: score = Σ 1/(k + rank), rank с 1.
 * Чистая функция, вынесена для теста.
 */
export function fuseRrf(lists: Array<{ via: string, rows: Row[] }>, k = RRF_K): KbHit[] {
  const byId = new Map<number, KbHit>()
  for (const { via, rows } of lists) {
    rows.forEach((r, i) => {
      const add = 1 / (k + i + 1)
      const hit = byId.get(r.chunk_id)
      if (hit) {
        hit.score += add
        hit.via.push(via)
      }
      else {
        byId.set(r.chunk_id, {
          chunkId: r.chunk_id,
          slug: r.slug,
          title: r.title,
          heading: r.heading,
          content: r.content,
          score: add,
          source: r.source,
          validTo: r.valid_to,
          via: [via],
        })
      }
    })
  }
  return [...byId.values()].sort((a, b) => b.score - a.score)
}

/**
 * Гибридный поиск. По умолчанию только действующие документы (valid_to пуст или не раньше сегодняшней даты);
 * includeExpired возвращает и просроченные.
 */
export async function searchKb(
  query: string,
  opts: { limit?: number, includeExpired?: boolean } = {},
): Promise<KbSearchResult> {
  const limit = opts.limit ?? 5
  const pool = Math.max(limit * 4, 20)
  const filter = currentFilter(opts.includeExpired === true)
  const text = query.trim()
  if (!text) return { hits: [], embedTokens: 0 }

  let embedTokens = 0
  let vectorRows: Row[] = []
  try {
    const { vector, tokens } = await embedText(text)
    embedTokens = tokens
    vectorRows = await q<Row>(
      `SELECT ${SELECT} FROM ${FROM}
        WHERE kc.embedding IS NOT NULL AND ${filter}
        ORDER BY kc.embedding <=> $1::vector
        LIMIT $2`,
      [toVectorLiteral(vector), pool],
    )
  }
  catch (err) {
    // Эмбеддинги недоступны — работаем без векторного канала.
    console.warn('[searchKb] векторный канал пропущен:', err instanceof Error ? err.message : err)
  }

  const fulltextRows = await q<Row>(
    `SELECT ${SELECT} FROM ${FROM}
      WHERE kc.tsv @@ websearch_to_tsquery('russian', $1) AND ${filter}
      ORDER BY ts_rank_cd(kc.tsv, websearch_to_tsquery('russian', $1)) DESC
      LIMIT $2`,
    [text, pool],
  )

  const trigramRows = await q<Row>(
    `SELECT ${SELECT} FROM ${FROM}
      WHERE word_similarity($1, kc.content) >= $3 AND ${filter}
      ORDER BY word_similarity($1, kc.content) DESC
      LIMIT $2`,
    [text, pool, TRGM_MIN],
  )

  const hits = fuseRrf([
    { via: 'vector', rows: vectorRows },
    { via: 'fulltext', rows: fulltextRows },
    { via: 'trigram', rows: trigramRows },
  ]).slice(0, limit)

  return { hits, embedTokens }
}
