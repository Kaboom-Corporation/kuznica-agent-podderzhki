/**
 * Метки ПДн: префиксы, разбор метки в тексте и восстановитель для стрима.
 * Метка — «Основа_N»: Сотрудница_7, Клиент_3, Телефон_12. Модель склоняет метку как слово
 * («Сотруднице_7», «Клиентом_3»), поэтому при возврате терпим любые буквы между основой и «_N».
 */
import type { PiiGender, PiiKind } from './types'

/** Основа метки по виду ПДн: общая часть всех падежей и родов («Сотрудни» — и Сотрудник, и Сотрудница). */
export const LABEL_STEMS: Readonly<Record<PiiKind, string>> = {
  employee: 'Сотрудни',
  client: 'Клиент',
  contact: 'Контакт',
  student: 'Учени',
  parent: 'Родител',
  phone: 'Телефон',
  email: 'Почт',
  messenger: 'Мессенджер',
  mention: 'Им',
  person: 'Человек',
  address: 'Адрес',
  passport: 'Паспорт',
  inn: 'ИННФЛ',
  ogrnip: 'ОГРНИП',
  snils: 'СНИЛС',
  birthdate: 'Дат',
  license: 'Водительск',
  card: 'Карт',
  account: 'Счёт',
  vehicle: 'Автомобил',
}

/** Написание основы, которое модель может выдать вместо нашего: «Счет_1» вместо «Счёт_1». */
const STEM_ALIASES: ReadonlyArray<readonly [string, PiiKind]> = [['Счет', 'account']]

/** Вид ПДн по основе (обратная таблица для разбора). */
const KIND_BY_STEM = new Map<string, PiiKind>([
  ...(Object.keys(LABEL_STEMS) as PiiKind[]).map((k): [string, PiiKind] => [LABEL_STEMS[k], k]),
  ...STEM_ALIASES,
])

const STEMS: readonly string[] = [...KIND_BY_STEM.keys()]

/** Слово-префикс метки в именительном падеже. Род учитывается только у сотрудников. */
export function labelPrefix(kind: PiiKind, gender?: PiiGender): string {
  switch (kind) {
    case 'employee': return gender === 'f' ? 'Сотрудница' : 'Сотрудник'
    case 'client': return 'Клиент'
    case 'contact': return 'Контакт'
    case 'student': return 'Ученик'
    case 'parent': return 'Родитель'
    case 'phone': return 'Телефон'
    case 'email': return 'Почта'
    case 'messenger': return 'Мессенджер'
    case 'mention': return 'Имя'
    case 'person': return 'Человек'
    case 'address': return 'Адрес'
    case 'passport': return 'Паспорт'
    case 'inn': return 'ИННФЛ'
    case 'ogrnip': return 'ОГРНИП'
    case 'snils': return 'СНИЛС'
    case 'birthdate': return 'ДатаРождения'
    case 'license': return 'Водительское'
    case 'card': return 'Карта'
    case 'account': return 'Счёт'
    case 'vehicle': return 'Автомобиль'
  }
}

/** Метка в именительном падеже: «Сотрудница_7». */
export function formatLabel(kind: PiiKind, gender: PiiGender | undefined, n: number): string {
  return `${labelPrefix(kind, gender)}_${n}`
}

/** Граница слова слева: метка не должна начинаться посреди слова/числа. */
const BOUNDARY_BEFORE = '(?<![\\p{L}\\d_])'

/**
 * Новый (с нулевым lastIndex) регэксп поиска меток в тексте, в том числе склонённых.
 * Группы: 1 — основа, 2 — номер. Номер не должен продолжаться цифрами: «_7» не матчится внутри «_70».
 */
export function createLabelRegExp(): RegExp {
  return new RegExp(`${BOUNDARY_BEFORE}(${STEMS.join('|')})\\p{L}*_(\\d+)(?!\\d)`, 'gu')
}

export interface ParsedLabel {
  kind: PiiKind
  n: number
}

/** Разбор совпадения createLabelRegExp() по группам (основа, номер). */
export function labelFromMatch(stem: string, num: string, whole?: string): ParsedLabel | null {
  const kind = KIND_BY_STEM.get(stem)
  if (!kind) return null
  // У короткой основы «Им» произвольные буквы после неё не склонение: «Имущество_5» — другое слово, его нельзя
  // раскрывать именем человека. Имя склоняется только как «Имя / Имени / Именем».
  if (stem === 'Им' && whole !== undefined && !/^Им(?:я|ени|енем)_\d+$/u.test(whole)) return null
  return { kind, n: Number(num) }
}

/** Разбор одной метки (в любом падеже): `null`, если строка — не метка целиком. */
export function parseLabel(text: string): ParsedLabel | null {
  const m = new RegExp(`^(${STEMS.join('|')})\\p{L}*_(\\d+)$`, 'u').exec(text)
  return m ? labelFromMatch(m[1]!, m[2]!, text) : null
}

/** Максимум символов хвоста, которые держим как возможное начало метки (защита от бесконечного удержания длинного слова). */
const MAX_HOLD = 40

const RE_WORD_CHAR = /[\p{L}\d_]/u
const RE_LABEL_REST = /^\p{L}*(?:_\d*)?$/u

/** Может ли строка `s` быть началом метки: часть основы, либо основа + буквы + «_» + цифры (метка ещё не закончена). */
function isLabelCandidate(s: string): boolean {
  for (const stem of STEMS) {
    if (stem.startsWith(s)) return true
    if (s.startsWith(stem) && RE_LABEL_REST.test(s.slice(stem.length))) return true
  }
  return false
}

/** Всё, что нужно восстановителю от хранилища. */
export interface LabelUnmasker {
  unmask(text: string): string
}

export interface LabelRestorer {
  /** Принять чанк; вернуть то, что можно отдавать (метки уже возвращены в имена). Может вернуть ''. */
  push(chunk: string): string
  /** Конец потока: отдать удержанный хвост (тоже с возвратом меток). */
  flush(): string
}

/**
 * Восстановитель меток для стрима.
 * Метку может разрезать по чанкам («Сотр|удница_|7»): хвост, похожий на начало метки, удерживается до следующего чанка.
 * Остальной текст отдаётся сразу. Хвост удерживается только если начинается на границе слова.
 */
export function createLabelRestorer(vault: LabelUnmasker): LabelRestorer {
  let buf = ''
  // последний уже отданный символ: если это буква/цифра, начало буфера — продолжение слова, а не новая метка
  let prevChar = ''
  // возврат меток с учётом соседа слева: «На» + «Клиент_1» в разных чанках — это слово «НаКлиент_1», не метка
  const restore = (out: string): string => {
    if (prevChar && RE_WORD_CHAR.test(prevChar)) return vault.unmask(prevChar + out).slice(prevChar.length)
    return vault.unmask(out)
  }
  return {
    push(chunk: string): string {
      if (!chunk) return ''
      buf += chunk
      let hold = buf.length
      const from = Math.max(0, buf.length - MAX_HOLD)
      for (let i = from; i < buf.length; i++) {
        const before = i === 0 ? prevChar : buf[i - 1]!
        if (before && RE_WORD_CHAR.test(before)) continue
        if (isLabelCandidate(buf.slice(i))) { hold = i; break }
      }
      const out = buf.slice(0, hold)
      buf = buf.slice(hold)
      if (!out) return ''
      const res = restore(out)
      prevChar = out[out.length - 1]!
      return res
    },
    flush(): string {
      const out = buf
      buf = ''
      if (!out) return ''
      const res = restore(out)
      prevChar = out[out.length - 1]!
      return res
    },
  }
}
