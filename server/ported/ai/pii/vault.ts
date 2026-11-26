/**
 * Хранилище меток ПДн на один разговор.
 * mask: куски ПДн → метки («Юлия Петрова» → «Сотрудница_1»); unmask: метки (в т.ч. склонённые) → настоящие значения.
 * Словарь только дополняется, поэтому одинаковая последовательность mask даёт одинаковые метки (важно для кэша промптов).
 *
 * Возврат — «как написано»: метка возвращается тем фрагментом, который она спрятала во входе, а не полным именем
 * из словаря. Иначе часть адреса, спрятанная за меткой клиента, вернулась бы полным именем и испортила данные.
 *
 * Одна метка — один человек, а написан он мог быть по-разному («Юле», «Юлии Петровой», «Юлия Петрова» из ответа
 * инструмента). Правило выбора формы для возврата: больше слов — полнее и однозначнее для инструментов; при равном
 * числе слов — первая встреченная. Первым маскируется system, затем история по порядку, поэтому при равенстве
 * побеждает форма из system/ранней истории — выбор детерминирован и не прыгает от вызова к вызову. Форма всегда
 * взята из входа: ничего, чего не было в тексте, метка не вернёт.
 */
import { createLabelRegExp, formatLabel, labelFromMatch } from './labels'
import type { PiiKind, PiiSpan } from './types'

export interface PiiVaultOptions {
  /** Вызывается на каждую метку, которой нет в словаре (модель выдумала «Сотрудник_99») — для лога. */
  onUnknownLabel?: (label: string) => void
}

/**
 * Шаблонные заглушки, которые модель пишет по привычке вместо наших меток: «[PHONE_7]», «<EMAIL_3>», «{{client_3}}»,
 * «PERSON_2». Только слова-имена видов ПДн, чтобы не шуметь на обычных «[task_1]».
 */
const GENERIC_PLACEHOLDER = /(?<![\p{L}\d_])(?:[[<{]{1,2}\s*(?:PHONE|EMAIL|MAIL|NAME|PERSON|CLIENT|EMPLOYEE|CONTACT|USER|ADDRESS|TELEGRAM|PASSPORT)_\d+\s*[\]>}]{1,2}|(?:PHONE|EMAIL|PERSON|CLIENT|EMPLOYEE|CONTACT)_\d+(?!\d))/giu

/** Число слов (последовательностей букв) во фрагменте. У телефона — ноль: для контактов остаётся первая форма. */
function wordCount(fragment: string): number {
  return fragment.match(/[\p{L}\p{M}]+/gu)?.length ?? 0
}

/**
 * Из спанов, которые могут пересекаться и идти не по порядку, оставить непересекающиеся: при пересечении — длиннейший
 * (при равной длине — тот, что левее). Битые спаны (вне текста, пустые) отбрасываются. Результат — по порядку в тексте.
 * Общая для меток (PiiVault.mask) и необратимых способов обезличивания.
 */
export function pickNonOverlapping<T extends Pick<PiiSpan, 'start' | 'end'>>(spans: readonly T[], textLength: number): T[] {
  const valid = spans.filter(s => Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.end <= textLength && s.end > s.start)
  const byLength = [...valid].sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)
  const taken: T[] = []
  for (const s of byLength) {
    if (!taken.some(t => s.start < t.end && t.start < s.end)) taken.push(s)
  }
  return taken.sort((a, b) => a.start - b.start)
}

export class PiiVault {
  /** Счётчик номеров по виду ПДн: Сотрудник и Сотрудница делят нумерацию, чтобы склонённая метка читалась однозначно. */
  private readonly counters = new Map<PiiKind, number>()
  /** `${kind}|${key}` → готовая метка (именительный падеж). */
  private readonly labelByKey = new Map<string, string>()
  /** `${kind}|${n}` → чем заменить метку при возврате: выбранная написанная форма и число слов в ней. */
  private readonly formByLabel = new Map<string, { form: string, words: number }>()
  /** `${kind}|${n}` → форма с учётом падежа метки, если вид её умеет (люди из документов); важнее написанной формы. */
  private readonly renderByLabel = new Map<string, (labelEnding: string) => string>()
  private readonly onUnknownLabel?: (label: string) => void
  /** Сколько раз встретилась метка вне словаря (для лога). */
  unknownLabels = 0

  constructor(options: PiiVaultOptions = {}) {
    this.onUnknownLabel = options.onUnknownLabel
  }

  /** Сколько разных ПДн уже в словаре. */
  get size(): number {
    return this.labelByKey.size
  }

  /** Метка для спана: один key → одна метка на весь разговор. written — фрагмент текста, который метка прячет. */
  private labelFor(span: PiiSpan, written: string): string {
    const mapKey = `${span.kind}|${span.key}`
    const known = this.labelByKey.get(mapKey)
    if (known) {
      this.rememberForm(known, span.kind, written)
      return known
    }
    const n = (this.counters.get(span.kind) ?? 0) + 1
    this.counters.set(span.kind, n)
    const label = formatLabel(span.kind, span.gender, n)
    this.labelByKey.set(mapKey, label)
    this.formByLabel.set(`${span.kind}|${n}`, { form: written, words: wordCount(written) })
    if (span.render) this.renderByLabel.set(`${span.kind}|${n}`, span.render)
    return label
  }

  /** Новая форма уже известной метки: берём её, только если в ней больше слов (см. правило в шапке файла). */
  private rememberForm(label: string, kind: PiiKind, written: string): void {
    const n = Number(/_(\d+)$/.exec(label)?.[1])
    const slot = `${kind}|${n}`
    const prev = this.formByLabel.get(slot)
    const words = wordCount(written)
    if (!prev || words > prev.words) this.formByLabel.set(slot, { form: written, words })
  }

  /**
   * Заменить спаны метками. Спаны могут пересекаться и идти не по порядку:
   * берём непересекающиеся, при пересечении — длиннейший (при равной длине — тот, что левее).
   * Метки выдаются в порядке следования в тексте — результат детерминирован.
   */
  mask(text: string, spans: PiiSpan[]): string {
    if (!text || spans.length === 0) return text
    const taken = pickNonOverlapping(spans, text.length)
    let out = ''
    let pos = 0
    for (const s of taken) {
      out += text.slice(pos, s.start) + this.labelFor(s, text.slice(s.start, s.end))
      pos = s.end
    }
    return out + text.slice(pos)
  }

  /**
   * Вернуть метки в написанные во входе фрагменты. Склонённая метка («Сотруднице_7») тоже узнаётся. Человек из
   * документа с падежной формой (span.render) возвращается в падеже метки. encode — как записать значение на месте
   * метки: в JSON-ответе модели кавычки и переводы строки надо экранировать.
   * Метка вне словаря (выдуманный номер, чужое слово вроде «Имущество_5», шаблон «[PHONE_7]» из привычек модели) не
   * раскрывается и не ломает ответ: остаётся в тексте как есть, считается и уходит в onUnknownLabel (в метке нет
   * ПДн — она ничего не прятала). Так в аргументы инструментов не попадает «чужое» имя, а вызывающий видит предупреждение.
   */
  unmask(text: string, encode: (value: string) => string = value => value): string {
    if (!text) return text
    const restored = text.replace(createLabelRegExp(), (whole: string, stem: string, num: string) => {
      const parsed = labelFromMatch(stem, num, whole)
      const mapKey = parsed ? `${parsed.kind}|${parsed.n}` : ''
      const known = parsed ? this.formByLabel.get(mapKey) : undefined
      if (known === undefined) {
        this.noteUnknown(whole)
        return whole
      }
      const render = this.renderByLabel.get(mapKey)
      // Окончание склонённой метки: всё между основой и «_N» («Человеку_1» → «у»).
      return encode(render ? render(whole.slice(stem.length, whole.lastIndexOf('_'))) : known.form)
    })
    // Шаблонные заглушки «[PHONE_7]», «{{client_3}}», «PERSON_2»: нашей метки в них нет, раскрыть нечем.
    for (const m of restored.matchAll(GENERIC_PLACEHOLDER)) this.noteUnknown(m[0])
    return restored
  }

  private noteUnknown(label: string): void {
    this.unknownLabels++
    try {
      this.onUnknownLabel?.(label)
    }
    catch {
      // Колбэк для лога не должен ронять ответ модели.
    }
  }

  /** Рекурсивно вернуть метки в строках JSON-значения (аргументы инструментов). Ключи объектов не трогаем. */
  unmaskDeep<T>(value: T): T {
    return this.walk(value) as T
  }

  private walk(value: unknown): unknown {
    if (typeof value === 'string') return this.unmask(value)
    if (Array.isArray(value)) return value.map(v => this.walk(v))
    if (value !== null && typeof value === 'object') {
      const proto = Object.getPrototypeOf(value) as unknown
      if (proto !== Object.prototype && proto !== null) return value
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.walk(v)
      return out
    }
    return value
  }
}
