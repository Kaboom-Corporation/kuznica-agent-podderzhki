import { claimUpdate, enqueueUpdate, secretOk, tgConfig, type TgUpdate } from '../../lib/telegram-bot'

/** Обновление от Telegram — несколько килобайт; больше не читаем. */
const MAX_BODY = 256 * 1024

/**
 * Вебхук бота. Без NUXT_TELEGRAM_BOT_TOKEN канал выключен (404), без секрета — закрыт (503).
 * Запрос без верного X-Telegram-Bot-Api-Secret-Token отклоняется: адрес вебхука могут найти и подделать.
 * Telegram получает 200 сразу, ответ клиенту уходит из фона (агент думает 10–30 с).
 * Повтор того же update_id не обрабатывается второй раз.
 */
export default defineEventHandler(async (event) => {
  const cfg = tgConfig()
  if (!cfg) throw createError({ statusCode: 404, statusMessage: 'Канал Telegram выключен' })
  if (!cfg.secret) throw createError({ statusCode: 503, statusMessage: 'Не задан NUXT_TELEGRAM_WEBHOOK_SECRET' })
  if (!secretOk(getHeader(event, 'x-telegram-bot-api-secret-token'), cfg.secret)) throw createError({ statusCode: 401, statusMessage: 'Неверный секрет вебхука' })

  const len = Number(getHeader(event, 'content-length') || 0)
  if (len > MAX_BODY) throw createError({ statusCode: 413, statusMessage: 'Слишком большой запрос' })
  const u = await readBody<TgUpdate>(event).catch(() => null)
  // мусор и неизвестные виды обновлений Telegram повторять не нужно — просто 200
  if (!u || !Number.isSafeInteger(u.update_id) || !u.message?.chat || !Number.isSafeInteger(u.message.chat.id)) return { ok: true }
  // база недоступна — 500, и Telegram сам повторит позже
  if (!(await claimUpdate(u.update_id))) return { ok: true }

  event.waitUntil(enqueueUpdate(cfg, u))
  return { ok: true }
})
