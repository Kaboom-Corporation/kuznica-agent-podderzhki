/**
 * Технические фрагменты текста, внутри которых имена людей НЕ ищутся: схема и хост ссылки,
 * домены, хост в «user@host». Путь, запрос и фрагмент ссылки, сегменты путей к файлам, логин до «@» — ищутся.
 *
 * Латиница в адресе сайта совпадала (латиница = кириллица) со словом из имени клиента в словаре, и адрес уходил
 * в базу испорченным. Хост — не упоминание человека: латиница в нём
 * произвольная, а склеенные слова дают случайные совпадения. А вот путь и запрос («/clients?fio=Иванов») — данные,
 * и имя в них — настоящее ПДн (проверка безопасности 06.11.2026). Ошибаемся в сторону закрытия: глушим только хост,
 * остальное маскируется как обычный текст и возвращается «как написано» (vault.ts), поэтому ссылка не ломается.
 *
 * Контакты (почта, телефон, мессенджер) ищутся отдельно, по всему тексту (contacts.ts), и прячутся как контакты —
 * это правило их не отменяет, а лишь запрещает искать имена внутри хоста.
 *
 * Все проходы линейны по длине текста: без вложенных квантификаторов, «@» разбирается циклом (ReDoS, 06.11.2026).
 * Модуль чистый, без БД.
 */

export interface TextRange {
  start: number
  end: number
}

/** Символы, на которых обрывается ссылка/путь: пробел, кавычки, угловые скобки. */
const STOP = '\\s<>"\'«»“”„`'

/**
 * Зоны доменов. Список, а не «любые две латинские буквы»: иначе «Nikita.Shidlovskii» или «Ivan.Petrov» без пробела
 * считались бы доменом и имя ушло бы в модель открытым.
 */
const TLDS = [
  'ru', 'su', 'рф', 'рус', 'москва', 'онлайн', 'сайт', 'орг', 'дети', 'com', 'net', 'org', 'pro', 'info', 'biz',
  'io', 'dev', 'app', 'ai', 'me', 'co', 'tech', 'online', 'site', 'store', 'shop', 'cloud', 'xyz', 'top', 'space',
  'by', 'kz', 'ua', 'uz', 'am', 'ge', 'az', 'kg', 'tj', 'de', 'uk', 'us', 'eu', 'fr', 'it', 'es', 'nl', 'pl', 'cz',
  'cn', 'jp', 'in', 'tv', 'fm', 'gg', 'ly', 'to', 'cc', 'edu', 'gov', 'academy', 'agency', 'digital', 'studio',
  'team', 'tools', 'work', 'world', 'website', 'page', 'blog', 'news', 'media', 'link', 'live', 'design',
]

/**
 * Схема и «authority» ссылки: только символы, допустимые в хосте, логине и порте (буквы, цифры, . - : @ [ ] % _ ~).
 * Всё остальное («/», «?», «#», «\\», запятая…) обрывает адрес сайта — дальше обычный текст.
 */
const RE_URL = new RegExp(`\\b(?:https?|ftp)://[\\p{L}\\d.\\-:@\\[\\]%_~]*`, 'giu')
/** Ссылка целиком (до пробела или кавычки): «@» внутри её пути и запроса — не «user@host». */
const RE_URL_FULL = new RegExp(`\\b(?:https?|ftp)://[^${STOP}]*`, 'giu')
/** «www.хост» без пути: только символы хоста и порта. */
const RE_WWW = new RegExp(`(?<![\\p{L}\\d_.-])www\\.[\\p{L}\\d.\\-:\\[\\]%]+`, 'giu')
/**
 * Домен: метки от двух символов через точку и зона из списка (зона в нижнем регистре — «Ivan.Pro» с заглавной не
 * домен). Слева — не буква/цифра, справа зона не продолжается словом. Путь после домена не глушится.
 * Метка не содержит точки, поэтому разбор однозначен и перебор линеен.
 */
const RE_DOMAIN = new RegExp(
  `(?<![\\p{L}\\d_.-])(?:[\\p{L}\\d][\\p{L}\\d-]*[\\p{L}\\d]\\.)+(?:${TLDS.join('|')})(?![\\p{L}\\d_-])`,
  'gu',
)

/** Знаки препинания в конце хоста — это конец предложения, а не часть адреса: «см. site.ru.» */
const TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}'])

/** Символ обрывает «слово с @»: пробелы, кавычки, скобки, запятая, точка с запятой. */
const AT_STOP = new RegExp(`[${STOP}()\\[\\]{},;]`, 'u')

/** Отрезок без хвостовых знаков препинания: обратный цикл по символам, без регулярки «[…]+$». */
function trimEnd(start: number, s: string): TextRange | undefined {
  let len = s.length
  while (len > 0 && TRAILING_PUNCT.has(s[len - 1]!)) len--
  return len > 0 ? { start, end: start + len } : undefined
}

/** Символ хоста в «user@host»: буква, цифра, точка, дефис. */
const HOST_CHAR = /[\p{L}\d.-]/u

/** Схема и хост ссылки; логин в «user:pass@host» остаётся для поиска (там бывает фамилия). */
function urlRanges(text: string, out: TextRange[]): void {
  RE_URL.lastIndex = 0
  for (const m of text.matchAll(RE_URL)) {
    const sep = m[0].indexOf('://') + 3
    out.push({ start: m.index, end: m.index + sep })
    const authority = m[0].slice(sep)
    const at = authority.lastIndexOf('@')
    const hostStart = m.index + sep + at + 1
    const r = trimEnd(hostStart, authority.slice(at + 1))
    if (r) out.push(r)
  }
}

/**
 * Хост в «user@host»: один линейный проход. «@» считается разделителем, если перед ним символ слова (не AT_STOP) и
 * он не внутри ссылки (там логин разбирает urlRanges, а «@» в пути и запросе — данные). Хост — только буквы, цифры,
 * точка и дефис; на первом «/», «?», «#», «\\» и любом другом символе он кончается, дальше — обычный текст
 * («a@b.ru/clients?fio=Иванов» прячет «Иванов»). «@ник» в начале слова не глушится — ник ищет contacts.ts.
 * Каждый символ хоста просматривается один раз: следующий «@» не символ хоста, расширения не перекрываются.
 */
function atHostRanges(text: string, urls: TextRange[], out: TextRange[]): void {
  let u = 0
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]!
    if (ch !== '@' && ch !== '＠') continue
    while (u < urls.length && urls[u]!.end <= i) u++
    if (u < urls.length && urls[u]!.start <= i) continue
    if (AT_STOP.test(text[i - 1]!)) continue
    let j = i + 1
    while (j < text.length && HOST_CHAR.test(text[j]!)) j++
    const r = trimEnd(i + 1, text.slice(i + 1, j))
    if (r) out.push(r)
  }
}

/** Технические фрагменты текста (что глушить перед поиском имён), слитые в непересекающиеся отрезки по порядку. */
export function technicalSpans(text: string): TextRange[] {
  if (!text) return []
  const raw: TextRange[] = []
  urlRanges(text, raw)
  for (const re of [RE_WWW, RE_DOMAIN]) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const r = trimEnd(m.index, m[0])
      if (r) raw.push(r)
    }
  }
  RE_URL_FULL.lastIndex = 0
  const urls = Array.from(text.matchAll(RE_URL_FULL), m => ({ start: m.index, end: m.index + m[0].length }))
  atHostRanges(text, urls, raw)
  raw.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: TextRange[] = []
  for (const r of raw) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}
