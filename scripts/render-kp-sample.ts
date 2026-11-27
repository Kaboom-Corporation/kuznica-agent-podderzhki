// Пример КП в PDF на демо-данных — проверить вёрстку шаблона без стенда: bun scripts/render-kp-sample.ts out.pdf
import { writeFileSync } from 'node:fs'
import { generateProposalPdf } from '../server/ported/pdf/pdf'

const out = process.argv[2] || 'kp-sample.pdf'
const pdf = await generateProposalPdf({
  number: 'КП-106',
  date: '2026-11-27',
  seller: { name: 'ООО Демо Софт', inn: '7700000000', kpp: '770001001', address: 'г. Москва, ул. Примерная, д. 1' },
  buyer: { name: 'ООО Ромашка', email: 'ivan@romashka.example' },
  items: [
    { name: 'Dr.Web Desktop Security Suite + Центр управления, 50 ПК, 1 год', sku: 'SL-229556', qty: 1, unit: 'шт', unitCents: 8081840n, discountPct: 0, sumCents: 8081840n },
    { name: 'Dr.Web Mail Security Suite, защита почты, 1 адрес, 1 год', sku: 'SL-3850', qty: 50, unit: 'шт', unitCents: 167094n, discountPct: 0, sumCents: 8354700n },
  ],
  subtotalCents: 16436540n,
  discountCents: 0n,
  totalCents: 16436540n,
  vatCents: 2963966n,
  vatPercent: 22,
  validUntil: '2026-12-11',
  terms: ['Оплата 100% по счёту.', 'Поставка электронных ключей — в течение 2 рабочих дней после оплаты.', 'Цены каталога на дату предложения.'],
  notes: 'Предложение подготовлено ИИ-агентом по переписке с клиентом.',
  draftMark: 'Черновик — на проверку менеджеру',
})
writeFileSync(out, pdf)
console.log('ok', out, pdf.length)
