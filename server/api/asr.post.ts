import { transcribe } from '../lib/asr'
import { rateLimit } from '../lib/guard'

/**
 * Голосовой ввод: запись из браузера → своя модель распознавания (GigaAM, OpenAI-совместимый
 * /v1/audio/transcriptions). Голос не уходит во внешние сервисы. Адрес — NUXT_ASR_URL;
 * пусто — диктовка выключена, кнопки в чате нет.
 * Текст возвращается в поле ввода, а не отправляется сам: клиент видит и правит, что распознано.
 */
const MAX_BYTES = 5 * 1024 * 1024 // ~5 минут opus; кнопка в чате останавливает запись через 60 с

export default defineEventHandler(async (event) => {
  const base = String(useRuntimeConfig().asrUrl || '').replace(/\/+$/, '')
  if (!base) throw createError({ statusCode: 503, statusMessage: 'Голосовой ввод выключен' })
  // ?live=1 — черновик во время записи (раз в ~2,5 с, до минуты): своя корзина, чтобы не съесть лимит окончательных
  const isLive = getQuery(event).live === '1'
  if (isLive) rateLimit(event, 30, undefined, 'asr-live:')
  else rateLimit(event, 10, undefined, 'asr:')

  // Без Content-Length (chunked) тело не ограничено — такой запрос не читаем. Браузер для FormData
  // заголовок шлёт всегда, а Node не прочитает тело длиннее заявленного.
  const len = Number(getHeader(event, 'content-length'))
  if (!Number.isFinite(len) || len <= 0) throw createError({ statusCode: 411, statusMessage: 'Нужна длина запроса' })
  if (len > MAX_BYTES + 64 * 1024) throw createError({ statusCode: 413, statusMessage: 'Запись слишком длинная — до минуты' })
  const parts = await readMultipartFormData(event)
  const audio = parts?.find(p => p.name === 'file' && p.data?.length)
  if (!audio) throw createError({ statusCode: 400, statusMessage: 'Нет записи' })
  if (audio.data.length > MAX_BYTES) throw createError({ statusCode: 413, statusMessage: 'Запись слишком длинная — до минуты' })
  const type = audio.type || 'application/octet-stream'
  if (!/^(audio|video)\//.test(type)) throw createError({ statusCode: 415, statusMessage: 'Это не аудио' })

  try {
    return { text: await transcribe(base, audio.data, type) }
  } catch (e: any) {
    console.error('[asr]', e?.status || '', e?.message || e)
    throw createError({ statusCode: 502, statusMessage: 'Не получилось распознать речь — напишите текстом' })
  }
})
