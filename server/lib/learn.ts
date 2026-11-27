import { db } from './db'
import { maskPii } from '../ported/ai/pii/mask'
import { embedTexts } from '../ported/rag/embeddings'

/**
 * Агент учится на ответах менеджера: пара «вопрос клиента → ответ менеджера» сразу
 * становится документом базы знаний, и следующему клиенту с тем же вопросом агент
 * отвечает сам. Проверка старшего не нужна (заказчик, чат задачи 27.11).
 * ПДн маскируются до записи: в базе знаний остаются метки (Почта_1), не значения.
 */
export interface Learned { slug: string; title: string }

export function learnedText(question: string, answer: string) {
  const qm = maskPii(question.trim()).masked
  const am = maskPii(answer.trim()).masked
  const title = `Ответ менеджера: ${qm.replace(/\s+/g, ' ').slice(0, 90)}`
  return { title, content: `Вопрос клиента: ${qm}\n\nОтвет менеджера: ${am}` }
}

export async function learnFromManager(conversationId: string, question: string, answer: string): Promise<Learned | null> {
  if (!question.trim() || answer.trim().length < 15) return null
  const { title, content } = learnedText(question, answer)
  // Эмбеддинг — до транзакции: при недоступном узле кусок ищется полнотекстом и триграммами
  let vector: number[] | undefined
  try {
    vector = (await embedTexts([`${title}\n${content}`])).vectors[0]
  }
  catch {}
  const client = await db().connect()
  try {
    await client.query('begin')
    const n = await client.query<{ n: string }>(`select count(*) n from kb_documents where source = $1`, [`manager:${conversationId}`])
    const slug = `manager-${conversationId.slice(0, 8)}-${Number(n.rows[0]!.n) + 1}`
    const doc = await client.query<{ id: number }>(
      `insert into kb_documents (slug, title, source) values ($1, $2, $3) returning id`,
      [slug, title, `manager:${conversationId}`],
    )
    await client.query(
      `insert into kb_chunks (document_id, idx, heading, content, embedding) values ($1, 0, $2, $3, $4)`,
      [doc.rows[0]!.id, 'Ответ менеджера', content, vector ? `[${vector.join(',')}]` : null],
    )
    await client.query('commit')
    return { slug, title }
  }
  catch (e) {
    await client.query('rollback')
    throw e
  }
  finally {
    client.release()
  }
}
