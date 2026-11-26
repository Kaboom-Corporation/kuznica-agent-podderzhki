import { describe, expect, it } from 'vitest'
import { sendMail } from '../server/ported/email/smtp'

describe('sendMail', () => {
  it('без SMTP не бросает и сообщает причину', async () => {
    const r = await sendMail(
      { to: 'a@example.com', subject: 'Тема', text: 'Текст' },
      { smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '', smtpFrom: '' },
    )
    expect(r).toEqual({ sent: false, reason: 'smtp_not_configured' })
  })
})
