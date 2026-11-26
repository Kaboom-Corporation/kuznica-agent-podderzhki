/**
 * Инструменты агента. Схема хода — по нашему avito-ai-buddy (agent.go): код копит источники,
 * черновики и эскалации хода, а модель получает только готовые данные. Всё, что уходит
 * клиенту наружу (КП, счёт, письмо), — черновик до подтверждения менеджером.
 */
import { q, q1 } from '../lib/db'
import { searchKb } from '../ported/rag/searcher'
import { buildTsQueries } from './catalog-search'
import { absorb, type Facts } from './verify'
import { buildQuote, quoteForModel, rub, CONDITIONS, type CatalogItem, type Condition, type PriceRule } from './quote'

export interface Source { slug: string; title: string; heading: string | null; expired: boolean }
export interface Draft { kind: 'proposal' | 'invoice'; id: string; number: string; total: string }
export interface Escalation { kind: 'no_answer' | 'needs_human' | 'low_confidence' | 'verify_failed'; reason: string }

export interface Turn {
  conversationId: string
  question: string
  facts: Facts
  sources: Source[]
  drafts: Draft[]
  escalation: Escalation | null
  searched: boolean
  embedTokens: number
  calls: { name: string; ms: number; ok: boolean }[]
  vatPercent: number
}

export const TOOL_DEFS = [
  def('search_kb', 'Поиск по базе знаний магазина: условия поставки, лицензирование, возвраты, гарантия, реестр ПО, оплата. Вызывай перед любым ответом по правилам магазина.', {
    query: { type: 'string', description: 'запрос на русском своими словами' },
  }, ['query']),
  def('check_stock', 'Найти товары в каталоге и узнать наличие и срок поставки. По названию, вендору или артикулу.', {
    query: { type: 'string', description: 'название, вендор, категория или артикул' },
  }, ['query']),
  def('get_price', 'Цена и скидки для позиций. Суммы считает магазин, не ты. Условия передавай, только если клиент сам их подтвердил.', {
    items: itemsSchema(),
    conditions: conditionsSchema(),
  }, ['items']),
  def('draft_proposal', 'Подготовить черновик коммерческого предложения. Клиенту не уходит, пока менеджер не подтвердит.', {
    items: itemsSchema(),
    conditions: conditionsSchema(),
    customer_company: { type: 'string' },
    customer_inn: { type: 'string' },
    customer_email: { type: 'string' },
    notes: { type: 'string', description: 'что важно менеджеру: условия, сроки, пожелания клиента' },
  }, ['items']),
  def('draft_invoice', 'Черновик счёта на оплату по уже подготовленному КП (номер КП). Тоже ждёт менеджера.', {
    proposal_number: { type: 'string' },
  }, ['proposal_number']),
  def('handoff_to_manager', 'Передать обращение менеджеру: ответа нет в базе, нужна нестандартная скидка, жалоба, юридический вопрос, клиент просит человека.', {
    reason: { type: 'string' },
    kind: { type: 'string', enum: ['no_answer', 'needs_human', 'low_confidence'] },
  }, ['reason', 'kind']),
] as const

function def(name: string, description: string, properties: object, required: string[]) {
  return { type: 'function' as const, function: { name, description, parameters: { type: 'object', properties, required } } }
}
function itemsSchema() {
  return {
    type: 'array',
    items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 } }, required: ['sku', 'qty'] },
  }
}
function conditionsSchema() {
  return { type: 'array', items: { type: 'string', enum: CONDITIONS }, description: 'renewal — продление, partner — партнёр, gov — госзаказчик, edu — образование' }
}

export async function runTool(name: string, args: Record<string, unknown>, t: Turn): Promise<unknown> {
  const started = Date.now()
  let ok = true
  try {
    const out = await dispatch(name, args, t)
    if (out && typeof out === 'object' && 'error' in out) ok = false
    absorb(t.facts, out)
    return out
  } catch (e) {
    ok = false
    return { error: `инструмент ${name} не сработал: ${(e as Error).message}` }
  } finally {
    t.calls.push({ name, ms: Date.now() - started, ok })
  }
}

async function dispatch(name: string, args: Record<string, unknown>, t: Turn): Promise<unknown> {
  // Черновик без поиска: правила (сроки, условия оплаты) код находит сам, чтобы у КП был источник.
  if (name.startsWith('draft_') && !t.searched) await search(t.question, t)
  switch (name) {
    case 'search_kb':
      // модель иногда сокращает запрос — ищем и по нему, и по словам клиента
      return search(`${str(args.query)} ${t.question}`.trim(), t)
    case 'check_stock':
      return checkStock(str(args.query))
    case 'get_price': {
      const r = await quote(args, t)
      return 'error' in r ? r : quoteForModel(r.quote)
    }
    case 'draft_proposal':
      return draftProposal(args, t)
    case 'draft_invoice':
      return draftInvoice(str(args.proposal_number), t)
    case 'handoff_to_manager': {
      // Эскалация без поиска: сначала база. Если в ней что-то есть — модель отвечает по ней,
      // а менеджера зовёт вторым вызовом. Просьба клиента о человеке уходит сразу.
      const kind = (['no_answer', 'needs_human', 'low_confidence'].includes(str(args.kind)) ? args.kind : 'needs_human') as Escalation['kind']
      if (!t.searched && kind === 'no_answer') {
        const found = await search(t.question, t)
        if (found.docs.length) {
          return { ...found, note: 'Менеджер не позван: в базе нашлись документы. Ответь по ним. Если они не отвечают на вопрос — вызови handoff_to_manager ещё раз.' }
        }
      }
      t.escalation = { kind, reason: str(args.reason) || 'без причины' }
      return { ok: true, note: 'Обращение передано менеджеру. Скажи клиенту, что менеджер ответит в рабочее время, и ничего не обещай за него.' }
    }
  }
  return { error: `неизвестный инструмент ${name}` }
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim()

async function search(query: string, t: Turn) {
  t.searched = true
  const res = await searchKb(query, { limit: 5, includeExpired: true })
  t.embedTokens += res.embedTokens ?? 0
  const today = t.facts.today
  const docs = res.hits.map(h => {
    const expired = !!h.validTo && new Date(h.validTo) < today
    if (!t.sources.some(s => s.slug === h.slug && s.heading === h.heading)) {
      t.sources.push({ slug: h.slug, title: h.title, heading: h.heading ?? null, expired })
    }
    return {
      doc: h.slug,
      title: h.title,
      section: h.heading,
      ...(/^https?:\/\//.test(h.source) ? { url: h.source } : {}),
      text: h.content,
      ...(expired ? { expired: `УСТАРЕЛО: действовало до ${String(h.validTo).slice(0, 10)}. Не отвечай по этому куску, если есть действующий.` } : {}),
    }
  })
  const out: { docs: typeof docs; note?: string } = { docs }
  if (!docs.length) out.note = 'В базе ничего не нашлось. Не выдумывай — передай вопрос менеджеру (handoff_to_manager, kind=no_answer).'
  return out
}

async function checkStock(query: string) {
  if (!query) return { error: 'пустой запрос' }
  const rows = await findItems(query)
  if (!rows.length) return { items: [], note: 'Такого товара в каталоге нет. Предложи уточнить или передай менеджеру.' }
  return {
    items: rows.map(r => ({
      sku: r.sku,
      name: r.name,
      vendor: r.vendor,
      category: r.category,
      unit: r.unit,
      term: r.term_months ? `${r.term_months} мес.` : 'бессрочная',
      price: rub(BigInt(r.price_cents)),
      in_stock: r.stock < 0 ? 'доступно к заказу' : r.stock > 0 ? `${r.stock} шт.` : 'сейчас нет в наличии — срок и возможность поставки уточнит менеджер',
      lead: r.lead_days == null ? 'срок поставки в каталоге не указан — не называй его, предложи уточнить у менеджера' : `${r.lead_days} раб. дн.`,
      in_registry: r.in_registry ? 'в реестре российского ПО' : 'нет в реестре',
      description: r.description,
      ...(r.url ? { url: r.url } : {}),
    })),
  }
}

/**
 * Сначала точный артикул, потом полнотекст «все слова», потом «любое слово».
 * Ранг: совпадение по названию весит больше описания; то, что можно заказать сейчас, — выше.
 */
async function findItems(query: string): Promise<CatalogItem[]> {
  const bySku = await q<CatalogItem>('select * from catalog_items where upper(sku) = upper($1)', [query.trim()])
  if (bySku.length) return bySku
  const tq = buildTsQueries(query)
  if (!tq) return []
  const run = (expr: string) => q<CatalogItem>(
    `select c.* from catalog_items c, to_tsquery('russian', $1) tq
      where c.search_tsv @@ tq
      order by ts_rank(c.search_tsv, tq, 1) + case when c.stock <> 0 then 0.1 else 0 end + 0.2 * word_similarity($2, c.name) desc
      limit 8`,
    [expr, query],
  )
  const all = await run(tq.all)
  return all.length >= 3 ? all : [...all, ...(await run(tq.any)).filter(r => !all.some(a => a.sku === r.sku))].slice(0, 8)
}

function parseItems(v: unknown): { sku: string; qty: number }[] {
  if (!Array.isArray(v)) return []
  return v
    .map(x => ({ sku: str((x as any)?.sku), qty: Math.floor(Number((x as any)?.qty)) }))
    .filter(x => x.sku && Number.isFinite(x.qty) && x.qty > 0 && x.qty <= 100_000)
}

function parseConditions(v: unknown): Set<Condition> {
  const list = Array.isArray(v) ? v.map(str) : []
  return new Set(list.filter((c): c is Condition => (CONDITIONS as string[]).includes(c)))
}

async function quote(args: Record<string, unknown>, t: Turn) {
  const items = parseItems(args.items)
  if (!items.length) return { error: 'нет позиций: передай sku и qty из check_stock' }
  const skus = items.map(i => i.sku)
  const found = await q<CatalogItem>('select * from catalog_items where sku = any($1)', [skus])
  const missing = skus.filter(s => !found.some(f => f.sku === s))
  if (missing.length) return { error: `нет в каталоге: ${missing.join(', ')}. Найди артикул через check_stock.` }
  const rules = await q<PriceRule>('select * from price_rules')
  const wanted = items.map(i => ({ item: found.find(f => f.sku === i.sku)!, qty: i.qty }))
  const quote = buildQuote(wanted, rules, parseConditions(args.conditions), t.vatPercent)
  return { quote, wanted }
}

async function draftProposal(args: Record<string, unknown>, t: Turn) {
  const r = await quote(args, t)
  if ('error' in r) return r
  const { quote: qt, wanted } = r
  const shortage = wanted.filter(w => w.item.stock >= 0 && w.item.stock < w.qty)
  const validUntil = new Date(t.facts.today.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)
  const customer = {
    company: str(args.customer_company),
    inn: str(args.customer_inn),
    email: str(args.customer_email),
  }
  const notes = [str(args.notes), ...shortage.map(s => `${s.item.sku}: на складе ${s.item.stock} из ${s.qty}, срок поставки ${s.item.lead_days == null ? "уточнить" : `${s.item.lead_days} раб. дн.`}`)].filter(Boolean).join('\n')
  const row = await q1<{ id: string; number: string }>(
    `insert into proposals (number, conversation_id, customer, items, subtotal_cents, discount_cents, total_cents, vat_cents, notes, valid_until)
     values ('КП-' || nextval('doc_number_seq'), $1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id, number`,
    [
      t.conversationId,
      JSON.stringify(customer),
      JSON.stringify(qt.lines, (_k, v) => typeof v === 'bigint' ? v.toString() : v),
      qt.subtotal_cents, qt.discount_cents, qt.total_cents, qt.vat_cents, notes, validUntil,
    ],
  )
  const view = quoteForModel(qt)
  t.drafts.push({ kind: 'proposal', id: row!.id, number: row!.number, total: view.total })
  await q(`update conversations set status = 'waiting_manager', updated_at = now() where id = $1`, [t.conversationId])
  return {
    draft: row!.number,
    status: 'черновик, ждёт подтверждения менеджера',
    valid_until: validUntil,
    ...view,
    ...(shortage.length ? { shortage: notes } : {}),
    note: 'Скажи клиенту номер черновика КП и итог. Отправит менеджер после проверки — не пиши, что КП уже отправлено.',
  }
}

async function draftInvoice(number: string, t: Turn) {
  const p = await q1<{ id: string; number: string; total_cents: bigint; vat_cents: bigint; conversation_id: string | null }>(
    'select id, number, total_cents, vat_cents, conversation_id from proposals where number = $1',
    [number],
  )
  if (!p) return { error: `КП ${number} не найдено. Сначала подготовь КП через draft_proposal.` }
  // КП без обращения (обращение удалено) тоже чужое: счёт только по КП этого диалога
  if (p.conversation_id !== t.conversationId) return { error: 'это КП из другого обращения' }
  const due = new Date(t.facts.today.getTime() + 5 * 86_400_000).toISOString().slice(0, 10)
  const row = await q1<{ id: string; number: string }>(
    `insert into invoices (number, proposal_id, total_cents, vat_cents, due_date)
     values ('СЧ-' || nextval('doc_number_seq'), $1, $2, $3, $4) returning id, number`,
    [p.id, p.total_cents, p.vat_cents, due],
  )
  t.drafts.push({ kind: 'invoice', id: row!.id, number: row!.number, total: rub(p.total_cents) })
  return {
    draft: row!.number,
    proposal: p.number,
    total: rub(p.total_cents),
    vat: rub(p.vat_cents),
    pay_until: due,
    status: 'черновик, ждёт подтверждения менеджера',
  }
}
