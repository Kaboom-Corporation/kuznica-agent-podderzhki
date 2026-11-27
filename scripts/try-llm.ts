/**
 * Быстрый прогон нескольких вопросов из eval/questions.json на выбранной модели.
 * npx tsx scripts/try-llm.ts <ollama|gateway> <модель|-> q03 q09 ...
 * Печатает время, шаги, инструменты, сверку чисел, эскалацию и начало ответа.
 */
import { readFileSync, existsSync } from 'node:fs'

if (existsSync('.env')) process.loadEnvFile('.env')

const [kind, modelArg, ...ids] = process.argv.slice(2) as [string, string, ...string[]]
const { ask } = await import('../server/agent/loop')
const { db } = await import('../server/lib/db')
const { pickLlm } = await import('../server/agent/llm')

const all = JSON.parse(readFileSync('eval/questions.json', 'utf8')) as Array<{ id: string; channel: string; question: string; expect: { kind: string; skus: string[] } }>
const picked = ids.length ? all.filter(x => ids.includes(x.id)) : all.slice(0, 5)
const llm = pickLlm({ kind: kind as any, ...(modelArg && modelArg !== '-' ? { model: modelArg } : {}) })

for (const item of picked) {
  const t0 = Date.now()
  try {
    const r = await ask({ channel: item.channel as any, text: item.question, llm })
    const got = r.escalation ? 'escalate' : r.drafts.length ? 'proposal' : 'answer'
    console.log(`\n── ${item.id} [ждали ${item.expect.kind}, вышло ${got}] ${((Date.now() - t0) / 1000).toFixed(1)} с · шагов ${r.run.steps} · ${r.run.tools.map(c => c.name).join(',') || 'без инструментов'} · сверка ${r.verify.ok ? 'ок' : 'НЕТ'} · ${r.run.costRub.toFixed(3)} ₽`)
    console.log(`  В: ${item.question}`)
    console.log(`  О: ${r.text.replace(/\s+/g, ' ').slice(0, 400)}`)
  }
  catch (e) {
    console.log(`\n── ${item.id} ОШИБКА за ${((Date.now() - t0) / 1000).toFixed(1)} с: ${(e as Error).message.slice(0, 300)}`)
  }
}
await db().end()
