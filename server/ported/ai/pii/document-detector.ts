/**
 * Детектор ПДн без словаря для документов третьих лиц.
 * Решение суда, иск, договор: стороны нам неизвестны, словаря людей нет. Поэтому людей, адреса и номера
 * узнаём по написанию.
 *
 * Что сознательно НЕ прячем: ИНН и ОГРН организаций, названия организаций и органов, суды, законы, номера дел, суммы,
 * даты документов. На этом держится сама работа юриста: подсудность, сроки, расчёты, сверка цитат.
 * Правила свои, без зависимостей: нативные NER-модели в Alpine уже ломались, а падение детектора — это открытые ПДн.
 */
import { contactPiiSpans, normalizePhone } from './contacts'
import { givenName, isGenderAmbiguousSurname, looksLikeSurname, patronymic, PersonRegistry, surnameShape, type DocumentPerson, type PersonCandidate } from './document-person'
import { isAbbreviation, isHistoricalName, isNotInitials, isStopWord } from './document-stoplist'
import type { PiiGender, PiiKind, PiiSpan } from './types'

export interface DocumentDetectorOptions {
  /**
   * Оставлять открытым город с пометкой «г.» и регион, пряча индекс и всё ниже города. По умолчанию да:
   * от города зависит подсудность (ст. 28 ГПК РФ), без него юрист не проверит суд. Выключение прячет и город.
   */
  keepCity?: boolean
}

/** Буквы в обоих регистрах: регистр важен для фамилий, поэтому флаг i на всю регулярку ставить нельзя. */
function ci(word: string): string {
  return [...word].map((ch) => {
    const low = ch.toLowerCase()
    const up = ch.toUpperCase()
    return low === up ? ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') : `[${low}${up}]`
  }).join('')
}

const NOT_BEFORE = '(?<![\\p{L}\\d_])'
const NOT_AFTER = '(?![\\p{L}\\d_])'
const CAP_WORD = '(?:[А-ЯЁ][а-яё]+(?:-(?:\\r?\\n[ \\t]*)?[А-ЯЁ]?[а-яё]+)*|[А-ЯЁ]{2,}(?:-[А-ЯЁ]{2,})*)'
const MONTHS = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря'

// ── Токены для поиска людей ────────────────────────────────────────────────────

interface Token {
  start: number
  end: number
  text: string
  type: 'word' | 'initial' | 'ogly'
}

const RE_TOKEN = new RegExp(`${NOT_BEFORE}(?:(${CAP_WORD})|([А-ЯЁ])\\.|(оглы|кызы|улы|гызы|ОГЛЫ|КЫЗЫ))`, 'gu')
/** Между частями имени только пробелы и не больше одного перевода строки: так рвёт имя вёрстка PDF. */
const RE_GAP = /^[ \t ]*(?:\r?\n[ \t ]*)?$/

function tokenize(text: string): Token[] {
  const out: Token[] = []
  for (const m of text.matchAll(RE_TOKEN)) {
    const start = m.index
    if (m[2]) out.push({ start, end: start + 2, text: m[2], type: 'initial' })
    else if (m[3]) out.push({ start, end: start + m[3].length, text: m[3], type: 'ogly' })
    else out.push({ start, end: start + m[1]!.length, text: m[1]!.replace(/-\r?\n[ \t]*(?=[а-яё])/g, '').replace(/\r?\n[ \t]*/g, ''), type: 'word' })
  }
  return out
}

function adjacent(text: string, a: Token | undefined, b: Token | undefined, requireGap = true): boolean {
  if (!a || !b) return false
  if (a.end === b.start) return !requireGap
  const gap = text.slice(a.end, b.start)
  return gap.length <= 60 && RE_GAP.test(gap)
}

/** Перед инициалами стоит «им.»/«имени»: «им. М.В. Ломоносова» — название, а не сторона дела. */
function isHonorific(text: string, start: number): boolean {
  return /(?:^|[^\p{L}])(?:им\.|имени)\s*$/iu.test(text.slice(Math.max(0, start - 8), start))
}

/**
 * Перед фамилией из названий стоит слово, с которым это награда, улица или адресат почестей, а не сторона дела.
 * Учреждения («университет», «школа») сюда не входят: «директор школы Анна Жукова» — живой человек, а у названий есть «им.».
 */
const RE_MEMORIAL_BEFORE = /(?:^|[^\p{L}])(?:им\.|имени|орден\p{L}*|медал\p{L}*|наград\p{L}*|преми[ияюе]\p{L}*|памятник\p{L}*|монумент\p{L}*|улиц\p{L}*|ул\.|площад\p{L}*|пл\.|проспект\p{L}*|просп\.|пр-кт|пр-т|переул\p{L}*|пер\.|набережн\p{L}*|наб\.|бульвар\p{L}*|б-р|шоссе|маршал\p{L}*|адмирал\p{L}*|генералиссимус\p{L}*|полковод\p{L}*|княз\p{L}*)[\s\u00a0«"]*$/iu

/** Историческая фамилия в названии: «медаль Жукова», «орден Александра Невского». Без такого слова — обычный человек. */
function isMemorial(text: string, start: number, surname: string): boolean {
  return isHistoricalName(surname) && RE_MEMORIAL_BEFORE.test(text.slice(Math.max(0, start - 24), start))
}

// ── Контекст для голой фамилии ─────────────────────────────────────────────────

/** Сильный контекст: дальше по смыслу идёт имя, поэтому фамилия может быть любой формы. */
const STRONG_CONTEXT = [
  'истец', 'истца', 'истцу', 'истцом', 'истце', 'истица', 'истицы', 'истице', 'истицу', 'истицей',
  'ответчик', 'ответчика', 'ответчику', 'ответчиком', 'ответчике', 'ответчица', 'ответчицы', 'ответчице', 'ответчицу', 'ответчицей',
  'гражданин', 'гражданина', 'гражданину', 'гражданином', 'гражданине', 'гражданка', 'гражданки', 'гражданке', 'гражданку', 'гражданкой',
  'гр.', 'в лице', 'заявитель', 'заявителя', 'заявителю', 'заявителем', 'заявителе',
  'должник', 'должника', 'должнику', 'должником', 'взыскатель', 'взыскателя', 'взыскателю', 'взыскателем',
  'потерпевший', 'потерпевшего', 'потерпевшему', 'потерпевшая', 'потерпевшей', 'потерпевшую',
  'свидетель', 'свидетеля', 'свидетелю', 'свидетелем', 'подсудимый', 'подсудимого', 'подсудимому', 'подсудимая', 'подсудимой',
  'обвиняемый', 'обвиняемого', 'обвиняемому', 'обвиняемая', 'обвиняемой', 'осуждённый', 'осужденный', 'осуждённого', 'осужденного',
  'адвокат', 'адвоката', 'адвокату', 'адвокатом', 'нотариус', 'нотариуса', 'нотариусу', 'нотариусом',
  'представитель', 'представителя', 'представителю', 'представителем', 'представителе',
  'судья', 'судьи', 'судье', 'судью', 'судьёй', 'судьей', 'супруг', 'супруга', 'супругу', 'супругом', 'супруге', 'супругой',
  'индивидуальный предприниматель', 'индивидуального предпринимателя', 'индивидуальному предпринимателю', 'индивидуальным предпринимателем',
]

/** Слабый контекст: должность. Рядом часто стоит не имя («директор Департамента»), поэтому нужна форма фамилии. */
const WEAK_CONTEXT = [
  'директор', 'директора', 'директору', 'директором', 'директоре', 'руководитель', 'руководителя', 'руководителю', 'руководителем',
  'председатель', 'председателя', 'председателю', 'председателем', 'начальник', 'начальника', 'начальнику', 'начальником',
  'бухгалтер', 'бухгалтера', 'бухгалтеру', 'бухгалтером', 'секретарь', 'секретаря', 'секретарю', 'секретарём', 'секретарем',
  'заместитель', 'заместителя', 'заместителю', 'заместителем', 'прокурор', 'прокурора', 'прокурору', 'прокурором',
  'следователь', 'следователя', 'следователю', 'следователем', 'пристав', 'пристава', 'приставу', 'приставом',
  'работник', 'работника', 'работнику', 'работником', 'сотрудник', 'сотрудника', 'сотруднику', 'сотрудником',
  'наследник', 'наследника', 'наследнику', 'наследником', 'покупатель', 'покупателя', 'покупателю', 'покупателем',
  'продавец', 'продавца', 'продавцу', 'продавцом', 'арендатор', 'арендатора', 'арендатору', 'арендатором',
]

/** Длинные варианты первыми: иначе «истец» съест начало «истица» при чередовании. */
const byLength = (a: string, b: string): number => b.length - a.length
const RE_STRONG_CONTEXT = new RegExp(`(?:${NOT_BEFORE}(?:${[...STRONG_CONTEXT].sort(byLength).map(ci).join('|')})|(?<![\\p{L}\\d_/-])ИП)[:\\s\\u00a0]+`, 'gu')
const RE_WEAK_CONTEXT = new RegExp(`${NOT_BEFORE}(?:${[...WEAK_CONTEXT].sort(byLength).map(ci).join('|')})[:\\s\\u00a0]+`, 'gu')

/** Прилагательное за контекстом обычно начало названия: «в лице Первогорского филиала», «директор Энского завода». */
function isAdjectiveForm(word: string): boolean {
  return /(?:ый|ий|ой|ая|ого|ому|ым|им|ую)$/.test(word.toLowerCase())
}

// ── Род по окружению ───────────────────────────────────────────────────────────

/** После этих слов «Иванова» — родительный или винительный мужчины: женщина была бы «Ивановой» или «Иванову». */
const BEFORE_MALE_A = new Set(`с со от у для против из до без кроме после возле около на за про через относительно пользу отношении стороны интересах адрес
истца ответчика заявителя должника взыскателя гражданина потерпевшего подсудимого обвиняемого осужденного свидетеля адвоката нотариуса представителя судьи
директора руководителя председателя начальника работника сотрудника`.split(/\s+/))
/** После этих слов «Иванову» — дательный мужчины. */
const BEFORE_MALE_U = new Set(`к ко по истцу ответчику заявителю должнику взыскателю гражданину потерпевшему подсудимому обвиняемому свидетелю адвокату нотариусу представителю
директору руководителю председателю начальнику работнику сотруднику`.split(/\s+/))
/** Именительный при слове о стороне: падеж фамилии тот же, значит «Иванова» — женщина. «Представитель Иванова» сюда нарочно не входит: это и «его представитель». */
const BEFORE_FEMALE_A = new Set(`истец ответчик заявитель должник взыскатель свидетель судья нотариус директор истица ответчица гражданка потерпевшая подсудимая обвиняемая`.split(/\s+/))
/** После этих слов «Иванову» — винительный женщины. */
const BEFORE_FEMALE_U = new Set(`на за про через истицу ответчицу гражданку потерпевшую подсудимую обвиняемую`.split(/\s+/))
/** Сказуемое женского рода сразу за фамилией: «Иванова пояснила», «Иванова А.А. обратилась». */
const RE_FEMALE_VERB_AFTER = /^[\s,]*[а-яё]{2,}(?:ла|лась)(?![а-яё])/

/** Слова вокруг «Иванова»/«Иванову», по которым понятен род. Подсказки нет — undefined, тогда решает реестр (две метки). */
function surnameGenderFromContext(text: string, c: PersonCandidate): PiiGender | undefined {
  if (!c.surname || !isGenderAmbiguousSurname(c.surname)) return undefined
  const prev = /([\p{L}-]+)[\s\u00a0]+$/u.exec(text.slice(Math.max(0, c.start - 24), c.start))?.[1]?.toLowerCase().replace(/ё/g, 'е')
  const isA = /[аА]$/.test(c.surname)
  if (prev) {
    if ((isA ? BEFORE_MALE_A : BEFORE_MALE_U).has(prev)) return 'm'
    if ((isA ? BEFORE_FEMALE_A : BEFORE_FEMALE_U).has(prev)) return 'f'
  }
  return isA && RE_FEMALE_VERB_AFTER.test(text.slice(c.end, c.end + 40)) ? 'f' : undefined
}

// ── Поиск людей ────────────────────────────────────────────────────────────────

/** Все упоминания людей в тексте. Порядок: от надёжных форм к голым фамилиям. */
function findPersonCandidates(text: string): { strong: PersonCandidate[], bare: PersonCandidate[], tokens: Token[] } {
  const tokens = tokenize(text)
  const strong: PersonCandidate[] = []
  const bare: PersonCandidate[] = []
  const usable = (t: Token | undefined): t is Token => t?.type === 'word' && !isStopWord(t.text)
  const initialsOf = (first?: string, patr?: string) => `${first?.[0] ?? ''}${patr?.[0] ?? ''}`.toUpperCase()

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!

    if (t.type === 'word') {
      const sameLine = (a: Token | undefined, b: Token | undefined) => !!a && !!b && !/\r?\n/.test(text.slice(a.end, b.start))
      // Имя + отчество и фамилия с любой стороны: «Иванов Иван Иванович», «Иван Иванович Иванов», «Иван Иванович».
      if (patronymic(t.text) && adjacent(text, tokens[i - 1], t) && usable(tokens[i - 1])) {
        const name = tokens[i - 1]!
        const before = tokens[i - 2]
        const after = tokens[i + 1]
        const beforeReady = usable(before) && adjacent(text, before, name)
        const afterIsSurname = usable(after) && adjacent(text, t, after) && looksLikeSurname(after.text)
          && !(beforeReady && sameLine(before, name) && !sameLine(t, after))
        if (beforeReady && !(afterIsSurname && !looksLikeSurname(before.text))) {
          strong.push({ start: before.start, end: t.end, surname: before.text, first: name.text, patronymic: t.text, initials: initialsOf(name.text, t.text) })
        } else if (afterIsSurname) {
          strong.push({ start: name.start, end: after.end, surname: after.text, first: name.text, patronymic: t.text, initials: initialsOf(name.text, t.text) })
        } else if (givenName(name.text)) {
          strong.push({ start: name.start, end: t.end, first: name.text, patronymic: t.text, initials: initialsOf(name.text, t.text) })
        }
      }

      // Кавказские и тюркские отчества: «Алиев Али Гасан оглы».
      const next = tokens[i + 1]
      if (next?.type === 'ogly' && adjacent(text, t, next) && usable(tokens[i - 1]) && adjacent(text, tokens[i - 1], t)) {
        const name = tokens[i - 1]!
        const before = tokens[i - 2]
        const start = usable(before) && adjacent(text, before, name) ? before.start : name.start
        const surname = usable(before) && adjacent(text, before, name) ? before.text : name.text
        strong.push({ start, end: next.end, surname, first: name.text, initials: initialsOf(name.text, t.text) })
      }

      // Фамилия + инициалы: «Иванов И.И.», «ИВАНОВ И. И.», «Иванов И.И», «Мамедов Э.Р. оглы».
      if (next?.type === 'initial' && adjacent(text, t, next) && !isStopWord(t.text)) {
        const second = tokens[i + 2]
        if (second?.type === 'initial' && adjacent(text, next, second, false)) {
          if (!isNotInitials(next.text + second.text) && !isHonorific(text, t.start)) {
            const afterInit = tokens[i + 3]
            const end = afterInit?.type === 'ogly' && adjacent(text, second, afterInit) ? afterInit.end : second.end
            strong.push({ start: t.start, end, surname: t.text, initials: next.text + second.text })
          }
        } else if (looksLikeSurname(t.text)) {
          const end = second?.type === 'ogly' && adjacent(text, next, second) ? second.end : next.end
          strong.push({ start: t.start, end, surname: t.text, initials: next.text })
        }
      }

      // Инициалы без точек: «Иванов ИИ», «ИВАНОВ И И». Только при форме фамилии: «Законов РФ» сюда не должен попасть.
      if (next?.type === 'word' && /^[А-ЯЁ]{2}$/.test(next.text) && !isAbbreviation(next.text) && looksLikeSurname(t.text) && !isStopWord(t.text) && adjacent(text, t, next)) {
        strong.push({ start: t.start, end: next.end, surname: t.text, initials: next.text })
      }

      // Имя + фамилия в любом порядке: «Анна Смирнова», «Смирнова Анна». Имя-слово («Вера», «Роман») — только с формой фамилии.
      if (usable(t) && usable(next) && adjacent(text, t, next) && !patronymic(next.text) && !isMemorial(text, t.start, next.text)) {
        const g = givenName(t.text)
        const g2 = givenName(next.text)
        if (g && !g2 && (looksLikeSurname(next.text) || !g.risky)) {
          strong.push({ start: t.start, end: next.end, surname: next.text, first: t.text, initials: t.text[0]!.toUpperCase() })
        } else if (g2 && !g && looksLikeSurname(t.text)) {
          const after = tokens[i + 2]
          if (!(after && patronymic(after.text) && adjacent(text, next, after))) {
            strong.push({ start: t.start, end: next.end, surname: t.text, first: next.text, initials: next.text[0]!.toUpperCase() })
          }
        }
      }
    }

    // Инициалы + фамилия: «И.И. Иванов», «И. И. Иванов», «И. Иванов».
    if (t.type === 'initial' && !/[\p{L}\d.]/u.test(text[t.start - 1] ?? ' ') && !isHonorific(text, t.start)) {
      const b = tokens[i + 1]
      const c = tokens[i + 2]
      if (b?.type === 'initial' && adjacent(text, t, b, false) && usable(c) && adjacent(text, b, c, false)) {
        if (!isNotInitials(t.text + b.text) && !isMemorial(text, t.start, c.text)) strong.push({ start: t.start, end: c.end, surname: c.text, initials: t.text + b.text })
      } else if (usable(b) && adjacent(text, t, b) && looksLikeSurname(b.text) && !isMemorial(text, t.start, b.text)) {
        strong.push({ start: t.start, end: b.end, surname: b.text, initials: t.text })
      }
    }
  }

  // Голая фамилия после контекста: «истец Иванов», «в лице директора Петрова», «ИП Сидоров».
  const byStart = new Map(tokens.map((t, idx) => [t.start, idx]))
  const collect = (re: RegExp, strength: 'strong' | 'weak') => {
    for (const m of text.matchAll(re)) {
      const idx = byStart.get(m.index + m[0].length)
      if (idx === undefined) continue
      const t = tokens[idx]!
      if (!usable(t)) continue
      const next = tokens[idx + 1]
      // За контекстом идёт название: «в лице Первогорского филиала», «представитель Энского УФАС».
      const after = text.slice(t.end).match(/^[ \t ]+(\p{L}+)/u)?.[1]
      // «ответчику Ивановой» — женщина; «в лице Единой комиссии» — название: за ним строчное слово в падеже.
      const femaleSurname = strength === 'strong' && /(?:ов|ев|ин|ын)ой$/.test(t.text.toLowerCase()) && !(after && /^\p{Ll}+[аыиуе]$/u.test(after))
      if (isAdjectiveForm(t.text) && !femaleSurname && !/(?:[сц]к(?:ий|ого|ому|им|ая|ой|ую))$/.test(t.text.toLowerCase())) continue
      // Два прилагательных подряд — название («Евразийского экономического союза»), а не фамилия.
      if (isAdjectiveForm(t.text) && after && /^\p{Ll}/u.test(after) && isAdjectiveForm(after)) continue
      if (isAdjectiveForm(t.text) && after && /^(?:филиал|завод|фабрик|район|област|кра[йя]|суд|отдел|управлени|департамент|университет|институт|УФАС)/iu.test(after)) continue
      if (strength === 'weak' && !looksLikeSurname(t.text)) continue
      if (usable(next) && adjacent(text, t, next) && givenName(next.text)) {
        bare.push({ start: t.start, end: next.end, surname: t.text, first: next.text, initials: next.text[0]!.toUpperCase() })
      } else {
        bare.push({ start: t.start, end: t.end, surname: t.text, initials: '' })
      }
    }
  }
  collect(RE_STRONG_CONTEXT, 'strong')
  collect(RE_WEAK_CONTEXT, 'weak')
  for (const c of [...strong, ...bare]) c.contextGender = surnameGenderFromContext(text, c)
  return { strong, bare, tokens }
}

/** Латиница в реквизитах и подписях: «Ivanov I.I.», «I.I. Ivanov». */
const RE_LATIN_PERSON = new RegExp(`${NOT_BEFORE}(?:[A-Z][a-z]{2,}\\s+[A-Z]\\.\\s?[A-Z]\\.|[A-Z]\\.\\s?[A-Z]\\.\\s?[A-Z][a-z]{2,})${NOT_AFTER}`, 'gu')

// ── Номера ─────────────────────────────────────────────────────────────────────

interface NumberRule {
  kind: PiiKind
  re: RegExp
  /** Номер группы со значением; 0 — всё совпадение. */
  group: number
  /** Дополнительная проверка найденного. */
  check?: (value: string, text: string, start: number) => boolean
}

function digitsOf(s: string): string {
  return s.replace(/\D/g, '')
}

/** Контрольная сумма ИНН физлица: двенадцатизначное число без слова «ИНН» считаем ИНН только при совпадении. */
function isValidPersonalInn(d: string): boolean {
  if (d.length !== 12) return false
  const sum = (w: number[]) => (w.reduce((acc, k, i) => acc + k * Number(d[i]), 0) % 11) % 10
  return sum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[10]) && sum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[11])
}

function isLuhnValid(d: string): boolean {
  let sum = 0
  let double = false
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i])
    if (double) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    double = !double
  }
  return sum % 10 === 0
}

const DATE_VALUE = `(?:\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|\\d{1,2}\\s+(?:${MONTHS})\\s+\\d{4})`
const PLATE_LETTER = '[АВЕКМНОРСТУХABEKMHOPCTYX]'
const SP = '[\\s\\u00a0]'

const NUMBER_RULES: NumberRule[] = [
  // Паспорт: само слово «паспорт» остаётся, юристу важно, что он был указан. Слово «серия» уходит в значение: иначе модель
  // видит «серия Паспорт_1», считает, что номера нет, и ложно требует дописать его (прогон 03.11.2026, чистый иск k4).
  { kind: 'passport', re: new RegExp(`${NOT_BEFORE}${ci('паспорт')}\\p{L}*(?:${SP}+\\p{L}+\\.?){0,4}?[:\\s\\u00a0]*((?:${ci('сери')}\\p{L}*[:\\s\\u00a0]*)?\\d{2}${SP}?\\d{2}${SP}*(?:№|N|${ci('номер')}|${ci('н.')})?${SP}*\\d{6})(?!\\d)`, 'gu'), group: 1 },
  { kind: 'passport', re: new RegExp(`${NOT_BEFORE}(${ci('сери')}[яиюе]\\p{L}*[:\\s\\u00a0]*\\d{2}${SP}?\\d{2}${SP}*(?:№|N|${ci('номер')}|${ci('н.')})?${SP}*\\d{6})(?!\\d)`, 'gu'), group: 1 },
  { kind: 'passport', re: new RegExp(`${ci('код')}${SP}+${ci('подразделения')}[:\\s\\u00a0]*(\\d{3}-\\d{3})(?!\\d)`, 'gu'), group: 1 },
  // ИНН физлица: 12 цифр (в т.ч. разорванный переносом строки после «ИНН» или полного названия). Десятизначный ИНН организации сюда не попадает.
  { kind: 'inn', re: new RegExp(`(?:${ci('ИНН')}|${ci('идентификационн')}\\p{L}*${SP}+${ci('номер')}\\p{L}*${SP}+${ci('налогоплательщика')})[^\\d]{0,24}?(\\d{12}|\\d{1,11}\\r?\\n[ \\t]*\\d{1,11})(?!\\d)`, 'gu'), group: 1, check: v => digitsOf(v).length === 12 },
  { kind: 'inn', re: /(?<![\d-])\d{12}(?![\d-])/gu, group: 0, check: isValidPersonalInn },
  { kind: 'ogrnip', re: new RegExp(`(?:${ci('ОГРНИП')}|${ci('качестве')}${SP}+(?:${ci('индивидуального')}${SP}+)?${ci('предпринимателя')})[:\\s\\u00a0№]*(\\d{15})(?!\\d)`, 'gu'), group: 1 },
  { kind: 'snils', re: /(?<![\d-])\d{3}-(?:\r?\n[ \t]*)?\d{3}-(?:\r?\n[ \t]*)?\d{3}[ \t\r\n-]{1,3}\d{2}(?![\d-])/gu, group: 0, check: v => digitsOf(v).length === 11 },
  { kind: 'snils', re: new RegExp(`${ci('СНИЛС')}[:\\s\\u00a0№]*(\\d{3}[\\s-]?\\d{3}[\\s-]?\\d{3}[\\s-]?\\d{2})(?!\\d)`, 'gu'), group: 1 },
  // Дата рождения: только рядом со словом о рождении, иначе это дата документа.
  { kind: 'birthdate', re: new RegExp(`${NOT_BEFORE}(?:${ci('родил')}\\p{L}*|${ci('дата')}${SP}+${ci('рождения')}|${ci('д.р.')}|${ci('г.р.')}|${ci('рожд.')}|${ci('рождения')})[:,\\s\\u00a0(-]*(${DATE_VALUE}(?:${SP}*(?:г\\.|года))?)`, 'gu'), group: 1 },
  { kind: 'birthdate', re: new RegExp(`(?<!\\d)(${DATE_VALUE})${SP}*(?:г\\.?${SP}?р\\.?|г(?:ода|\\.)${SP}+рождения|рождения)`, 'gu'), group: 1 },
  { kind: 'birthdate', re: new RegExp(`(?<!\\d)(\\d{4})${SP}*(?:г\\.${SP}?р\\.?|г${SP}?р\\.|года${SP}+рождения)`, 'gu'), group: 1 },
  { kind: 'license', re: new RegExp(`(?:${ci('водительск')}\\p{L}*${SP}+${ci('удостоверени')}\\p{L}*|${ci('в/у')}|(?<![\\p{L}])ВУ)(?:${SP}+\\p{L}+\\.?){0,3}?[:\\s\\u00a0№]*(\\d{2}${SP}?[\\dА-ЯЁ]{2}${SP}?№?${SP}?\\d{6})(?!\\d)`, 'gu'), group: 1 },
  { kind: 'card', re: /(?<![\d-])\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}(?:[ -]\d{2,3})?(?![\d-])/gu, group: 0, check: v => isLuhnValid(digitsOf(v)) },
  { kind: 'card', re: new RegExp(`${ci('карт')}\\p{L}*[^\\d]{0,24}?((?:\\d[ \\t\\r\\n-]?){13,19})(?!\\d)`, 'gu'), group: 1, check: v => digitsOf(v).length >= 13 && digitsOf(v).length <= 19 },
  { kind: 'card', re: /(?<!\d)\d{16}(?!\d)/gu, group: 0, check: isLuhnValid },
  {
    kind: 'account',
    re: /(?<![\d-])(?:\d{20}|(?:408|423)\d{1,17}\r?\n[ \t]*\d{1,17}|\d{5}[ -]\d{3}[ -]\d[ -]\d{4}[ -]\d{7}|\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4})(?![\d-])/gu,
    group: 0,
    check: (value, text, start) => {
      const d = digitsOf(value)
      if (d.length !== 20) return false
      // Корреспондентский счёт, казначейские счета и счета организаций (40101–40703) — не данные человека. ИП — 40802, вклады и физлица — 408, 423.
      if (/^(?:30101|03|40[1-7])/.test(d)) return false
      return !/(?:КБК|УИН|ОКТМО|к\/с|кор|казначейск\p{L}*)[^\n]{0,20}$/iu.test(text.slice(Math.max(0, start - 28), start))
    },
  },
  { kind: 'vehicle', re: new RegExp(`(?<![\\p{L}\\d_-])${PLATE_LETTER}${SP}?\\d{3}${SP}?${PLATE_LETTER}{2}${SP}?\\d{2,3}(?:${SP}?(?:RUS|РУС))?${NOT_AFTER}`, 'gu'), group: 0 },
  { kind: 'vehicle', re: new RegExp(`(?:${ci('прицеп')}|${ci('полуприцеп')}|${ci('грз')}|${ci('госномер')})\\p{L}*[:\\s\\u00a0]*?(${PLATE_LETTER}{2}${SP}?\\d{6,7}(?:${SP}?(?:RUS|РУС))?)${NOT_AFTER}`, 'gu'), group: 1 },
  { kind: 'vehicle', re: /(?<![\p{L}\d_-])[авекмнорстух]\d{3}[авекмнорстух]{2}[\s\u00a0]?\d{2,3}(?![\p{L}\d_])/gu, group: 0 },
  { kind: 'vehicle', re: new RegExp(`${ci('VIN')}[:\\s\\u00a0№-]*([A-HJ-NPR-Z0-9]{17})(?![A-Z0-9])`, 'gu'), group: 1 },
]

/** Строгие правила для телефона: общий поиск контактов принимает за номер длинные реквизиты, суммы и номера дел. */
const RE_PHONE_FORMATTED = new RegExp(`(?<![\\d\\p{L}_/.-])((?:\\+${SP}?\\d{1,3}|8|7)[\\s\\u00a0(.-]*\\d{3,5}[\\s\\u00a0).-]*\\d{1,3}[\\s\\u00a0.-]*\\d{2}[\\s\\u00a0.-]*\\d{2})(?:[,;]?${SP}*(?:${ci('доб')}|${ci('вн')})\\.?${SP}*\\d{1,6})?(?![\\d\\p{L}])`, 'gu')
/** Мобильный без 8 и +7: «912 345-67-89», «9123456789». Суммы так не пишут, а ИНН организаций отсекает контекст слева. */
const RE_PHONE_MOBILE = /(?<![\d\p{L}_/.,-])9\d{2}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?![\d\p{L}/-])/gu
const RE_PHONE_CITY = /(?<![\d\p{L}_/.-])\(\d{3,5}\)[\s ]*\d{1,3}[\s -]\d{2}[\s -]\d{2}(?![\d\p{L}])/gu
const RE_PHONE_CONTEXT = new RegExp(`${NOT_BEFORE}(?:${ci('тел.')}|${ci('телефон')}\\p{L}*|${ci('моб.')}|${ci('мобильный')}|${ci('сот.')}|${ci('факс')}|whatsapp|viber)[:\\s\\u00a0]*(\\+?[\\d(][\\d\\s\\u00a0().-]{4,16}\\d)(?![\\d\\p{L}])`, 'gu')
const RE_NOT_PHONE_CONTEXT = /(?:ИНН|ОГРН|КПП|БИК|ОКПО|ОКТМО|КБК|УИН|№|N|р\/с|к\/с|сч[её]т)[\s:]*$/iu

function phoneSpans(text: string): PiiSpan[] {
  const out: PiiSpan[] = []
  const add = (start: number, end: number) => {
    const raw = text.slice(start, end)
    out.push({ start, end, kind: 'phone', key: normalizePhone(raw), canonical: raw })
  }
  for (const m of text.matchAll(RE_PHONE_FORMATTED)) {
    const core = m[1]!
    const d = digitsOf(core)
    if (d.length < 10 || d.length > 15) continue
    if (!core.startsWith('+') && d.length !== 11) continue
    if (RE_NOT_PHONE_CONTEXT.test(text.slice(Math.max(0, m.index - 10), m.index))) continue
    add(m.index, m.index + m[0].length)
  }
  for (const m of text.matchAll(RE_PHONE_MOBILE)) {
    if (RE_NOT_PHONE_CONTEXT.test(text.slice(Math.max(0, m.index - 10), m.index))) continue
    add(m.index, m.index + m[0].length)
  }
  for (const m of text.matchAll(RE_PHONE_CITY)) add(m.index, m.index + m[0].length)
  for (const m of text.matchAll(RE_PHONE_CONTEXT)) {
    const value = m[1]!
    const d = digitsOf(value)
    if (d.length < 5 || d.length > 15) continue
    const start = m.index + m[0].length - value.length
    add(start, start + value.length)
  }
  return out
}

// ── Адреса ─────────────────────────────────────────────────────────────────────

const INLINE = '[ \\t\\u00a0]'
const STREET_NAME_WORD = '(?:[А-ЯЁ]\\.)?[А-ЯЁ][\\p{L}]*(?:-(?:\\r?\\n[ \\t]*)?[\\p{L}]+)*\\.?'
/** Название жадно и в пределах строки: «ул. 40 лет Октября», «ул. Новая Заводская», «ул. К.Маркса». Со следующей строки слова не берём: там обычно уже другой реквизит. */
const STREET_NAME = `(?:\\d{1,3}(?:-[а-яё]{1,2})?${INLINE}+(?:лет${INLINE}+)?)?[«"]?${STREET_NAME_WORD}[»"]?(?:${INLINE}+(?:им\\.|имени|де|${STREET_NAME_WORD}))*`

const STREET_TYPES_SAFE = ['ул.', 'ул', 'улица', 'улицы', 'улице', 'улицу', 'улицей', 'пр-т', 'пр-кт', 'просп.', 'проспект', 'проспекта', 'проспекту', 'проспекте', 'пер.', 'переулок', 'переулка', 'переулке', 'пл.', 'наб.', 'б-р', 'бул.', 'пр-д', 'мкр.', 'мкр', 'мкрн', 'микрорайон', 'микрорайона', 'микрорайоне', 'кв-л', 'туп.', 'снт', 'днт', 'днп', 'тсн', 'гск']
const STREET_TYPES_RISKY = ['площадь', 'площади', 'набережная', 'набережной', 'бульвар', 'бульвара', 'бульваре', 'шоссе', 'проезд', 'проезда', 'проезде', 'квартал', 'квартала', 'квартале', 'тупик', 'тупика', 'тупике', 'аллея', 'аллеи', 'аллее', 'линия', 'линии']

const HOUSE = `(?:${NOT_BEFORE}(?:${ci('д.')}|${ci('д')}|${ci('дом')}|${ci('дома')}|${ci('зд.')}|${ci('здание')}|${ci('вл.')}|${ci('владение')}|${ci('уч.')}|${ci('участок')})${SP}*№?${SP}*\\d+[\\p{L}]?(?:[/-]\\d+[\\p{L}]?)*)`
const PART = `(?:(?:${ci('корп.')}|${ci('корпус')}|${ci('к.')}|${ci('стр.')}|${ci('строение')}|${ci('лит.')}|${ci('литер')}|${ci('литера')}|${ci('кв.')}|${ci('квартира')}|${ci('оф.')}|${ci('офис')}|${ci('пом.')}|${ci('помещение')}|${ci('ком.')}|${ci('комн.')}|${ci('комната')}|${ci('эт.')}|${ci('этаж')}|${ci('каб.')}|${ci('кабинет')})${SP}*№?${SP}*(?:\\d+[\\p{L}]?(?:[/-]\\d+)*|[А-ЯЁA-Z]${NOT_AFTER}))`
const TAIL = `(?:[,;]?${SP}*${HOUSE})?(?:[,;]?${SP}*${PART})*`
/** Номер дома без слова «д.»: «ул. Мира, 5», «Мира 5-10». Запятая или пробел, потом число не длиннее 4 цифр. */
const BARE_HOUSE = `(?:[,]?${SP}*\\d{1,4}[\\p{L}]?(?:[/-]\\d{1,4}[\\p{L}]?)*(?![\\d\\p{L}.,]*\\d{3}))`

const RE_STREET = new RegExp(`${NOT_BEFORE}(${[...STREET_TYPES_SAFE].sort(byLength).map(ci).join('|')})(?<=\\.|[\\p{L}])${SP}*(${STREET_NAME})((?:${BARE_HOUSE})?${TAIL})`, 'gu')
const RE_STREET_RISKY = new RegExp(`${NOT_BEFORE}(?:${[...STREET_TYPES_RISKY].sort(byLength).map(ci).join('|')})${SP}+(${STREET_NAME})((?:${BARE_HOUSE})?${TAIL})`, 'gu')
/** Название перед типом: «Ленина ул., д. 5», «Тверская улица, 3». Без номера дома слишком похоже на обычный текст. */
const RE_STREET_REVERSED = new RegExp(`${NOT_BEFORE}[А-ЯЁ][\\p{L}-]+${SP}+(?:ул\\.|улица|пр-т|проспект|пер\\.|переулок|шоссе|бульвар|б-р|наб\\.|набережная|проезд|площадь)[,]?${SP}*(?:${HOUSE}|\\d{1,4}[\\p{L}]?(?:[/-]\\d{1,4})*)(?:[,;]?${SP}*${PART})*`, 'gu')

const RE_VILLAGE = new RegExp(`(?<![\\p{L}\\d_.]\\s?)(?:с\\.|село|села|селе|д\\.|дер\\.|деревня|деревни|деревне|п\\.|пос\\.|посёлок|поселок|посёлка|поселка|посёлке|поселке|пгт\\.?|рп\\.?|р\\.п\\.|ст-ца|станица|станицы|станице|х\\.|хутор|хутора|хуторе)${SP}*([А-ЯЁ][\\p{L}-]{2,}(?:${SP}+[А-ЯЁ][\\p{L}-]{2,})?)(?:[,;]?${SP}*${HOUSE})?(?:[,;]?${SP}*${PART})*`, 'gu')

/** Город с пометкой — якорь: от него отсчитывается неполный адрес («г. Энск, Ленина, 5-10», «г. Энск, д. 5»). */
const CITY = `(?:${ci('г.')}|${ci('город')}|${ci('города')}|${ci('городе')})${SP}*[А-ЯЁ][\\p{L}-]+(?![\\p{L}-])`
const RE_CITY_THEN_HOUSE = new RegExp(`${NOT_BEFORE}${CITY}[,]?${SP}*((?:[А-ЯЁ][\\p{L}-]+(?:,${SP}*|${SP}+)(?:${HOUSE}|${BARE_HOUSE})|${HOUSE})(?:[,;]?${SP}*${PART})*)`, 'gu')

/** Остаток адреса без улицы: «д. 5, кв. 7» и отдельная «кв. 12». «л.д. 5» — лист дела, а не дом. */
const RE_ORPHAN = new RegExp(`(?<![\\p{L}\\d_.]\\s?)(?:(?:${ci('д.')}|${ci('дом')})${SP}*№?${SP}*\\d+[\\p{L}]?(?:/\\d+)?[,;]?${SP}*${ci('кв.')}${SP}*\\d+|${ci('кв.')}${SP}*\\d+[\\p{L}]?)${NOT_AFTER}`, 'gu')

const RE_INDEX = new RegExp(`(?<![\\d\\p{L}_./-])\\d{6}(?=[,\\s\\u00a0]+(?:${ci('г.')}|${ci('город')}|${ci('ул.')}|${ci('улица')}|${ci('обл')}|${ci('респ')}|${ci('край')}|${ci('Россия')}|${ci('Российская')}|${ci('РФ')}|с\\.|д\\.|п\\.|пос\\.|пгт|[А-ЯЁ][\\p{L}-]+${SP}+(?:${ci('обл')}|${ci('край')}|${ci('респ')}|${ci('АО')}|${ci('р-н')}|${ci('район')})))`, 'gu')
const RE_INDEX_CONTEXT = new RegExp(`${ci('индекс')}[:\\s\\u00a0]*(\\d{6})(?!\\d)|${ci('адрес')}\\p{L}*[:\\s\\u00a0]+(\\d{6})(?!\\d)`, 'gu')

/** Район сразу перед улицей или посёлком: мелкая география уже опознаёт. */
const RE_DISTRICT_BEFORE = new RegExp(`[А-ЯЁ][\\p{L}-]+${SP}+(?:${ci('р-н')}|${ci('район')})\\.?[,]?${SP}*$`, 'u')
const RE_DISTRICT_AFTER_TYPE = new RegExp(`(?:${ci('р-н')}|${ci('район')})\\.?${SP}+[А-ЯЁ][\\p{L}-]+[,]?${SP}*$`, 'u')
const RE_DISTRICT_TRAILING = new RegExp(`^,[ \\t\\u00a0]*(?:[А-ЯЁ][\\p{L}-]+${SP}+(?:${ci('р-н')}|${ci('район')})\\.?|(?:${ci('р-н')}|${ci('район')})\\.?${SP}+[А-ЯЁ][\\p{L}-]+)`, 'u')
/** Город и индекс перед адресом: если город решено прятать, адрес расширяется до них. */
const RE_CITY_BEFORE = new RegExp(`(?:\\d{6}[,]?${SP}*)?${CITY}[,]?${SP}*$`, 'u')

const RE_BIRTHPLACE = new RegExp(`(?:${ci('место')}${SP}+${ci('рождения')}|${ci('уроженец')}|${ci('уроженка')}|${ci('уроженца')}|${ci('уроженки')})[:\\s\\u00a0]+((?:[А-ЯЁ]|(?:г|с|д|п|пос|пгт|рп|ст-ца|х)\\.?${SP}*[А-ЯЁ])[^,;\\n]{2,80})`, 'gu')

function addressKey(raw: string): string {
  return raw.toLowerCase().replace(/ё/g, 'е').replace(/[\s,.;]+/g, ' ').trim()
}

/** Первое слово названия улицы из служебного списка: «проезд Российской Федерации» — не адрес. */
function isStreetNameWord(name: string): boolean {
  const first = /^[«"]?([\p{L}\d-]+)/u.exec(name)?.[1] ?? ''
  return !!first && !isStopWord(first)
}

function addressSpans(text: string, keepCity: boolean): PiiSpan[] {
  const out: PiiSpan[] = []
  const add = (rawStart: number, rawEnd: number) => {
    let start = rawStart
    let end = rawEnd
    // Хвостовая запятая, пробел и точка не адрес (кроме точки в сокращении, уже внутри).
    while (end > start && /[\s,;.]/.test(text[end - 1]!)) end--
    const before = text.slice(Math.max(0, start - 60), start)
    const district = RE_DISTRICT_BEFORE.exec(before) ?? RE_DISTRICT_AFTER_TYPE.exec(before)
    if (district) start -= before.length - district.index
    if (!keepCity) {
      const head = text.slice(Math.max(0, start - 60), start)
      const city = RE_CITY_BEFORE.exec(head)
      if (city) start -= head.length - city.index
    }
    const raw = text.slice(start, end)
    out.push({ start, end, kind: 'address', key: addressKey(raw), canonical: raw })
  }

  for (const m of text.matchAll(RE_STREET)) {
    // С номером дома это адрес, даже если название совпало со служебным словом: «ул. Судебная, д. 1», «мкр. Южный, 5».
    if (!isStreetNameWord(m[2]!) && !/\d/.test(m[3] ?? '')) continue
    add(m.index, m.index + m[0].length)
  }
  for (const m of text.matchAll(RE_STREET_RISKY)) {
    // Тип улицы без точки встречается и в обычном тексте: нужен номер дома или признак здания.
    if (!m[2] || !/\d/.test(m[2])) continue
    add(m.index, m.index + m[0].length)
  }
  for (const m of text.matchAll(RE_STREET_REVERSED)) add(m.index, m.index + m[0].length)
  for (const m of text.matchAll(RE_VILLAGE)) {
    if (isStopWord(m[1]!.split(/\s+/)[0]!)) continue
    let end = m.index + m[0].length
    const tail = RE_DISTRICT_TRAILING.exec(text.slice(end, Math.min(text.length, end + 60)))
    if (tail) end += tail[0].length
    add(m.index, end)
  }
  for (const m of text.matchAll(RE_CITY_THEN_HOUSE)) {
    const value = m[1]!
    if (!isStreetNameWord(value)) continue
    add(m.index + m[0].length - value.length, m.index + m[0].length)
  }
  for (const m of text.matchAll(RE_ORPHAN)) add(m.index, m.index + m[0].length)
  for (const m of text.matchAll(RE_INDEX)) add(m.index, m.index + 6)
  for (const m of text.matchAll(RE_INDEX_CONTEXT)) {
    const value = (m[1] ?? m[2])!
    const start = m.index + m[0].length - value.length
    add(start, start + value.length)
  }
  for (const m of text.matchAll(RE_BIRTHPLACE)) {
    const value = m[1]!
    const start = m.index + m[0].length - value.length
    add(start, start + value.length)
  }
  return out
}

// ── Детектор ───────────────────────────────────────────────────────────────────

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

interface ScannedText {
  strong: PersonCandidate[]
  bare: PersonCandidate[]
  tokens: Token[]
}

/**
 * Детектор на один вызов модели. prepare получает все тексты запроса заранее: тогда вопрос пользователя и документ
 * дают одного человека независимо от порядка, а голая «Иванов» связывается со всеми Ивановыми, что есть в документе.
 */
export class DocumentPiiDetector {
  private readonly registry = new PersonRegistry()
  private readonly scanned = new Map<string, ScannedText>()
  private readonly keepCity: boolean

  constructor(options: DocumentDetectorOptions = {}) {
    this.keepCity = options.keepCity !== false
  }

  private scan(text: string): ScannedText {
    const known = this.scanned.get(text)
    if (known) return known
    const found = findPersonCandidates(text)
    this.scanned.set(text, found)
    return found
  }

  /** Зарегистрировать людей из всех текстов: сначала полные формы, потом голые фамилии. */
  prepare(texts: readonly string[]): void {
    const all = texts.filter(Boolean).map(t => ({ text: t, found: this.scan(t) }))
    for (const { text, found } of all) {
      for (const c of found.strong) this.registry.resolve(c, collapse(text.slice(c.start, c.end)))
    }
    for (const { text, found } of all) {
      for (const c of found.bare) this.registry.resolve(c, collapse(text.slice(c.start, c.end)))
    }
  }

  private personSpan(c: PersonCandidate, person: DocumentPerson, text: string): PiiSpan {
    return {
      start: c.start,
      end: c.end,
      kind: 'person',
      key: `person:${person.id}`,
      canonical: collapse(text.slice(c.start, c.end)),
      render: ending => person.render(ending),
    }
  }

  private personSpans(text: string): PiiSpan[] {
    const found = this.scan(text)
    // Текст не проходил prepare (вызов вне обёртки): регистрируем на месте.
    this.prepare([text])
    const out: PiiSpan[] = []
    for (const c of [...found.strong, ...found.bare]) {
      out.push(this.personSpan(c, this.registry.resolve(c, collapse(text.slice(c.start, c.end))), text))
    }
    // Известная фамилия где угодно: «Иванов пояснил», шапка КАПСОМ, подпись.
    for (let i = 0; i < found.tokens.length; i++) {
      const t = found.tokens[i]!
      if (t.type !== 'word' || isStopWord(t.text)) continue
      const shape = surnameShape(t.text)
      if (!this.registry.knowsStem(shape.stem)) continue
      // Прилагательное-фамилия перед названием/существительным («Условная сделка», «УСЛОВНОЙ ОБЛАСТИ») при человеке Условный — не он.
      const tailSlice = text.slice(t.end, t.end + 24)
      if (/^[ \t ]+(?:обл\p{L}*|кра[йя]|район\p{L}*|округ\p{L}*|респ\p{L}*|уфас|фссп|овд|уфк|мвд)/iu.test(tailSlice)) continue
      if ((shape.cls === 'adj' || shape.cls === 'sky') && /^[ \t ]+[а-яё]/.test(tailSlice)) continue
      // «Анна Жукова» в документе не делает человеком «медаль Жукова» и «медаль Георгия Константиновича Жукова».
      let from = i
      while (from > 0 && i - from < 2) {
        const p = found.tokens[from - 1]!
        if (!adjacent(text, p, found.tokens[from], false) || !(p.type === 'initial' || givenName(p.text) || patronymic(p.text))) break
        from--
      }
      if (isMemorial(text, found.tokens[from]!.start, t.text)) continue
      const c: PersonCandidate = { start: t.start, end: t.end, surname: t.text, initials: '' }
      c.contextGender = surnameGenderFromContext(text, c)
      out.push(this.personSpan(c, this.registry.resolve(c, t.text), text))
    }
    for (const m of text.matchAll(RE_LATIN_PERSON)) {
      const raw = m[0]
      out.push({ start: m.index, end: m.index + raw.length, kind: 'person', key: `latin:${raw.toLowerCase()}`, canonical: raw })
    }
    return out
  }

  private numberSpans(text: string): PiiSpan[] {
    const out: PiiSpan[] = []
    for (const rule of NUMBER_RULES) {
      for (const m of text.matchAll(rule.re)) {
        const value = m[rule.group]
        if (!value) continue
        const start = m.index + m[0].length - value.length
        const realStart = rule.group === 0 ? m.index : (m[0].endsWith(value) ? start : m.index + m[0].indexOf(value))
        if (rule.check && !rule.check(value, text, realStart)) continue
        out.push({ start: realStart, end: realStart + value.length, kind: rule.kind, key: `${rule.kind}:${digitsOf(value) || value.toLowerCase()}`, canonical: value })
      }
    }
    return out
  }

  /** Все ПДн текста. Вытесняет пересечения хранилище (PiiVault.mask): длиннейший, при равенстве левее. */
  spans(text: string): PiiSpan[] {
    if (!text) return []
    // Почта и мессенджер из общего поиска контактов, телефоны — своими правилами: см. RE_PHONE_FORMATTED.
    const contacts = contactPiiSpans(text).filter(s => s.kind !== 'phone')
    return [
      ...this.personSpans(text),
      ...addressSpans(text, this.keepCity),
      ...this.numberSpans(text),
      ...phoneSpans(text),
      ...contacts,
    ]
  }
}
