import { describe, expect, it } from 'vitest'
import { generateInvoicePdf, generateProposalPdf } from '../server/ported/pdf/pdf'
import type { PdfDocData } from '../server/ported/pdf/pdf'
import { amountInWords, formatRub } from '../server/ported/pdf/pdf-helpers'

const data: PdfDocData = {
  number: 'СЧ-2026-0001',
  date: '2026-11-26',
  seller: {
    name: 'ООО «Демо Софт»',
    inn: '7700000000',
    kpp: '770001001',
    address: '123456, г. Москва, ул. Примерная, д. 1',
    bank: 'АО «Демо-Банк»',
    bik: '044500000',
    account: '40702810000000000000',
    corrAccount: '30101810000000000000',
  },
  buyer: { name: 'ООО «Ромашка»', inn: '7811111111', email: 'buyer@example.com' },
  items: Array.from({ length: 3 }, (_, i) => ({
    name: `Лицензия на российское ПО, позиция ${i + 1}, расширенная поддержка на 12 месяцев`,
    sku: `SKU-${i + 1}`,
    qty: 5,
    unit: 'лицензия',
    unitCents: 1_250_000n,
    discountPct: 10,
    sumCents: 5_625_000n,
  })),
  subtotalCents: 18_750_000n,
  discountCents: 1_875_000n,
  totalCents: 16_875_000n,
  vatCents: 3_043_033n,
  vatPercent: 22,
  validUntil: '2026-12-10',
  notes: 'Лицензионные ключи отправляются на e-mail после оплаты.',
  terms: ['Оплата в течение 5 банковских дней.', 'Поставка электронная, в течение одного рабочего дня.'],
}

const head = (b: Uint8Array) => new TextDecoder().decode(b.slice(0, 5))

describe('pdf', () => {
  it('счёт — валидный PDF', async () => {
    const bytes = await generateInvoicePdf(data)
    expect(head(bytes)).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(5000)
  })

  it('КП — валидный PDF, в том числе с множеством позиций (перенос страниц)', async () => {
    expect(head(await generateProposalPdf(data))).toBe('%PDF-')
    const many = { ...data, items: Array.from({ length: 40 }, () => data.items[0]!) }
    expect(head(await generateProposalPdf(many))).toBe('%PDF-')
  })
})

describe('суммы', () => {
  it('прописью', () => {
    expect(amountInWords(12345n)).toBe('Сто двадцать три рубля 45 копеек')
    expect(amountInWords(210_000_00n)).toBe('Двести десять тысяч рублей 00 копеек')
    expect(amountInWords(2_000_001_00n)).toBe('Два миллиона один рубль 00 копеек')
  })
  it('формат рублей', () => {
    expect(formatRub(125_000_050n)).toBe('1 250 000,50 ₽')
  })
})
