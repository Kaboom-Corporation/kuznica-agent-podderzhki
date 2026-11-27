// Просьбы клиента о скидке и отсрочке распознаёт код, а не модель.
// Стенд 27.11: на «можете сделать скидку?» qwen 9b опиралась на базу знаний («индивидуальные скидки — только менеджер»)
// и отказывала, хотя заказчик разрешил 5% без менеджера; на отсрочку отказывала сама и менеджера не звала.

const DISCOUNT = /(?<!\p{L})(?:скидк\p{L}*|подешевле|дешевле|уступ\p{L}*)(?!\p{L})/iu
const DEFERRAL = /(?<!\p{L})(?:отсрочк\p{L}*|рассрочк\p{L}*|постоплат\p{L}*|оплат\p{L}* (?:потом|позже|после поставки|частями))(?!\p{L})/iu
const PERCENT = /(\d{1,2}(?:[.,]\d+)?)\s*(?:%|процент\p{L}*)/giu

/** Скидка, которую агент даёт сам: 5% без менеджера. */
export const GOODWILL_PCT = 5

/**
 * 'goodwill' — клиент просит скидку, 5% агент даёт сам;
 * 'manager' — просит больше 5%: решает менеджер; null — о скидке не просит.
 */
export function discountAsk(question: string): 'goodwill' | 'manager' | null {
  if (!DISCOUNT.test(question)) return null
  const pcts = [...question.matchAll(PERCENT)].map(m => Number(m[1]!.replace(',', '.')))
  return pcts.some(p => p > GOODWILL_PCT) ? 'manager' : 'goodwill'
}

/** Отсрочка или рассрочка платежа — только менеджер. */
export function deferralAsk(question: string): boolean {
  return DEFERRAL.test(question)
}
