/**
 * Разделы базы знаний в панели менеджера. Раздел выводится из адреса и заголовка статьи,
 * поэтому новая статья сама попадает в подходящий раздел, а не в «Прочее».
 * Порядок проверки важен: первое совпадение побеждает.
 */
export interface KbCategory { key: string; label: string; test: RegExp }

export const KB_CATEGORIES: KbCategory[] = [
  { key: 'pay', label: 'Оплата и документы', test: /oplat|schet|zakryva|upd|edo|оплат|счёт|счет|упд|эдо|закрывающ/i },
  { key: 'tender', label: 'Госзакупки и КП', test: /goszak|kp-|44-фз|223-фз|госзакуп|тендер|коммерческ/i },
  { key: 'delivery', label: 'Доставка', test: /dostav|доставк|отгрузк/i },
  { key: 'license', label: 'Лицензии и продление', test: /licenz|prodlen|reestr|vozvrat|лиценз|продлен|подписк|реестр|возврат/i },
  { key: 'discount', label: 'Скидки и партнёрам', test: /skidk|partner|скидк|партн|акци/i },
  { key: 'support', label: 'Покупка и поддержка', test: /kak-kup|faq|tehpod|как купить|частые|поддержк/i },
]

export const KB_OTHER = { key: 'other', label: 'Прочее' }
export const KB_LEARNED = { key: 'learned', label: 'Ответы менеджера' }

export function kbCategory(d: { slug: string; title: string; kind: string }): { key: string; label: string } {
  // выученные ответы — отдельной полкой: их проверяют и чистят иначе, чем статьи магазина
  if (d.kind === 'learned') return KB_LEARNED
  const hay = `${d.slug} ${d.title}`
  return KB_CATEGORIES.find(c => c.test.test(hay)) ?? KB_OTHER
}
