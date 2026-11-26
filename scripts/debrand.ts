/**
 * База знаний собрана со страниц магазина заказчика, а продавец в демо — «Демо Софт».
 * При загрузке меняем название и домены, иначе в одном интерфейсе два продавца:
 * «Демо Софт» в шапке и чужое имя в ответах и плашках источников. Исходные файлы не трогаем.
 */
const RULES: Array<[RegExp, string]> = [
  // домены и почта: store.softline.ru, info@softline.com
  [/\b(?:[\w-]+\.)*softline\.(?:ru|com|net|org)\b/gi, 'demo-soft.example'],
  [/\bSoftline\s+Store\b/gi, 'Демо Софт'],
  // \b в JS не видит кириллицу — граница слова вручную
  [/(?<![\p{L}])(?:ГК|группа\s+компаний)\s+(?=Softline|Софтлайн)/giu, ''],
  [/\bSoftline\b/gi, 'Демо Софт'],
  // падежи: «Софтлайна», «Софтлайну», «Софтлайном», «Софтлайне»
  [/Софтлайн(а|у|ом|е)?(?![\p{L}])/giu, 'Демо Софт$1'],
]

/** В заголовке домен стоит на месте названия («Оплата и доставка в Softline.ru») — там он становится названием. */
export function debrand(text: string, opts: { title?: boolean } = {}): string {
  const s = RULES.reduce((acc, [re, to]) => acc.replace(re, to), text)
  return opts.title ? s.replace(/demo-soft\.example/g, 'Демо Софт') : s
}
