import type { PDFFont } from 'pdf-lib'
import { PDFDocument } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fromCents } from '../invoices/money'

// Шрифты Roboto лежат в server/assets/fonts. В собранном Nitro они читаются через хранилище `assets:fonts`
// (nitro.serverAssets), вне Nitro (скрипты, тесты) — с диска.
let fontRegularBytes: Uint8Array | null = null
let fontBoldBytes: Uint8Array | null = null

function normalizeStorageValue(raw: unknown): Uint8Array | null {
  if (!raw) return null
  if (raw instanceof Uint8Array) return raw
  if (typeof raw === 'string') return new TextEncoder().encode(raw)
  return null
}

async function readFontViaStorage(file: string): Promise<Uint8Array | null> {
  try {
    // useStorage — автоимпорт Nitro; вне Nitro его нет, и мы идём на диск.
    if (typeof useStorage !== 'function') return null
    const raw = await useStorage('assets:fonts').getItemRaw(file)
    return normalizeStorageValue(raw)
  }
  catch {
    return null
  }
}

async function readFontViaFs(file: string): Promise<Uint8Array> {
  const candidates = [
    join(process.cwd(), 'server/assets/fonts', file),
    join(process.cwd(), '.output/server/chunks/fonts', file),
    join(process.cwd(), 'fonts', file),
  ]
  for (const path of candidates) {
    try {
      return new Uint8Array(await readFile(path))
    }
    catch {
      // следующий путь
    }
  }
  throw new Error(`Файл шрифта не найден: ${file}`)
}

async function loadFontBytes(file: string): Promise<Uint8Array> {
  return (await readFontViaStorage(file)) ?? readFontViaFs(file)
}

export async function loadFonts(): Promise<{ regular: Uint8Array, bold: Uint8Array }> {
  if (!fontRegularBytes || !fontBoldBytes) {
    fontRegularBytes = await loadFontBytes('Roboto-Regular.ttf')
    fontBoldBytes = await loadFontBytes('Roboto-Bold.ttf')
  }
  return { regular: fontRegularBytes, bold: fontBoldBytes }
}

export async function createPdfWithFonts(): Promise<{ doc: PDFDocument, regular: PDFFont, bold: PDFFont }> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const fonts = await loadFonts()
  const regular = await doc.embedFont(fonts.regular, { subset: true })
  const bold = await doc.embedFont(fonts.bold, { subset: true })
  return { doc, regular, bold }
}

/** Разбивка текста по ширине — массив строк. Слово шире строки остаётся целиком. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let current = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const test = current ? `${current} ${word}` : word
      if (current && font.widthOfTextAtSize(test, size) > maxWidth) {
        lines.push(current)
        current = word
      }
      else {
        current = test
      }
    }
    if (current) lines.push(current)
  }
  return lines.length ? lines : ['']
}

/** «1 250 000,50 ₽» из копеек. */
export function formatRub(cents: bigint): string {
  const [int, frac] = fromCents(cents).split('.')
  const negative = int!.startsWith('-')
  const digits = negative ? int!.slice(1) : int!
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${negative ? '-' : ''}${grouped},${frac} ₽`
}

export function formatDateRu(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

// ─── Сумма прописью (рубли и копейки) ─────────────────────────
const ONES_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать']
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто']
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот']

function pluralRu(n: number, forms: [string, string, string]): string {
  const n10 = n % 10
  const n100 = n % 100
  if (n10 === 1 && n100 !== 11) return forms[0]
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1]
  return forms[2]
}

function tripletWords(num: number, female: boolean): string[] {
  const out: string[] = []
  const rest = num % 100
  const t = Math.floor(rest / 10)
  const o = rest % 10
  if (Math.floor(num / 100)) out.push(HUNDREDS[Math.floor(num / 100)]!)
  if (t === 1) {
    out.push(TEENS[o]!)
  }
  else {
    if (t) out.push(TENS[t]!)
    if (o) out.push((female ? ONES_F : ONES_M)[o]!)
  }
  return out
}

/** «Сто двадцать три рубля 45 копеек» из копеек (BigInt). Отрицательные берутся по модулю. */
export function amountInWords(cents: bigint): string {
  const abs = cents < 0n ? -cents : cents
  const rub = Number(abs / 100n)
  const kop = Number(abs % 100n)

  const scales: Array<{ div: number, female: boolean, forms: [string, string, string] }> = [
    { div: 1_000_000_000, female: false, forms: ['миллиард', 'миллиарда', 'миллиардов'] },
    { div: 1_000_000, female: false, forms: ['миллион', 'миллиона', 'миллионов'] },
    { div: 1000, female: true, forms: ['тысяча', 'тысячи', 'тысяч'] },
  ]
  const parts: string[] = []
  let left = rub
  for (const s of scales) {
    const n = Math.floor(left / s.div) % 1000
    if (n) parts.push(...tripletWords(n, s.female), pluralRu(n, s.forms))
  }
  left %= 1000
  if (left || !parts.length) parts.push(...tripletWords(left, false))

  let words = parts.filter(Boolean).join(' ') || 'ноль'
  words = words.charAt(0).toUpperCase() + words.slice(1)
  return `${words} ${pluralRu(rub, ['рубль', 'рубля', 'рублей'])} ${String(kop).padStart(2, '0')} ${pluralRu(kop, ['копейка', 'копейки', 'копеек'])}`
}
