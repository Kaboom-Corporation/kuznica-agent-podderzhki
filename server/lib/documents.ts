/**
 * КП из базы → PDF и письмо. Продавец — вымышленное «ООО Демо» из runtimeConfig, реальных реквизитов здесь нет.
 * На КП всегда плашка «Черновик — на проверку менеджеру», без подписи и печати.
 */
import { generateProposalPdf, type PdfDocData, type PdfItem, type PdfSeller } from '../ported/pdf/pdf'
import { formatRub } from '../ported/pdf/pdf-helpers'
import { q1 } from './db'

export const DRAFT_MARK = 'Черновик — на проверку менеджеру'

export interface ProposalRow {
  id: string
  number: string
  conversation_id: string | null
  status: string
  customer: { company?: string; inn?: string; email?: string }
  items: Array<{ sku: string; name: string; unit: string; qty: number; unit_cents: string; discount_pct: number; sum_cents: string }>
  subtotal_cents: bigint
  discount_cents: bigint
  total_cents: bigint
  vat_cents: bigint
  notes: string
  valid_until: string | null
  created_at: Date
  approved_at: Date | null
  sent_at: Date | null
  /** Почта из КП, а если её нет — из обращения. */
  fallback_email: string | null
}

export async function loadProposal(id: string): Promise<ProposalRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  return q1<ProposalRow>(
    `select p.*, to_char(p.valid_until, 'YYYY-MM-DD') as valid_until,
            coalesce(nullif(p.customer->>'email', ''), c.customer_email) as fallback_email
       from proposals p left join conversations c on c.id = p.conversation_id where p.id = $1`,
    [id],
  )
}

function seller(): PdfSeller & { vat: number } {
  const rc = useRuntimeConfig()
  return {
    name: String(rc.sellerName), inn: String(rc.sellerInn), kpp: String(rc.sellerKpp), address: String(rc.sellerAddress),
    bank: String(rc.sellerBank), bik: String(rc.sellerBik), account: String(rc.sellerAccount), corrAccount: String(rc.sellerCorrAccount),
    vat: Number(rc.vatPercent) || 22,
  }
}

export function proposalTerms(p: ProposalRow): string[] {
  return [
    'Оплата: 100% предоплата по счёту.',
    'Срок поставки: уточнит менеджер после подтверждения заказа.',
    p.valid_until ? `Предложение действительно до ${p.valid_until.split('-').reverse().join('.')}.` : 'Срок действия предложения уточнит менеджер.',
    'Цены — по каталогу магазина на дату предложения, в т.ч. НДС.',
  ]
}

export async function proposalPdf(p: ProposalRow): Promise<Uint8Array> {
  const s = seller()
  const items: PdfItem[] = p.items.map(i => ({
    name: i.name, sku: i.sku, qty: i.qty, unit: i.unit,
    unitCents: BigInt(i.unit_cents), discountPct: i.discount_pct, sumCents: BigInt(i.sum_cents),
  }))
  const d: PdfDocData = {
    number: p.number,
    date: new Date(p.created_at).toISOString().slice(0, 10),
    seller: s,
    buyer: { name: p.customer.company || 'Клиент', inn: p.customer.inn, email: p.customer.email },
    items,
    subtotalCents: p.subtotal_cents,
    discountCents: p.discount_cents,
    totalCents: p.total_cents,
    vatCents: p.vat_cents,
    vatPercent: s.vat,
    validUntil: p.valid_until ?? undefined,
    notes: p.notes || undefined,
    terms: proposalTerms(p),
    draftMark: DRAFT_MARK,
  }
  return generateProposalPdf(d)
}

export function proposalMail(p: ProposalRow, shopName: string) {
  return {
    subject: `Коммерческое предложение ${p.number} — ${shopName}`,
    text: [
      'Здравствуйте!',
      '',
      `Направляем коммерческое предложение ${p.number} на сумму ${formatRub(p.total_cents)} (в т.ч. НДС ${formatRub(p.vat_cents)}).`,
      'Файл во вложении. Если что-то нужно поменять — ответьте на это письмо.',
      '',
      `${shopName}`,
    ].join('\n'),
  }
}
