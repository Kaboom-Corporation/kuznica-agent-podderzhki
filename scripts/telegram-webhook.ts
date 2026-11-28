/**
 * Вебхук бота Telegram: поставить, снять, посмотреть.
 *   npm run telegram:webhook -- set      # адрес — NUXT_TELEGRAM_PUBLIC_URL + /api/telegram/webhook
 *   npm run telegram:webhook -- set https://example.ru
 *   npm run telegram:webhook -- info     # куда смотрит вебхук и последняя ошибка доставки
 *   npm run telegram:webhook -- delete
 * Токен, секрет и адрес API — из .env (NUXT_TELEGRAM_BOT_TOKEN, NUXT_TELEGRAM_WEBHOOK_SECRET, NUXT_TELEGRAM_API_URL).
 * Старые сообщения, накопившиеся, пока вебхука не было, сбрасываются (drop_pending_updates).
 */
import { existsSync } from 'node:fs'
import { DEFAULT_TG_API, tgCall, TgError } from '../server/lib/telegram'

if (existsSync('.env')) process.loadEnvFile('.env')

const PATH = '/api/telegram/webhook'

async function main() {
  const [cmd = 'info', arg] = process.argv.slice(2)
  const token = String(process.env.NUXT_TELEGRAM_BOT_TOKEN || '').trim()
  if (!token) throw new Error('не задан NUXT_TELEGRAM_BOT_TOKEN')
  const cfg = { token, apiUrl: String(process.env.NUXT_TELEGRAM_API_URL || DEFAULT_TG_API) }

  if (cmd === 'set') {
    const secret = String(process.env.NUXT_TELEGRAM_WEBHOOK_SECRET || '')
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret))
      throw new Error('NUXT_TELEGRAM_WEBHOOK_SECRET: нужно 16–256 символов из латиницы, цифр, _ и - (так требует Telegram)')
    const site = String(arg || process.env.NUXT_TELEGRAM_PUBLIC_URL || '').replace(/\/+$/, '')
    if (!/^https:\/\//.test(site)) throw new Error('нужен публичный адрес стенда с https: аргументом или в NUXT_TELEGRAM_PUBLIC_URL')
    const url = site.endsWith(PATH) ? site : site + PATH
    await tgCall(cfg, 'setWebhook', { url, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true, max_connections: 20 })
    // Команды в меню бота — чтобы клиент видел их у поля ввода
    await tgCall(cfg, 'setMyCommands', { commands: [
      { command: 'start', description: 'Что умеет консультант' },
      { command: 'new', description: 'Начать новое обращение' },
    ] })
    console.log(`вебхук поставлен: ${url}`)
  }
  else if (cmd === 'delete') {
    await tgCall(cfg, 'deleteWebhook', { drop_pending_updates: true })
    console.log('вебхук снят')
  }
  else if (cmd === 'info') {
    const me = await tgCall<{ username?: string }>(cfg, 'getMe')
    const info = await tgCall<{ url?: string; pending_update_count?: number; last_error_date?: number; last_error_message?: string }>(cfg, 'getWebhookInfo')
    console.log(`бот: @${me.username ?? '?'}`)
    console.log(`вебхук: ${info.url || 'не задан'}`)
    console.log(`в очереди: ${info.pending_update_count ?? 0}`)
    if (info.last_error_date) console.log(`последняя ошибка: ${new Date(info.last_error_date * 1000).toISOString()} ${info.last_error_message ?? ''}`)
  }
  else throw new Error(`неизвестная команда «${cmd}»: set | delete | info`)
}

main().catch((e) => {
  console.error(e instanceof TgError ? e.message : `ошибка: ${(e as Error).message}`)
  process.exit(1)
})
