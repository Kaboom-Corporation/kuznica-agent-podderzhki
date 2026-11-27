/**
 * Прогон тестового набора: npx tsx scripts/eval.ts <ollama|gateway> <модель|-> [--file eval/questions-softline.json] [s01 s02 …]
 * Каждый вопрос — новый диалог; turns — реплики одного диалога подряд. Результат пишется
 * после каждого вопроса в eval/results-<время>.json (в .gitignore), в конце — сводка по категориям.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { score, type Catalog, type EvalItem, type Observed, type Score } from './eval-score'

if (existsSync('.env')) process.loadEnvFile('.env')

const argv = process.argv.slice(2)
const fileAt = argv.indexOf('--file')
const file = fileAt >= 0 ? argv[fileAt + 1]! : 'eval/questions-softline.json'
const [kind, modelArg, ...ids] = argv.filter((a, i) => a !== '--file' && i !== fileAt + 1)
if (!kind) { console.error('нужно: <ollama|gateway> <модель|-> [id…]'); process.exit(1) }

const { ask } = await import('../server/agent/loop')
const { db, q } = await import('../server/lib/db')
const { pickLlm } = await import('../server/agent/llm')

const all = JSON.parse(readFileSync(file, 'utf8')) as EvalItem[]
const items = ids?.length ? all.filter(x => ids.includes(x.id)) : all
const llm = pickLlm({ kind: kind as any, ...(modelArg && modelArg !== '-' ? { model: modelArg } : {}) })
const skus = [...new Set(items.flatMap(x => x.expect.skus_any ?? []))]
const catalog = skus.length ? await q<Catalog>('select sku, name, price_cents from catalog_items where sku = any($1)', [skus]) : []
const missing = skus.filter(s => !catalog.some(c => c.sku === s))
if (missing.length) console.warn(`в каталоге нет SKU из набора: ${missing.join(', ')} — загружен ли фид?`)

const out = `eval/results-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
const results: Array<{ id: string; category?: string; seconds: number; costRub: number; steps: number; tools: string[]; score: Score | null; error?: string; answer: string; transcript?: Array<{ q: string; a: string; tools: string[] }> }> = []

for (const item of items) {
  const turns = item.turns ?? [item.question ?? '']
  const t0 = Date.now()
  let conversationId: string | undefined
  let cost = 0, steps = 0
  const tools: string[] = []
  const drafts: string[] = []
  const sources = new Set<string>()
  const transcript: Array<{ q: string; a: string; tools: string[] }> = []
  try {
    let last: Awaited<ReturnType<typeof ask>> | null = null
    for (const text of turns) {
      last = await ask({ channel: item.channel, text, llm, conversationId })
      conversationId = last.conversationId
      transcript.push({ q: text, a: last.text, tools: last.run.tools.map(c => c.name) })
      cost += last.run.costRub
      steps += last.run.steps
      tools.push(...last.run.tools.map(c => c.name))
      drafts.push(...last.drafts.filter(d => d.kind === 'proposal').map(d => d.id))
      last.sources.forEach(s => sources.add(s.slug))
      if (last.escalation) break
    }
    const proposalSkus = drafts.length
      ? (await q<{ sku: string }>(`select distinct i->>'sku' as sku from proposals p, jsonb_array_elements(p.items) i where p.id = any($1::uuid[])`, [drafts])).map(r => r.sku)
      : []
    const o: Observed = { text: last!.text, escalated: !!last!.escalation, proposalSkus, sourceSlugs: [...sources], verifyOk: last!.verify.ok }
    const s = score(item, o, catalog)
    results.push({ id: item.id, category: item.category, seconds: (Date.now() - t0) / 1000, costRub: cost, steps, tools, score: s, answer: o.text, ...(turns.length > 1 ? { transcript } : {}) })
    console.log(`${s.pass ? '✓' : '✗'} ${item.id} [${item.category ?? '-'}] ждали ${item.expect.kind}, вышло ${s.got} · ${((Date.now() - t0) / 1000).toFixed(0)} с · ${tools.join(',') || '—'}${s.fails.length ? ` · не прошло: ${s.fails.join('; ')}` : ''}`)
  }
  catch (e) {
    results.push({ id: item.id, category: item.category, seconds: (Date.now() - t0) / 1000, costRub: cost, steps, tools, score: null, error: (e as Error).message.slice(0, 500), answer: '' })
    console.log(`! ${item.id} ошибка: ${(e as Error).message.slice(0, 200)}`)
  }
  writeFileSync(out, JSON.stringify({ file, llm: llm.model, startedAt: out, results }, null, 2))
}

const byCat = new Map<string, { n: number; ok: number }>()
for (const r of results) {
  const c = byCat.get(r.category ?? '-') ?? { n: 0, ok: 0 }
  c.n++
  if (r.score?.pass) c.ok++
  byCat.set(r.category ?? '-', c)
}
const ok = results.filter(r => r.score?.pass).length
const secs = results.map(r => r.seconds).sort((a, b) => a - b)
console.log(`\nИтого: ${ok}/${results.length} · ошибок ${results.filter(r => r.error).length} · медиана ${(secs[Math.floor(secs.length / 2)] ?? 0).toFixed(0)} с · ${results.reduce((a, r) => a + r.costRub, 0).toFixed(2)} ₽ · модель ${llm.model}`)
for (const [c, v] of byCat) console.log(`  ${c}: ${v.ok}/${v.n}`)
console.log(`Подробно: ${out}`)
await db().end()
