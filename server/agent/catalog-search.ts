/**
 * Запрос к каталогу: слова клиента → tsquery для полнотекста Postgres ('russian').
 * Клиенты пишут бренды по-русски («касперский», «майкрософт»), в фиде они латиницей —
 * для таких слов в запрос идут оба написания. Числа («на 5 компов») в поиск не идут:
 * количество — дело get_price, а не выбора товара.
 */

// начало слова клиента → как бренд/термин записан в каталоге
const ALIASES: Array<[RegExp, string[]]> = [
  [/^касперск/, ['kaspersky']],
  [/^(майкрософт|микрософт|мелкософт)/, ['microsoft']],
  [/^(виндовс|винд)/, ['windows']],
  [/^(офис|офф?ис)$/, ['office']],
  [/^астр/, ['astra']],
  [/^адоб/, ['adobe']],
  [/^автокад/, ['autocad']],
  [/^(акронис|acronis)/, ['acronis', 'киберпротект']],
  [/^(доктор|drweb|dr)$/, ['доктор', 'drweb']],
  [/^(веб|web)$/, ['веб', 'web']],
  // в фиде «х86» бывает с кириллической «х»
  [/^[xх]86/, ['x86', 'х86']],
  [/^[xх]64/, ['x64', 'х64']],
  [/^(эсет|есет)/, ['eset']],
  [/^(комп|компьютер|пк)/, ['пк', 'компьютер']],
  [/^(ред|red)$/, ['ред']],
  [/^(вмвар|vmware)/, ['vmware']],
  [/^(зум|zoom)$/, ['zoom']],
  [/^(тимвьювер|teamviewer)/, ['teamviewer']],
  // редакции в фиде латиницей: «Kaspersky Standard», «Plus», «Premium»
  [/^стандарт/, ['standard']],
  [/^плюс$/, ['plus']],
  [/^премиум/, ['premium']],
  [/^лайт$/, ['lite']],
  [/^рутокен/, ['rutoken', 'рутокен']],
  [/^тотал/, ['total']],
  [/^(эндпоинт|ендпоинт)/, ['endpoint']],
  [/^(секьюрити|секурити)/, ['security']],
  [/^(хоум|домашн)/, ['home']],
  [/^(профессионал|про)$/, ['professional', 'pro']],
]

// Слова вопроса, а не товара: с ними «все слова» не находят ничего («сколько стоит …»).
const NOISE = new Set([
  'сколько', 'стоит', 'стоимость', 'цена', 'цену', 'цены', 'почем', 'прайс', 'есть', 'ли', 'наличии', 'наличие',
  'купить', 'нужно', 'нужна', 'нужен', 'нужны', 'хочу', 'хотим', 'подскажите', 'пожалуйста', 'интересует',
  'год', 'года', 'лет', 'один', 'одну', 'подписка', 'подписку', 'лицензия', 'лицензию', 'лицензии', 'на', 'для', 'и',
])

/** Слова запроса: буквы и цифры, без чисел, одиночных символов и слов вопроса. */
export function queryWords(query: string): string[] {
  return (query.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\d]+/gu) ?? [])
    .filter(w => w.length >= 2 && !/^\d+$/.test(w) && !NOISE.has(w))
    .slice(0, 10)
}

/** Один терм: слово с префиксом и его написания из ALIASES. Только безопасные символы — to_tsquery не любит пунктуацию. */
function term(w: string): string {
  const forms = new Set([w])
  for (const [re, alts] of ALIASES) if (re.test(w)) alts.forEach(a => forms.add(a))
  const parts = [...forms].map(f => f.replace(/[^\p{L}\d]/gu, '')).filter(Boolean).map(f => `${f}:*`)
  return parts.length > 1 ? `(${parts.join(' | ')})` : parts[0]!
}

/**
 * Сколько мест просит клиент («на 3 устройства», «5 пк», «50 пользователей»). В поиск число не идёт,
 * но позиции с таким числом мест в названии поднимаем выше: «Standard на 3 устр.» раньше «на 5 устр.».
 */
export function seatCount(query: string): number | null {
  const m = query.toLowerCase().match(/(\d{1,5})\s*(?:-?х\s*)?(устр|пк|компьют|комп|польз|раб|лиц|сотрудн|ус)/)
  return m ? Number(m[1]) : null
}

/** Срок в месяцах из запроса («на год», «2 года», «36 мес»): поднимаем позиции с таким сроком. */
export function termMonths(query: string): number | null {
  const s = query.toLowerCase()
  const m = s.match(/(?<!\d)(\d{1,2})\s*(год|лет|мес)/)
  if (m) return m[2] === 'мес' ? Number(m[1]) : Number(m[1]) * 12
  return /(на|один|1)\s+год|годов/.test(s) ? 12 : null
}

// Класс продукта → запрос в каталог за российской заменой. Порядок важен: первый совпавший.
const ANALOGS: Array<[RegExp, string]> = [
  // \b в JS не видит кириллицу — границы слова для «ос» вручную
  [/windows|виндовс|винд|операцион|(^|[^\p{L}])(ос|os)([^\p{L}]|$)/u, 'astra linux special edition рабочей станции'],
  [/office|офис|word|excel|ворд|эксел/, 'мойофис'],
  [/vmware|виртуал|hyper-?v/, 'ред виртуализация'],
  [/teamviewer|тимвьювер|anydesk|удал[её]нн/, 'rudesktop'],
  [/антивирус|вирус|защит|почт|eset|есет|касперск|kaspersky/, 'доктор веб комплексная защита'],
]
const WANTS_ANALOG = /аналог|реестр|отечествен|импортозамещ|российск|замен/

/**
 * Клиент просит российскую замену — какой запрос отправить в каталог. Класс продукта ищем сначала
 * в вопросе, потом в прошлых репликах клиента от первой к последней: первая реплика — это сама
 * потребность («защитить почту»), а поздние — уточнения («у нас Windows»), их класс менять не должен.
 * Не просит замену или класс не понять — null.
 */
export function analogQuery(question: string, earlier: string[] = []): string | null {
  const q = question.toLowerCase()
  if (!WANTS_ANALOG.test(q)) return null
  const texts = [q, ...earlier.map(s => s.toLowerCase())]
  for (const text of texts)
    for (const [re, query] of ANALOGS) {
      if (!re.test(text)) continue
      // антивирус продаётся «на N ПК»: число мест из разговора поднимет нужную позицию, срок — год по умолчанию
      if (!query.startsWith('доктор')) return query
      const seats = texts.map(seatCount).find(n => n != null)
      return `${query} на 1 год${seats ? ` на ${seats} пк` : ''}`
    }
  return null
}

/** tsquery: «все слова» (and) — точнее; «любое слово» (or) — запасной, если по «все» пусто. */
export function buildTsQueries(query: string): { all: string; any: string } | null {
  const words = queryWords(query)
  if (!words.length) return null
  const terms = words.map(term)
  return { all: terms.join(' & '), any: terms.join(' | ') }
}
