/**
 * Прогон реальных обращений без разметки: что агент сделал с каждым — ответил сам, собрал КП на подтверждение,
 * задал уточняющий вопрос, передал менеджеру или упал. Сами обращения и ответы в репозиторий не кладём:
 * вход и результаты — пути аргументами (вне git), в репозиторий идёт только сводка.
 *
 *   npx tsx scripts/eval-real.ts run <обращения.json> <результаты.jsonl> [--until 07:00] [--limit N]
 *   npx tsx scripts/eval-real.ts summary <результаты.jsonl> [--md сводка.md]
 *
 * Обращения: [{ id, category, url, text }]. url — страница магазина, с которой написал клиент: агент получает её
 * как контекст (карточка товара — по адресу, см. server/agent/page.ts). Каждое обращение — новый диалог, в один поток.
 * run дописывает строку после каждого обращения и при повторном запуске пропускает уже сделанные.
 * --until: не начинать новое обращение позже этого времени (часы Мака). Модель недоступна до начала обращения
 * (туннель упал) — ждём и повторяем, такое обращение не считается.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

if (existsSync('.env')) process.loadEnvFile('.env')

type Outcome = 'answer' | 'proposal' | 'clarify' | 'manager' | 'model_error' | 'crash'
interface Item { id: string; category?: string; url?: string; text: string }
interface Row {
  id: string
  category: string
  page: 'card' | 'other' | 'none'
  outcome: Outcome
  escalation?: { kind: string; reason: string }
  proposals: number
  verifyOk: boolean
  mismatches: number
  seconds: number
  steps: number
  inputTokens: number
  outputTokens: number
  tools: string[]
  model: string
  at: string
  answer: string
  error?: string
}

const argv = process.argv.slice(2)
const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const [mode, a1] = argv

/** уточняющий вопрос: реплика кончается вопросом и в ней нет цены (как gotKind в eval-score.ts) */
function isClarify(text: string): boolean {
  return /\?\s*$|\?\s*\n/m.test(text.trim()) && !/\d[\d\s ]*(,\d\d)?\s*(₽|руб)/.test(text)
}

function deadline(hhmm: string | undefined): number {
  if (!hhmm) return Infinity
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setHours(h!, m ?? 0, 0, 0)
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1) // это время сегодня уже прошло — значит, завтра
  return d.getTime()
}

async function modelUp(baseUrl: string): Promise<boolean> {
  // /api/ps у Ollama — список загруженных моделей: видеокарту не трогает
  const root = baseUrl.replace(/\/v1\/?$/, '')
  try { return (await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(10_000) })).ok }
  catch { return false }
}

async function run(itemsFile: string, out: string) {
  const { ask } = await import('../server/agent/loop')
  const { db } = await import('../server/lib/db')
  const { pickLlm } = await import('../server/agent/llm')
  const { normalizePage, pageSku, urlPath } = await import('../server/agent/page')

  const items = JSON.parse(readFileSync(itemsFile, 'utf8')) as Item[]
  const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as Row).id) : [])
  const until = deadline(opt('--until'))
  const limit = Number(opt('--limit') || Infinity)
  const llm = pickLlm()
  const base = process.env.NUXT_OLLAMA_BASE_URL || 'http://localhost:11434/v1'
  const todo = items.filter(i => !done.has(i.id)).slice(0, limit)
  console.log(`${new Date().toLocaleTimeString('ru-RU')} модель ${llm.kind}:${llm.model} · сделано ${done.size}/${items.length} · сейчас ${todo.length} · до ${Number.isFinite(until) ? new Date(until).toLocaleString('ru-RU') : 'конца'}`)

  let n = 0
  for (const item of todo) {
    if (Date.now() > until - 3 * 60_000) { console.log(`${new Date().toLocaleTimeString('ru-RU')} время вышло, стоп (сделано ${done.size + n})`); break }
    if (llm.kind === 'ollama') {
      let waited = 0
      while (!(await modelUp(base))) {
        if (waited >= 30 || Date.now() > until - 3 * 60_000) { console.log('модель недоступна 30 мин — стоп'); await db().end(); process.exit(3) }
        console.log(`${new Date().toLocaleTimeString('ru-RU')} модель недоступна, жду минуту`)
        await new Promise(r => setTimeout(r, 60_000))
        waited++
      }
    }
    const page = normalizePage({ url: item.url ? `https://${item.url.replace(/^https?:\/\//, '')}` : undefined })
    const card = await pageSku(page)
    const t0 = Date.now()
    const head: Pick<Row, 'id' | 'category' | 'page' | 'model' | 'at'> = {
      id: item.id, category: item.category ?? '-', page: card ? 'card' : urlPath(page?.url) ? 'other' : 'none', model: llm.model, at: new Date().toISOString(),
    }
    let row: Row
    try {
      const r = await ask({ channel: 'chat', text: item.text, llm, page })
      const proposals = r.drafts.filter(d => d.kind === 'proposal').length
      const modelDown = !!r.escalation?.reason.startsWith('модель недоступна')
      const outcome: Outcome = modelDown ? 'model_error' : r.escalation ? 'manager' : proposals ? 'proposal' : isClarify(r.text) ? 'clarify' : 'answer'
      row = {
        ...head, outcome, proposals,
        ...(r.escalation ? { escalation: { kind: r.escalation.kind, reason: r.escalation.reason.slice(0, 300) } } : {}),
        verifyOk: r.verify.ok, mismatches: r.verify.mismatches.length,
        seconds: (Date.now() - t0) / 1000, steps: r.run.steps, inputTokens: r.run.inputTokens, outputTokens: r.run.outputTokens,
        tools: r.run.tools.map(c => c.name), answer: r.text,
      }
    }
    catch (e) {
      row = { ...head, outcome: 'crash', proposals: 0, verifyOk: false, mismatches: 0, seconds: (Date.now() - t0) / 1000, steps: 0, inputTokens: 0, outputTokens: 0, tools: [], answer: '', error: (e as Error).message.slice(0, 500) }
    }
    appendFileSync(out, `${JSON.stringify(row)}\n`)
    n++
    console.log(`${new Date().toLocaleTimeString('ru-RU')} ${done.size + n}/${items.length} #${row.id} ${row.outcome}${row.escalation ? `:${row.escalation.kind}` : ''} · ${row.seconds.toFixed(0)} с · шагов ${row.steps} · ${row.page}`)
  }
  await db().end()
}

// ── сводка ────────────────────────────────────────────────────────────────────

const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(1).replace('.', ',')}%` : '—'
const quant = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0 }
const fmt = (x: number, d = 0) => x.toFixed(d).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const LABEL: Record<Outcome, string> = {
  answer: 'ответ без менеджера', proposal: 'КП на подтверждение менеджеру', clarify: 'уточняющий вопрос клиенту',
  manager: 'передано менеджеру', model_error: 'сбой модели (→ менеджеру)', crash: 'ошибка кода',
}

function summary(file: string): string {
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Row)
  const N = rows.length
  const by = <K extends string>(f: (r: Row) => K) => rows.reduce((m, r) => m.set(f(r), (m.get(f(r)) ?? 0) + 1), new Map<K, number>())
  const out = by(r => r.outcome)
  const closed = (out.get('answer') ?? 0) + (out.get('proposal') ?? 0)
  const ok = rows.filter(r => r.outcome !== 'crash')
  const secs = ok.map(r => r.seconds)
  const lines: string[] = []
  lines.push(`Обращений: **${N}** · модель ${[...new Set(rows.map(r => r.model))].join(', ')} · ${rows[0]?.at.slice(0, 10)}…${rows.at(-1)?.at.slice(0, 10)}`, '')
  lines.push(`**Закрыто агентом: ${closed} (${pct(closed, N)})** — ответ без менеджера или КП, которое менеджер подтверждает одним нажатием.`, '')
  lines.push('| Исход | Обращений | Доля |', '|---|---:|---:|')
  for (const k of Object.keys(LABEL) as Outcome[]) lines.push(`| ${LABEL[k]} | ${out.get(k) ?? 0} | ${pct(out.get(k) ?? 0, N)} |`)
  lines.push('')
  const esc = by(r => r.escalation && r.outcome === 'manager' ? r.escalation.kind : '' as string)
  esc.delete('')
  if (esc.size) lines.push(`Причины передачи менеджеру: ${[...esc].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} — ${v}`).join(', ')}.`, '')
  const verifyFail = rows.filter(r => !r.verifyOk && r.outcome !== 'crash').length
  lines.push(`Сверка цифр ответа с каталогом и базой знаний не прошла: ${verifyFail} (${pct(verifyFail, N)}) — такие ответы клиент не получает, они уходят менеджеру.`, '')
  lines.push('| Время ответа | Секунд |', '|---|---:|')
  lines.push(`| медиана | ${fmt(quant(secs, 0.5))} |`, `| 90% обращений быстрее | ${fmt(quant(secs, 0.9))} |`, `| максимум | ${fmt(Math.max(0, ...secs))} |`, `| в среднем | ${fmt(secs.reduce((a, b) => a + b, 0) / (secs.length || 1), 1)} |`, '')
  const inT = ok.map(r => r.inputTokens), outT = ok.map(r => r.outputTokens), steps = ok.map(r => r.steps)
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
  lines.push('| На одно обращение | В среднем | Медиана |', '|---|---:|---:|')
  lines.push(`| вызовов модели | ${fmt(avg(steps), 2)} | ${fmt(quant(steps, 0.5))} |`)
  lines.push(`| токенов на входе | ${fmt(avg(inT))} | ${fmt(quant(inT, 0.5))} |`)
  lines.push(`| токенов на выходе | ${fmt(avg(outT))} | ${fmt(quant(outT, 0.5))} |`, '')
  lines.push(`Всего токенов: вход ${fmt(inT.reduce((a, b) => a + b, 0))}, выход ${fmt(outT.reduce((a, b) => a + b, 0))}; машинное время модели ${fmt(secs.reduce((a, b) => a + b, 0) / 3600, 1)} ч.`, '')
  const pages = by(r => r.page)
  lines.push('| Откуда писал клиент | Обращений | Закрыто агентом |', '|---|---:|---:|')
  for (const [k, label] of [['card', 'карточка товара (контекст передан)'], ['other', 'страница продукта или раздела'], ['none', 'главная']] as const) {
    const rs = rows.filter(r => r.page === k)
    const c = rs.filter(r => r.outcome === 'answer' || r.outcome === 'proposal').length
    lines.push(`| ${label} | ${pages.get(k) ?? 0} | ${pct(c, rs.length)} |`)
  }
  lines.push('')
  lines.push('| Тема обращения (разметка организаторов) | Обращений | Закрыто | КП | Уточнение | Менеджеру | Сбои |', '|---|---:|---:|---:|---:|---:|---:|')
  for (const [cat, n] of [...by(r => r.category)].sort((a, b) => b[1] - a[1])) {
    const rs = rows.filter(r => r.category === cat)
    const c = (o: Outcome) => rs.filter(r => r.outcome === o).length
    lines.push(`| ${cat} | ${n} | ${pct(c('answer') + c('proposal'), n)} | ${c('proposal')} | ${c('clarify')} | ${c('manager')} | ${c('model_error') + c('crash')} |`)
  }
  lines.push('')
  const tools = rows.flatMap(r => r.tools).reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map<string, number>())
  lines.push(`Инструменты (вызовов): ${[...tools].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}.`)
  return lines.join('\n')
}

if (mode === 'run' && a1 && argv[2]) await run(a1, argv[2])
else if (mode === 'summary' && a1) {
  const md = summary(a1)
  const to = opt('--md')
  if (to) writeFileSync(to, `${md}\n`)
  console.log(md)
}
else { console.error('нужно: run <обращения.json> <результаты.jsonl> [--until 07:00] [--limit N] | summary <результаты.jsonl> [--md файл]'); process.exit(1) }
