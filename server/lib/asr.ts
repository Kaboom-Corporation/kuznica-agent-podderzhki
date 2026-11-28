/**
 * Распознавание речи своей моделью (GigaAM за OpenAI-совместимым /v1/audio/transcriptions).
 * Общая часть для диктовки в веб-чате и голосовых из Telegram: голос не уходит во внешние сервисы.
 */
export async function transcribe(baseUrl: string, bytes: Uint8Array, type: string, timeoutMs = 60_000): Promise<string> {
  const base = baseUrl.replace(/\/+$/, '')
  const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm'
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), `voice.${ext}`)
  form.append('language', 'ru')
  form.append('response_format', 'json')
  const r = await $fetch<{ text?: string }>(`${base}/v1/audio/transcriptions`, { method: 'POST', body: form, timeout: timeoutMs })
  return String(r?.text || '').trim()
}
