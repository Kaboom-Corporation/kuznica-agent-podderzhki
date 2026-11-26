// Отправка писем через SMTP (nodemailer). Не настроен SMTP — возвращает { sent: false }, не бросает.

import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'

export interface MailAttachment {
  filename: string
  content: Buffer | Uint8Array
  contentType?: string
}

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
  attachments?: MailAttachment[]
}

export interface MailResult {
  sent: boolean
  messageId?: string
  reason?: string
}

export interface SmtpConfig {
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPass: string
  smtpFrom: string
}

/**
 * Настройки: runtimeConfig (если есть Nitro), иначе переменные NUXT_SMTP_*.
 * Так модуль работает и в сервере, и в скриптах.
 */
export function readSmtpConfig(): SmtpConfig {
  let rc: Partial<Record<keyof SmtpConfig, unknown>> = {}
  try {
    if (typeof useRuntimeConfig === 'function') rc = useRuntimeConfig() as typeof rc
  }
  catch { /* вне Nitro */ }
  const env = process.env
  return {
    smtpHost: String(rc.smtpHost || env.NUXT_SMTP_HOST || ''),
    smtpPort: Number(rc.smtpPort || env.NUXT_SMTP_PORT) || 587,
    smtpUser: String(rc.smtpUser || env.NUXT_SMTP_USER || ''),
    smtpPass: String(rc.smtpPass || env.NUXT_SMTP_PASS || ''),
    smtpFrom: String(rc.smtpFrom || env.NUXT_SMTP_FROM || ''),
  }
}

let cached: { key: string, transport: Transporter } | null = null

function transporterFor(cfg: SmtpConfig): Transporter {
  const key = `${cfg.smtpHost}:${cfg.smtpPort}:${cfg.smtpUser}:${cfg.smtpPass}`
  if (cached?.key === key) return cached.transport
  cached?.transport.close()
  const transport = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
  })
  cached = { key, transport }
  return transport
}

/** Короткая причина отказа без адресов получателей. */
function errorReason(err: unknown): string {
  const e = err as { code?: string, responseCode?: number, message?: string }
  const msg = (e?.message ?? String(err)).replace(/\S+@\S+/g, '<адрес>').slice(0, 120)
  return [e?.code, e?.responseCode, msg].filter(Boolean).join(' ')
}

/**
 * Отправить письмо. Никогда не бросает: при ненастроенном SMTP — { sent:false, reason:'smtp_not_configured' },
 * при сбое отправки — { sent:false, reason:<код и текст без адресов> }.
 * Второй аргумент позволяет передать настройки явно (тесты, скрипты).
 */
export async function sendMail(m: MailMessage, config?: SmtpConfig): Promise<MailResult> {
  const cfg = config ?? readSmtpConfig()
  if (!cfg.smtpHost) return { sent: false, reason: 'smtp_not_configured' }
  try {
    const info = await transporterFor(cfg).sendMail({
      from: cfg.smtpFrom || cfg.smtpUser,
      to: m.to,
      subject: m.subject,
      text: m.text,
      ...(m.html ? { html: m.html } : {}),
      ...(m.attachments?.length
        ? { attachments: m.attachments.map(a => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType })) }
        : {}),
    })
    return { sent: true, messageId: info.messageId }
  }
  catch (err) {
    const reason = errorReason(err)
    console.error(`[email] failed тема="${m.subject.slice(0, 80)}" причина=${reason}`)
    return { sent: false, reason }
  }
}
