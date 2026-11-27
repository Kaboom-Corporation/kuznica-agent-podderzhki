/**
 * Загрузка демо-данных: каталог, правила цен, база знаний (куски + эмбеддинги).
 * Запуск: npm run ingest  (читает .env: NUXT_DATABASE_URL, NUXT_EMBED_*)
 * Повторный запуск перезаписывает всё — данные демо, не боевые.
 * npm run ingest -- --kb  — только база знаний: каталог из фида магазина (ingest:feed) не трогаем.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../server/lib/db.ts'
import { chunkMarkdown } from '../server/ported/rag/chunker.ts'
import { embedTexts } from '../server/ported/rag/embeddings.ts'
import { toCents } from '../server/ported/invoices/money.ts'
import { debrand } from './debrand.ts'

if (existsSync('.env')) process.loadEnvFile('.env')
const args = process.argv.slice(2)
const KB_ONLY = args.includes('--kb')
const DATA = args.find(a => !a.startsWith('--')) || 'data'

/** CSV с кавычками и запятыми внутри полей. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    }
    else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some(x => x !== '')) rows.push(row)
      row = []
    }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const [head, ...body] = rows
  return body.map(r => Object.fromEntries(head!.map((h, i) => [h.trim(), (r[i] ?? '').trim()])))
}

function frontMatter(md: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md.replace(/\r\n/g, '\n'))
  if (!m) return { meta: {}, body: md }
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: md.slice(m[0].length) }
}

const nullable = (s: string | undefined) => (s && s !== 'null' ? s : null)

async function main() {
  const pool = db()
  const client = await pool.connect()
  try {
    await client.query('begin')

    const catalog = KB_ONLY ? [] : parseCsv(readFileSync(join(DATA, 'catalog.csv'), 'utf8'))
    if (!KB_ONLY) await client.query('delete from catalog_items')
    for (const r of catalog) {
      const cents = toCents(r.price_rub)
      if (cents == null) throw new Error(`цена не разобрана: ${r.sku} ${r.price_rub}`)
      await client.query(
        `insert into catalog_items (sku, name, vendor, category, unit, term_months, price_cents, stock, lead_days, in_registry, description)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [r.sku, r.name, r.vendor, r.category, r.unit || 'лицензия', nullable(r.term_months), cents,
          Number(r.stock || 0), Number(r.lead_days || 0), r.in_registry === 'true', r.description ?? ''],
      )
    }

    const rules = KB_ONLY ? [] : parseCsv(readFileSync(join(DATA, 'price_rules.csv'), 'utf8'))
    if (!KB_ONLY) await client.query('delete from price_rules')
    for (const r of rules) {
      await client.query(
        `insert into price_rules (code, title, applies_to, min_qty, discount_pct, requires, stackable, note) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.code, r.title, r.applies_to || '*', Number(r.min_qty || 1), Number(r.discount_pct || 0), nullable(r.requires), r.stackable === 'true', r.note ?? ''],
      )
    }

    await client.query('delete from kb_documents')
    // --kb <папка>: папка с .md напрямую (например, data/kb-softline из scripts/fetch_kb.py)
    const kbDir = KB_ONLY && args.some(a => !a.startsWith('--')) ? DATA : join(DATA, 'kb')
    // Контакты магазина не грузим: там настоящие телефоны и адреса заказчика. На такой вопрос агент передаёт менеджеру.
    const SKIP = new Set(['kontakty.md'])
    const files = readdirSync(kbDir).filter(f => f.endsWith('.md') && !SKIP.has(f)).sort()
    const pending: { id: number; heading: string | null; content: string; title: string }[] = []
    for (const f of files) {
      const { meta, body: raw } = frontMatter(readFileSync(join(kbDir, f), 'utf8'))
      const body = debrand(raw)
      const slug = meta.slug || f.replace(/\.md$/, '')
      const title = debrand(meta.title || slug, { title: true })
      const doc = await client.query<{ id: number }>(
        `insert into kb_documents (slug, title, source, valid_from, valid_to) values ($1,$2,$3,$4,$5) returning id`,
        [slug, title, meta.source || join(kbDir, f), nullable(meta.valid_from), nullable(meta.valid_to)],
      )
      chunkMarkdown(body).forEach((c, idx) => pending.push({ id: doc.rows[0]!.id, heading: c.heading, content: c.content, title, ...{ idx } } as any))
    }

    // В эмбеддинг идёт и название документа с разделом: так короткий кусок FAQ находится по смыслу.
    let vectors: number[][] = []
    let tokens = 0
    try {
      const res = await embedTexts(pending.map(p => `${p.title}. ${p.heading ?? ''}\n${p.content}`))
      vectors = res.vectors
      tokens = res.tokens
    }
    catch (e) {
      console.warn(`эмбеддинги недоступны (${(e as Error).message}) — куски без вектора, поиск будет полнотекстовый`)
    }
    for (const [i, p] of pending.entries()) {
      const v = vectors[i]
      await client.query(
        `insert into kb_chunks (document_id, idx, heading, content, embedding) values ($1,$2,$3,$4,$5)`,
        [p.id, (p as any).idx, p.heading, p.content, v ? `[${v.join(',')}]` : null],
      )
    }

    await client.query('commit')
    console.log(`каталог: ${catalog.length}, правила: ${rules.length}, документы: ${files.length}, куски: ${pending.length}, с вектором: ${vectors.length}, токенов эмбеддинга: ${tokens}`)
  }
  catch (e) {
    await client.query('rollback')
    throw e
  }
  finally {
    client.release()
    await pool.end()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
