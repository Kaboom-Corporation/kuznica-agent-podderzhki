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
  rateLimit(event, 10, undefined, 'asr:')

  const len = Number(getHeader(event, 'content-length') || 0)
  if (len > MAX_BYTES + 64 * 1024) throw createError({ statusCode: 413, statusMessage: 'Запись слишком длинная — до минуты' })
  const parts = await readMultipartFormData(event)
  const audio = parts?.find(p => p.name === 'file' && p.data?.length)
  if (!audio) throw createError({ statusCode: 400, statusMessage: 'Нет записи' })
  if (audio.data.length > MAX_BYTES) throw createError({ statusCode: 413, statusMessage: 'Запись слишком длинная — до минуты' })
  const type = audio.type || 'application/octet-stream'
  if (!/^(audio|video)\//.test(type)) throw createError({ statusCode: 415, statusMessage: 'Это не аудио' })

  const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm'
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio.data)], { type }), `voice.${ext}`)
  form.append('language', 'ru')
  form.append('response_format', 'json')

  try {
    const r = await $fetch<{ text?: string }>(`${base}/v1/audio/transcriptions`, {
      method: 'POST', body: form, timeout: 60_000,
    })
    return { text: String(r?.text || '').trim() }
  } catch (e: any) {
    console.error('[asr]', e?.status || '', e?.message || e)
    throw createError({ statusCode: 502, statusMessage: 'Не получилось распознать речь — напишите текстом' })
  }
})
