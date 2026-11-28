import type { Draft, Escalation, Source } from './tools'

/**
 * Подсказки следующего вопроса под ответом агента: 2–3 кнопки по тому, что случилось в обращении.
 * Считаются кодом, без модели: ни секунды, ни рубля, и подсказка не может пообещать того, чего нет.
 * Шаг сделки задаёт порядок: подбор → цена → КП → счёт → оплата и документы.
 */
export interface SuggestInput {
  question: string
  earlier: string[]
  tools: string[]
  drafts: Draft[]
  sources: Source[]
  escalation: Escalation | null
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim()

/** Темы, о которых уже спрашивали: подсказку про них не повторяем. */
const TOPICS: ReadonlyArray<readonly [string, RegExp]> = [
  ['price', /цен|стои|сколько|прайс/],
  ['proposal', /\bкп\b|коммерческ|предложени/],
  ['invoice', /сч[её]т/],
  ['pay', /оплат|безнал|реквизит/],
  ['delivery', /срок|постав|доставк|когда при/],
  ['registry', /реестр|импортозамещ|российск/],
  ['renewal', /продлен|продлит/],
  ['discount', /скидк|дешевле|акци/],
  ['docs', /закрывающ|акт|упд|документ/],
  ['edu', /образован|школ|вуз|учебн/],
  ['gov', /госзакуп|44-фз|223-фз|тендер|аукцион/],
  ['refund', /возврат|вернуть|замен/],
  ['support', /поддержк|не работает|ошибк|установ/],
]

const ASK: Readonly<Record<string, string>> = {
  price: 'Сколько это будет стоить?',
  more: 'А если взять больше лицензий?',
  proposal: 'Оформите КП на эту позицию',
  invoice: 'Выставите счёт по этому КП',
  delivery: 'Какие сроки поставки?',
  registry: 'Это есть в реестре российского ПО?',
  renewal: 'Есть скидка на продление?',
  discount: 'Какие сейчас есть скидки и акции?',
  docs: 'Какие закрывающие документы вы даёте?',
  pay: 'Как оплатить по безналу?',
  edu: 'Есть образовательные лицензии?',
  gov: 'Работаете по 44-ФЗ и 223-ФЗ?',
  refund: 'Можно ли вернуть или заменить ключ?',
  support: 'Кто поможет с установкой?',
  analog: 'Подберите российский аналог',
}

export function suggestNext(s: SuggestInput): string[] {
  // Вопрос ушёл менеджеру: подсказывать дальше — значит обещать ответ, которого не будет.
  if (s.escalation) return []

  const asked = new Set<string>()
  for (const q of [...s.earlier, s.question]) {
    const n = norm(q)
    for (const [topic, re] of TOPICS) if (re.test(n)) asked.add(topic)
  }
  const used = new Set(s.tools)
  const invoice = s.drafts.some(d => d.kind === 'invoice')
  const proposal = s.drafts.some(d => d.kind === 'proposal')
  const found = used.has('check_stock')
  const priced = used.has('get_price')

  const plan: string[] = []
  if (invoice) plan.push('pay', 'delivery', 'docs')
  else if (proposal) plan.push('invoice', 'delivery', 'discount')
  else if (priced) plan.push('proposal', 'more', 'delivery')
  else if (found) plan.push('price', 'registry', 'delivery')
  else plan.push('price', 'discount', 'delivery')

  // Запасные — по найденным правилам: если ответ был про продление, следом спросят про скидку, и наоборот.
  const slugs = s.sources.map(x => x.slug).join(' ')
  if (/obrazovat/.test(slugs)) plan.push('edu')
  if (/goszakup|tender/.test(slugs)) plan.push('gov')
  if (/prodlen/.test(slugs)) plan.push('renewal')
  if (/reestr/.test(slugs) && !found) plan.push('analog')
  plan.push('renewal', 'docs', 'pay', 'support')

  const out: string[] = []
  for (const key of plan) {
    // «больше лицензий» — уточнение к цене, не новая тема; остальное повторять не надо
    const topic = key === 'more' ? '' : key === 'analog' ? 'registry' : key
    if (topic && asked.has(topic)) continue
    const text = ASK[key]
    if (text && !out.includes(text)) out.push(text)
    if (out.length === 3) break
  }
  return out
}
