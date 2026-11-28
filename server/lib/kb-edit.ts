import { createError, getRouterParam, type H3Event } from 'h3'
import { db, q, q1 } from './db'
import { chunkMarkdown } from '../ported/rag/chunker'
import { embedTexts } from '../ported/rag/embeddings'

/**
 * Правка базы знаний из панели менеджера: статья — markdown, при сохранении режется на куски
 * тем же нарезчиком, что и загрузка (scripts/ingest.ts), и заново получает эмбеддинги.
 * Статьи, созданные или исправленные в панели, помечаются source = 'panel:…' —
 * перезаливка базы магазина их не затирает (см. ingest.ts).
 */
export interface KbListItem { id: number; slug: string; title: string; kind: 'store' | 'panel' | 'learned'; chunks: number; updated_at: string; preview: string | null; headings: string[] | null }
export interface KbDoc { id: number; slug: string; title: string; kind: KbListItem['kind']; content: string; updated_at: string }

export const KB_TITLE_MAX = 200
export const KB_CONTENT_MAX = 40_000

const KIND_SQL = `case when source like 'manager:%' then 'learned' when source like 'panel:%' then 'panel' else 'store' end`

export async function listKb(): Promise<KbListItem[]> {
  return q<KbListItem>(
    `select d.id, d.slug, d.title, ${KIND_SQL} as kind, count(c.id)::int as chunks, d.updated_at,
            (select left(content, 180) from kb_chunks where document_id = d.id order by idx limit 1) as preview,
            (select array_agg(heading order by idx) from kb_chunks where document_id = d.id and heading is not null) as headings
       from kb_documents d left join kb_chunks c on c.document_id = d.id
      group by d.id order by d.title`,
  )
}

/** Текст статьи обратно из кусков: заголовок раздела — строкой «## …», как в исходном markdown. */
export function joinChunks(chunks: { heading: string | null; content: string }[]): string {
  const parts: string[] = []
  let last: string | null = null
  for (const c of chunks) {
    if (c.heading && c.heading !== last) parts.push(`## ${c.heading}`)
    last = c.heading
    parts.push(c.content.trim())
  }
  return parts.join('\n\n')
}

export async function getKb(id: number): Promise<KbDoc | null> {
  const doc = await q1<Omit<KbDoc, 'content'>>(`select id, slug, title, ${KIND_SQL} as kind, updated_at from kb_documents where id = $1`, [id])
  if (!doc) return null
  const chunks = await q<{ heading: string | null; content: string }>(`select heading, content from kb_chunks where document_id = $1 order by idx`, [id])
  return { ...doc, content: joinChunks(chunks) }
}

export function validateKb(title: unknown, content: unknown): { title: string; content: string } {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim()
  const c = String(content ?? '').replace(/\r\n/g, '\n').trim()
  if (!t) throw createError({ statusCode: 400, statusMessage: 'Нужен заголовок' })
  if (t.length > KB_TITLE_MAX) throw createError({ statusCode: 400, statusMessage: `Заголовок длиннее ${KB_TITLE_MAX} знаков` })
  if (c.length < 20) throw createError({ statusCode: 400, statusMessage: 'Текст статьи слишком короткий' })
  if (c.length > KB_CONTENT_MAX) throw createError({ statusCode: 400, statusMessage: `Текст длиннее ${KB_CONTENT_MAX} знаков` })
  return { title: t, content: c }
}

/** Сохранить статью: id нет — новая. Возвращает id и число кусков. */
export async function saveKb(id: number | null, title: string, content: string): Promise<{ id: number; chunks: number }> {
  const chunks = chunkMarkdown(content).filter(c => c.content.trim())
  if (!chunks.length) throw createError({ statusCode: 400, statusMessage: 'В статье нет текста' })
  // Эмбеддинги — до транзакции; узел недоступен — куски ищутся полнотекстом, как при загрузке
  let vectors: number[][] = []
  try {
    vectors = (await embedTexts(chunks.map(c => `${title}. ${c.heading ?? ''}\n${c.content}`))).vectors
  }
  catch {}
  const client = await db().connect()
  try {
    await client.query('begin')
    let docId = id
    if (docId == null) {
      const slug = `panel-${Date.now().toString(36)}`
      const r = await client.query<{ id: number }>(
        `insert into kb_documents (slug, title, source) values ($1, $2, 'panel:new') returning id`, [slug, title])
      docId = r.rows[0]!.id
    }
    else {
      // Статья магазина после правки помечается panel:edit:<исходник> — перезаливка её не затрёт
      const r = await client.query(
        `update kb_documents
            set title = $2, updated_at = now(),
                source = case when source like 'manager:%' or source like 'panel:%' then source else 'panel:edit:' || source end
          where id = $1`, [docId, title])
      if (!r.rowCount) throw createError({ statusCode: 404, statusMessage: 'Статья не найдена' })
      await client.query(`delete from kb_chunks where document_id = $1`, [docId])
    }
    for (const [i, c] of chunks.entries()) {
      const v = vectors[i]
      await client.query(
        `insert into kb_chunks (document_id, idx, heading, content, embedding) values ($1, $2, $3, $4, $5)`,
        [docId, i, c.heading, c.content, v ? `[${v.join(',')}]` : null],
      )
    }
    await client.query('commit')
    return { id: docId, chunks: chunks.length }
  }
  catch (e) {
    await client.query('rollback')
    throw e
  }
  finally {
    client.release()
  }
}

export function kbIdParam(event: H3Event): number {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'неверный id' })
  return id
}

export async function deleteKb(id: number): Promise<boolean> {
  const rows = await q(`delete from kb_documents where id = $1 returning id`, [id])
  return rows.length > 0
}
