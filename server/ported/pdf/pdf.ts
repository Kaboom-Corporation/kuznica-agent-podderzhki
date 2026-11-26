import type { PDFDocument, PDFFont, PDFPage } from 'pdf-lib'
import { rgb } from 'pdf-lib'
import { amountInWords, createPdfWithFonts, formatDateRu, formatRub, wrapText } from './pdf-helpers'

// Счёт на оплату и коммерческое предложение на A4. Оформление: акцентная полоса, две карточки
// реквизитов (продавец / покупатель), таблица позиций с зеброй и переносом на следующую страницу,
// блок итогов с выделением НДС. Деньги — BigInt-копейки, как в БД (см. ../invoices/money.ts).

export interface PdfSeller {
  name: string
  inn?: string
  kpp?: string
  address?: string
  bank?: string
  bik?: string
  account?: string
  corrAccount?: string
}

export interface PdfBuyer {
  name: string
  inn?: string
  kpp?: string
  address?: string
  email?: string
}

export interface PdfItem {
  name: string
  sku: string
  qty: number
  unit: string
  unitCents: bigint
  discountPct: number
  sumCents: bigint
}

export interface PdfDocData {
  number: string
  /** Дата документа, ISO (YYYY-MM-DD). */
  date: string
  seller: PdfSeller
  buyer: PdfBuyer
  items: PdfItem[]
  subtotalCents: bigint
  discountCents: bigint
  totalCents: bigint
  vatCents: bigint
  vatPercent: number
  /** Срок действия счёта или предложения, ISO. */
  validUntil?: string
  notes?: string
  /** Условия предложения (оплата, поставка, гарантии) — по строке на пункт. Только для КП. */
  terms?: string[]
}

const A4: [number, number] = [595.28, 841.89]
const MARGIN = 48
const BOTTOM = 70

const ORANGE = rgb(1, 0.42, 0.208)
const ORANGE_SOFT = rgb(1, 0.925, 0.88)
const INK = rgb(0.11, 0.12, 0.15)
const MUTED = rgb(0.42, 0.45, 0.5)
const HAIRLINE = rgb(0.86, 0.87, 0.89)
const ZEBRA = rgb(0.968, 0.972, 0.977)
const CARD_BG = rgb(0.972, 0.975, 0.98)
const WHITE = rgb(1, 1, 1)

type Color = ReturnType<typeof rgb>

/** Курсор рисования: страница, текущая высота, перенос на новую страницу. */
class Sheet {
  page!: PDFPage
  y = 0
  readonly width = A4[0]
  readonly right = A4[0] - MARGIN
  readonly contentWidth = A4[0] - MARGIN * 2

  constructor(readonly doc: PDFDocument, readonly regular: PDFFont, readonly bold: PDFFont) {
    this.newPage()
  }

  newPage() {
    this.page = this.doc.addPage(A4)
    this.rect(0, A4[1] - 6, A4[0], 6, ORANGE)
    this.y = A4[1] - 48
  }

  ensure(height: number, onNewPage?: () => void) {
    if (this.y - height < BOTTOM) {
      this.newPage()
      onNewPage?.()
    }
  }

  text(str: string, x: number, y: number, size: number, font: PDFFont = this.regular, color: Color = INK) {
    this.page.drawText(str, { x, y, size, font, color })
  }

  textRight(str: string, xRight: number, y: number, size: number, font: PDFFont = this.regular, color: Color = INK) {
    this.page.drawText(str, { x: xRight - font.widthOfTextAtSize(str, size), y, size, font, color })
  }

  rect(x: number, y: number, w: number, h: number, color: Color) {
    this.page.drawRectangle({ x, y, width: w, height: h, color })
  }

  line(y: number, color: Color = HAIRLINE, thickness = 0.75) {
    this.page.drawLine({ start: { x: MARGIN, y }, end: { x: this.right, y }, thickness, color })
  }

  /** Абзац с переносами; возвращает число строк. */
  paragraph(str: string, x: number, size: number, width: number, color: Color = INK, lineH = size + 3.5): number {
    const lines = wrapText(str, this.regular, size, width)
    for (const l of lines) {
      this.ensure(lineH)
      this.text(l, x, this.y, size, this.regular, color)
      this.y -= lineH
    }
    return lines.length
  }
}

async function newSheet(): Promise<Sheet> {
  const { doc, regular, bold } = await createPdfWithFonts()
  return new Sheet(doc, regular, bold)
}

function drawHeader(s: Sheet, badge: string, title: string, d: PdfDocData) {
  const top = s.y
  s.text(d.seller.name, MARGIN, top - 4, 15, s.bold, INK)
  if (d.seller.inn) s.text(`ИНН ${d.seller.inn}${d.seller.kpp ? `   КПП ${d.seller.kpp}` : ''}`, MARGIN, top - 19, 8.5, s.regular, MUTED)

  const bw = s.bold.widthOfTextAtSize(badge, 13) + 24
  s.rect(s.right - bw, top - 20, bw, 24, ORANGE)
  s.text(badge, s.right - bw + 12, top - 13, 13, s.bold, WHITE)

  s.y = top - 44
  s.text(`${title} № ${d.number}`, MARGIN, s.y, 15, s.bold, INK)
  s.textRight(`от ${formatDateRu(d.date)}`, s.right, s.y, 10, s.regular, MUTED)
  s.y -= 10
  s.line(s.y, ORANGE, 1.5)
  s.y -= 22
}

function drawParties(s: Sheet, d: PdfDocData, sellerLabel: string, buyerLabel: string) {
  const gap = 16
  const colW = (s.contentWidth - gap) / 2
  const pad = 12
  const lineH = 12.5

  const rows = (name: string, extra: Array<string | undefined>) => {
    const out: Array<{ t: string, bold?: boolean }> = []
    for (const l of wrapText(name || '—', s.bold, 10, colW - pad * 2)) out.push({ t: l, bold: true })
    for (const e of extra) {
      if (!e) continue
      for (const l of wrapText(e, s.regular, 8.5, colW - pad * 2)) out.push({ t: l })
    }
    return out
  }
  const left = rows(d.seller.name, [
    d.seller.inn ? `ИНН ${d.seller.inn}${d.seller.kpp ? `   КПП ${d.seller.kpp}` : ''}` : undefined,
    d.seller.address,
  ])
  const right = rows(d.buyer.name, [
    d.buyer.inn ? `ИНН ${d.buyer.inn}${d.buyer.kpp ? `   КПП ${d.buyer.kpp}` : ''}` : undefined,
    d.buyer.address,
    d.buyer.email,
  ])
  const h = 16 + 8 + Math.max(left.length, right.length) * lineH + 6
  s.ensure(h)

  const draw = (x: number, label: string, list: typeof left) => {
    s.rect(x, s.y - h, colW, h, CARD_BG)
    s.rect(x, s.y - h, 3, h, ORANGE)
    s.text(label.toUpperCase(), x + pad, s.y - 12, 8, s.bold, ORANGE)
    let ry = s.y - 16 - 8
    list.forEach((r, i) => {
      s.text(r.t, x + pad, ry, r.bold ? 10 : 8.5, r.bold ? s.bold : s.regular, r.bold || i === 0 ? INK : MUTED)
      ry -= lineH
    })
  }
  draw(MARGIN, sellerLabel, left)
  draw(MARGIN + colW + gap, buyerLabel, right)
  s.y -= h + 20
}

const COL = { num: 26, qty: 38, unit: 34, price: 68, disc: 40, sum: 76 }

function drawItemsTable(s: Sheet, d: PdfDocData) {
  const nameW = s.contentWidth - COL.num - COL.qty - COL.unit - COL.price - COL.disc - COL.sum
  const xName = MARGIN + COL.num
  const xQty = xName + nameW
  const xUnit = xQty + COL.qty
  const xPrice = xUnit + COL.unit
  const xDisc = xPrice + COL.price
  const xSum = xDisc + COL.disc

  const head = () => {
    const h = 22
    s.rect(MARGIN, s.y - h, s.contentWidth, h, ORANGE)
    const by = s.y - h + 7
    s.text('№', MARGIN + 8, by, 8.5, s.bold, WHITE)
    s.text('Наименование', xName + 4, by, 8.5, s.bold, WHITE)
    s.textRight('Кол-во', xQty + COL.qty - 4, by, 8.5, s.bold, WHITE)
    s.text('Ед.', xUnit + 4, by, 8.5, s.bold, WHITE)
    s.textRight('Цена', xPrice + COL.price - 4, by, 8.5, s.bold, WHITE)
    s.textRight('Скидка', xDisc + COL.disc - 4, by, 8.5, s.bold, WHITE)
    s.textRight('Сумма', xSum + COL.sum - 6, by, 8.5, s.bold, WHITE)
    s.y -= h
  }
  s.ensure(22 + 30)
  head()

  d.items.forEach((it, i) => {
    const nameLines = wrapText(it.name, s.regular, 9, nameW - 8)
    const rowH = Math.max(24, nameLines.length * 12 + (it.sku ? 11 : 0) + 8)
    s.ensure(rowH, head)
    if (i % 2 === 0) s.rect(MARGIN, s.y - rowH, s.contentWidth, rowH, ZEBRA)
    const by = s.y - 15
    s.text(String(i + 1), MARGIN + 8, by, 9, s.regular, MUTED)
    let ny = by
    for (const l of nameLines) {
      s.text(l, xName + 4, ny, 9, s.regular, INK)
      ny -= 12
    }
    if (it.sku) s.text(it.sku, xName + 4, ny, 7.5, s.regular, MUTED)
    s.textRight(String(it.qty), xQty + COL.qty - 4, by, 9)
    s.text(it.unit, xUnit + 4, by, 9)
    s.textRight(formatRub(it.unitCents), xPrice + COL.price - 4, by, 8.5)
    s.textRight(it.discountPct ? `${it.discountPct}%` : '—', xDisc + COL.disc - 4, by, 9, s.regular, it.discountPct ? INK : MUTED)
    s.textRight(formatRub(it.sumCents), xSum + COL.sum - 6, by, 8.5, s.bold)
    s.y -= rowH
  })
  s.line(s.y)
  s.y -= 16
}

function drawTotals(s: Sheet, d: PdfDocData, totalLabel: string) {
  const w = 270
  const x = s.right - w
  const rows: Array<[string, string]> = [['Сумма по позициям', formatRub(d.subtotalCents)]]
  if (d.discountCents > 0n) rows.push(['Скидка', `−${formatRub(d.discountCents)}`])
  s.ensure(rows.length * 15 + 34 + 70)
  for (const [label, value] of rows) {
    s.text(label, x, s.y, 9, s.regular, MUTED)
    s.textRight(value, s.right, s.y, 9)
    s.y -= 15
  }
  const boxH = 34
  s.rect(x - 8, s.y - boxH + 10, w + 8, boxH, ORANGE_SOFT)
  s.rect(x - 8, s.y - boxH + 10, 3, boxH, ORANGE)
  s.text(totalLabel, x + 2, s.y - 6, 9.5, s.regular, MUTED)
  s.textRight(formatRub(d.totalCents), s.right - 8, s.y - 17, 15, s.bold, ORANGE)
  s.y -= boxH + 4
  s.textRight(`в т.ч. НДС ${d.vatPercent}%: ${formatRub(d.vatCents)}`, s.right, s.y, 9, s.regular, INK)
  s.y -= 18
  s.paragraph(`Всего наименований ${d.items.length}, на сумму ${formatRub(d.totalCents)}`, MARGIN, 9, s.contentWidth, MUTED)
  s.paragraph(amountInWords(d.totalCents), MARGIN, 10, s.contentWidth, INK)
  s.y -= 10
}

function drawSignature(s: Sheet, d: PdfDocData, role: string) {
  s.ensure(70)
  s.line(s.y, HAIRLINE, 0.5)
  const sy = s.y - 20
  s.text(role, MARGIN, sy, 9, s.bold)
  s.text('__________________________', MARGIN, sy - 22, 10, s.regular, MUTED)
  s.text(d.seller.name, MARGIN, sy - 36, 9, s.regular)
  s.text('(подпись, расшифровка)', MARGIN, sy - 47, 7.5, s.regular, MUTED)
  s.page.drawEllipse({ x: MARGIN + 250, y: sy - 24, xScale: 26, yScale: 26, borderColor: HAIRLINE, borderWidth: 1 })
  s.text('М.П.', MARGIN + 250 - 9, sy - 27, 8, s.regular, MUTED)
  s.y = sy - 60
}

/** Счёт на оплату: реквизиты продавца и банка, позиции, итоги, «в т.ч. НДС», сумма прописью. */
export async function generateInvoicePdf(d: PdfDocData): Promise<Uint8Array> {
  const s = await newSheet()
  drawHeader(s, 'СЧЁТ', 'Счёт на оплату', d)
  drawParties(s, d, 'Поставщик', 'Покупатель')
  drawItemsTable(s, d)
  drawTotals(s, d, 'Итого к оплате')

  // Реквизиты для оплаты — не выдумываем: нет значения, рисуем линию для заполнения.
  s.ensure(110)
  s.text('РЕКВИЗИТЫ ДЛЯ ОПЛАТЫ', MARGIN, s.y, 8.5, s.bold, ORANGE)
  s.y -= 6
  s.line(s.y, HAIRLINE, 0.5)
  s.y -= 15
  const reqRow = (label: string, value?: string) => {
    s.ensure(15)
    s.text(label, MARGIN, s.y, 9, s.regular, MUTED)
    const has = !!value?.trim()
    s.text(has ? value! : '__________________________', MARGIN + 130, s.y, 9, has ? s.bold : s.regular, has ? INK : MUTED)
    s.y -= 15
  }
  reqRow('Получатель', d.seller.name)
  reqRow('ИНН / КПП', `${d.seller.inn || '—'} / ${d.seller.kpp || '—'}`)
  reqRow('Банк', d.seller.bank)
  reqRow('Расчётный счёт', d.seller.account)
  reqRow('БИК', d.seller.bik)
  reqRow('Корр. счёт', d.seller.corrAccount)
  s.text('Назначение', MARGIN, s.y, 9, s.regular, MUTED)
  const purpose = `Оплата по счёту № ${d.number} от ${formatDateRu(d.date)}. В т.ч. НДС ${d.vatPercent}%: ${formatRub(d.vatCents)}.`
  const savedY = s.y
  for (const l of wrapText(purpose, s.regular, 9, s.contentWidth - 130)) {
    s.text(l, MARGIN + 130, s.y, 9)
    s.y -= 13
  }
  if (s.y === savedY) s.y -= 13
  if (d.validUntil) {
    s.y -= 4
    s.text(`Оплатить до ${formatDateRu(d.validUntil)}`, MARGIN, s.y, 10, s.bold, ORANGE)
    s.y -= 18
  }
  if (d.notes) {
    s.y -= 4
    s.paragraph(d.notes, MARGIN, 9, s.contentWidth, MUTED)
  }
  s.y -= 10
  drawSignature(s, d, 'Поставщик')
  return await s.doc.save()
}

/** Коммерческое предложение: позиции и итоги, срок действия, условия, примечания. */
export async function generateProposalPdf(d: PdfDocData): Promise<Uint8Array> {
  const s = await newSheet()
  drawHeader(s, 'КП', 'Коммерческое предложение', d)
  drawParties(s, d, 'Исполнитель', 'Заказчик')
  if (d.validUntil) {
    s.text(`Предложение действительно до ${formatDateRu(d.validUntil)}`, MARGIN, s.y, 10, s.bold, ORANGE)
    s.y -= 20
  }
  drawItemsTable(s, d)
  drawTotals(s, d, 'Итого')

  if (d.terms?.length) {
    s.ensure(40)
    s.text('УСЛОВИЯ', MARGIN, s.y, 8.5, s.bold, ORANGE)
    s.y -= 6
    s.line(s.y, HAIRLINE, 0.5)
    s.y -= 15
    d.terms.forEach((t, i) => {
      s.paragraph(`${i + 1}. ${t}`, MARGIN, 9.5, s.contentWidth, INK)
    })
    s.y -= 8
  }
  if (d.notes) {
    s.ensure(40)
    s.text('ПРИМЕЧАНИЯ', MARGIN, s.y, 8.5, s.bold, ORANGE)
    s.y -= 6
    s.line(s.y, HAIRLINE, 0.5)
    s.y -= 15
    s.paragraph(d.notes, MARGIN, 9.5, s.contentWidth, INK)
    s.y -= 8
  }
  drawSignature(s, d, 'Исполнитель')
  return await s.doc.save()
}
