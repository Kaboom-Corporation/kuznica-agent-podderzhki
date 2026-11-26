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
  [/^(доктор|drweb)/, ['dr', 'web']],
  [/^(эсет|есет)/, ['eset']],
  [/^(комп|компьютер|пк)/, ['пк', 'компьютер']],
  [/^(ред|red)$/, ['ред']],
  [/^(вмвар|vmware)/, ['vmware']],
  [/^(зум|zoom)$/, ['zoom']],
  [/^(тимвьювер|teamviewer)/, ['teamviewer']],
]

/** Слова запроса: буквы и цифры, без чисел и одиночных символов. */
export function queryWords(query: string): string[] {
  return (query.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\d]+/gu) ?? [])
    .filter(w => w.length >= 2 && !/^\d+$/.test(w))
    .slice(0, 10)
}

/** Один терм: слово с префиксом и его написания из ALIASES. Только безопасные символы — to_tsquery не любит пунктуацию. */
function term(w: string): string {
  const forms = new Set([w])
  for (const [re, alts] of ALIASES) if (re.test(w)) alts.forEach(a => forms.add(a))
  const parts = [...forms].map(f => f.replace(/[^\p{L}\d]/gu, '')).filter(Boolean).map(f => `${f}:*`)
  return parts.length > 1 ? `(${parts.join(' | ')})` : parts[0]!
}

/** tsquery: «все слова» (and) — точнее; «любое слово» (or) — запасной, если по «все» пусто. */
export function buildTsQueries(query: string): { all: string; any: string } | null {
  const words = queryWords(query)
  if (!words.length) return null
  const terms = words.map(term)
  return { all: terms.join(' & '), any: terms.join(' | ') }
}
