import { sendMail } from '../../../../ported/email/smtp'
import { q, q1 } from '../../../../lib/db'
import { loadProposal, proposalMail, proposalPdf } from '../../../../lib/documents'
import { requireManager, uuidParam } from '../../../../lib/guard'
import { sendProposalToTelegram } from '../../../../lib/telegram-bot'

/**
 * Менеджер подтверждает КП: статус approved → PDF → запись в outbox → письмо, если настроен SMTP и есть адрес.
 * Без SMTP письмо остаётся в outbox со статусом logged — его видно в панели.
 * Повторное подтверждение не шлёт второе письмо.
 */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const id = uuidParam(event)
  const body = await readBody<{ email?: string; note?: string }>(event).catch(() => ({} as { email?: string; note?: string }))

  // Захватываем черновик атомарно: два клика подряд не дадут два письма.
  const taken = await q1<{ id: string }>(
    `update proposals set status = 'approved', approved_at = now() where id = $1 and status = 'draft' returning id`, [id])
  const p = await loadProposal(id)
  if (!p) throw createError({ statusCode: 404, statusMessage: 'КП не найдено' })
  if (!taken) throw createError({ statusCode: 409, statusMessage: `КП уже в статусе ${p.status}` })

  const to = String(body?.email || p.fallback_email || '').trim()
  const pdf = await proposalPdf(p)
  const mail = proposalMail(p, String(useRuntimeConfig().public.shopName))
  const text = body?.note ? `${mail.text}\n\n${body.note}` : mail.text
  const filename = `${p.number}.pdf`

  let status = 'logged'
  let error: string | null = to ? null : 'нет адреса клиента'
  if (to) {
    const r = await sendMail({ to, subject: mail.subject, text, attachments: [{ filename, content: pdf, contentType: 'application/pdf' }] })
    status = r.sent ? 'sent' : (r.reason === 'smtp_not_configured' ? 'logged' : 'failed')
    if (!r.sent) error = r.reason ?? null
  }
  await q(
    `insert into outbox (conversation_id, to_email, subject, body, attachments, status, error) values ($1, $2, $3, $4, $5, $6, $7)`,
    [p.conversation_id, to || '—', mail.subject, text, JSON.stringify([{ filename, bytes: pdf.length }]), status, error],
  )
  // Обращение из Telegram: PDF уходит и в чат клиента. Ошибка доставки подтверждение не отменяет.
  const telegram = p.conversation_id ? await sendProposalToTelegram(p.conversation_id, p.number, pdf, body?.note) : null
  if (status === 'sent' || telegram === 'sent') await q(`update proposals set status = 'sent', sent_at = now() where id = $1`, [id])
  if (p.conversation_id) {
    const where = [status === 'sent' ? 'на почту' : '', telegram === 'sent' ? 'в Telegram' : ''].filter(Boolean).join(' и ')
    await q(`insert into messages (conversation_id, role, content, meta) values ($1, 'manager', $2, $3)`, [
      p.conversation_id,
      where ? `Менеджер проверил и отправил КП ${p.number} ${where}.` : `Менеджер проверил КП ${p.number}.`,
      JSON.stringify({ proposal: p.number, outbox: status, telegram }),
    ])
    await q(`update conversations set status = 'open', updated_at = now() where id = $1`, [p.conversation_id])
  }
  return { number: p.number, status: status === 'sent' || telegram === 'sent' ? 'sent' : 'approved', mail: status, telegram, error }
})
