/**
 * Телефоны, почты и мессенджеры как PiiSpan.
 * В исходной наработке поиск контактов жил в отдельном модуле «защиты контактов»; здесь он заменён компактным
 * поиском по регулярным выражениям: российские номера в любой записи, e-mail, @ник и ссылки мессенджеров.
 */
import type { PiiSpan } from './types'

const MESSENGER_HOST = /(?:t\.me|telegram\.me|telegram\.dog|wa\.me|api\.whatsapp\.com|vk\.com|vk\.me|m\.vk\.com|ok\.ru|instagram\.com|max\.ru)\//i

/** Телефон: +7 / 7 / 8, затем 10 цифр с пробелами, дефисами, скобками и точками между группами. */
const RE_PHONE = /(?<![\d\w])(?:\+7|7|8)[\s\-.]?(?:\(\s*\d{3}\s*\)|\d{3})[\s\-.]?\d{3}[\s\-.]?\d{2}[\s\-.]?\d{2}(?![\d\w])/g
const RE_EMAIL = /[\p{L}\d._%+\-]+[@＠][\p{L}\d.\-]+\.[\p{L}]{2,}/gu
const RE_MESSENGER_LINK = /(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog|wa\.me|api\.whatsapp\.com|vk\.com|vk\.me|m\.vk\.com|ok\.ru|instagram\.com|max\.ru)\/[\w\-./?=+]+/gi
const RE_NICK = /(?<![\w@.])@[A-Za-z][\w]{3,31}(?![\w@])/g

/** Цифры номера; полноширинные цифры Unicode сводятся к 0-9. */
function phoneDigits(raw: string): string {
  let out = ''
  for (const ch of raw) {
    if (/[0-9]/.test(ch)) out += ch
    else if (/\p{Nd}/u.test(ch)) {
      const d = ch.normalize('NFKD')
      if (/^[0-9]$/.test(d)) out += d
    }
  }
  return out
}

/** Российский номер приводим к 7XXXXXXXXXX (8… и 10 цифр без кода → 7…); чужой остаётся цифрами как есть. */
export function normalizePhone(raw: string): string {
  const digits = phoneDigits(raw)
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`
  if (digits.length === 10) return `7${digits}`
  return digits
}

function normalizeEmail(raw: string): string {
  return raw.toLowerCase().replace(/＠/g, '@').replace(/\s+/g, '')
}

function normalizeMessenger(raw: string): string {
  const t = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')
  // «@ник» и «t.me/ник» — один и тот же адресат.
  return t.startsWith('@') ? `t.me/${t.slice(1)}` : t
}

interface RawSpan { start: number, end: number }

function collect(text: string, re: RegExp): RawSpan[] {
  const out: RawSpan[] = []
  for (const m of text.matchAll(re)) out.push({ start: m.index!, end: m.index! + m[0].length })
  return out
}

/**
 * Контакты из текста в виде PiiSpan: phone / email / messenger. key — нормализованное значение (одна метка на один
 * и тот же номер, как бы его ни записали), canonical — исходный текст. Пересечения (почта внутри ссылки) снимаются:
 * побеждает более длинный фрагмент.
 */
export function contactPiiSpans(text: string): PiiSpan[] {
  if (!text) return []
  const raws: Array<RawSpan & { kind: 'phone' | 'email' | 'messenger' }> = [
    ...collect(text, RE_MESSENGER_LINK).map(s => ({ ...s, kind: 'messenger' as const })),
    ...collect(text, RE_EMAIL).map(s => ({ ...s, kind: 'email' as const })),
    ...collect(text, RE_NICK).map(s => ({ ...s, kind: 'messenger' as const })),
    ...collect(text, RE_PHONE).map(s => ({ ...s, kind: 'phone' as const })),
  ]
  raws.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
  const picked: typeof raws = []
  let edge = 0
  for (const s of raws) {
    if (s.start < edge) continue
    picked.push(s)
    edge = s.end
  }
  return picked.map((s) => {
    const raw = text.slice(s.start, s.end)
    if (s.kind === 'messenger' || MESSENGER_HOST.test(raw)) {
      return { start: s.start, end: s.end, kind: 'messenger' as const, key: normalizeMessenger(raw), canonical: raw }
    }
    if (s.kind === 'email') return { start: s.start, end: s.end, kind: 'email' as const, key: normalizeEmail(raw), canonical: raw }
    return { start: s.start, end: s.end, kind: 'phone' as const, key: normalizePhone(raw), canonical: raw }
  })
}
