/**
 * Маскировка ПДн перед отправкой текста во внешнюю модель: ПДн → метки «Телефон_1», «Человек_2», в ответе модели
 * метки возвращаются на место функцией restore. Таблица соответствия живёт только в замыкании restore.
 *
 * Находит: телефоны, e-mail, мессенджеры; ИНН физлица, СНИЛС, паспорт, банковские карты (Luhn), счета, права, номера
 * автомобилей, даты рождения, адреса; людей по написанию (ФИО, инициалы, падежи) и по словарю имён, если он передан.
 */
import { DocumentPiiDetector } from './document-detector'
import type { PiiPerson, PiiSpan } from './types'
import { PiiVault, pickNonOverlapping } from './vault'

export interface MaskPiiOptions {
  /** Словарь известных людей: найденные по нему имена прячутся под меткой своего вида (Клиент_N, Сотрудник_N …). */
  people?: readonly PiiPerson[]
}

export interface MaskPiiResult {
  masked: string
  /** Вернуть метки в тексте (например, в ответе модели) обратно в исходные фрагменты. */
  restore: (s: string) => string
  /** Сколько фрагментов спрятано. */
  found: number
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Упоминания людей из словаря: полное имя и отдельные слова имени длиной от 4 букв (если не wholeNameOnly). */
function dictionarySpans(text: string, people: readonly PiiPerson[]): PiiSpan[] {
  const out: PiiSpan[] = []
  for (const p of people) {
    const parts = p.fullName.split(/\s+/).filter(w => w.length >= 4)
    const needles = p.wholeNameOnly ? [p.fullName] : [p.fullName, ...parts]
    for (const needle of needles) {
      // Слово целиком, допускаем падежное окончание до 3 букв: «Юлия» → «Юлии», «Юлию».
      const stem = needle.includes(' ') ? escapeRe(needle) : `${escapeRe(needle.slice(0, Math.max(needle.length - 1, 3)))}[\\p{L}]{0,3}`
      const re = new RegExp(`(?<![\\p{L}\\d])${stem}(?![\\p{L}\\d])`, 'giu')
      for (const m of text.matchAll(re)) {
        out.push({ start: m.index!, end: m.index! + m[0].length, kind: p.kind, key: p.key, canonical: p.fullName, gender: p.gender })
      }
    }
  }
  return out
}

export function maskPii(text: string, options: MaskPiiOptions = {}): { masked: string, restore: (s: string) => string, found: number } {
  if (!text) return { masked: text, restore: s => s, found: 0 }
  const detector = new DocumentPiiDetector()
  detector.prepare([text])
  const found = [...detector.spans(text), ...(options.people?.length ? dictionarySpans(text, options.people) : [])]
  const spans = pickNonOverlapping(found, text.length)
  const vault = new PiiVault()
  const masked = spans.length ? vault.mask(text, spans) : text
  return { masked, restore: s => vault.unmask(s), found: spans.length }
}
