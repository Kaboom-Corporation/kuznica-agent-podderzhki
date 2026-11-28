/**
 * Клиент Bot API Telegram: вызовы с таймаутом, отправка ответа с откатом на обычный текст, файлы.
 * Без Nuxt: настройки передаются явно, поэтому им пользуется и скрипт установки вебхука.
 * Токен бота входит в адрес запроса — в журнал адрес не пишем, только метод и ответ Telegram.
 */
import { tgHtmlToPlain } from './telegram-format'

export interface TgConfig {
  token: string
  /** Адрес Bot API: свой прокси или https://api.telegram.org */
  apiUrl: string
}

export const DEFAULT_TG_API = 'https://api.telegram.org'

export class TgError extends Error {
  constructor(readonly method: string, readonly code: number, readonly description: string, readonly retryAfter?: number) {
    super(`Telegram ${method}: ${code} ${description}`)
  }
}

const base = (cfg: TgConfig) => (cfg.apiUrl || DEFAULT_TG_API).replace(/\/+$/, '')

async function parse<T>(method: string, res: Response): Promise<T> {
  const data = await res.json().catch(() => null) as { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } } | null
  if (!data?.ok) throw new TgError(method, data?.error_code ?? res.status, String(data?.description ?? res.statusText).slice(0, 300), data?.parameters?.retry_after)
  return data.result as T
}

/** Вызов метода Bot API. Ошибка сети или таймаут — TgError с кодом 0, адрес с токеном в сообщение не попадает. */
export async function tgCall<T = unknown>(cfg: TgConfig, method: string, body: Record<string, unknown> | FormData = {}, timeoutMs = 10_000): Promise<T> {
  const form = body instanceof FormData
  let res: Response
  try {
    res = await fetch(`${base(cfg)}/bot${cfg.token}/${method}`, {
      method: 'POST',
      headers: form ? undefined : { 'content-type': 'application/json' },
      body: form ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
  catch (e) {
    const err = e as Error
    throw new TgError(method, 0, err.name === 'TimeoutError' ? `нет ответа за ${timeoutMs / 1000} с` : `сеть: ${err.name}`)
  }
  return parse<T>(method, res)
}

/** Тот же вызов, но при 429 «подождите N секунд» — одна пауза (не дольше 10 с) и повтор. */
async function tgCallRetry<T>(cfg: TgConfig, method: string, body: Record<string, unknown>): Promise<T> {
  try {
    return await tgCall<T>(cfg, method, body)
  }
  catch (e) {
    if (!(e instanceof TgError) || e.code !== 429 || !e.retryAfter || e.retryAfter > 10) throw e
    await new Promise(r => setTimeout(r, e.retryAfter! * 1000))
    return tgCall<T>(cfg, method, body)
  }
}

/**
 * Отправка готовых HTML-кусков по порядку. Если Telegram не разобрал разметку (400), этот кусок уходит
 * обычным текстом — клиент получает ответ в любом случае.
 */
export async function sendHtml(cfg: TgConfig, chatId: number | string, chunks: string[], extra: Record<string, unknown> = {}): Promise<void> {
  for (const html of chunks) {
    try {
      await tgCallRetry(cfg, 'sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra })
    }
    catch (e) {
      if (!(e instanceof TgError) || e.code !== 400 || /chat not found|blocked|deactivated/i.test(e.description)) throw e
      console.warn(`[telegram] разметка отклонена (${e.description}), отправляю текстом`)
      await tgCallRetry(cfg, 'sendMessage', { chat_id: chatId, text: tgHtmlToPlain(html), link_preview_options: { is_disabled: true }, ...extra })
    }
  }
}

/** «Печатает…» над чатом, пока агент думает: Telegram гасит статус через 5 с, повторяем каждые 4 с. */
export function keepTyping(cfg: TgConfig, chatId: number | string, everyMs = 4000): () => void {
  const ping = () => { tgCall(cfg, 'sendChatAction', { chat_id: chatId, action: 'typing' }, 5000).catch(() => {}) }
  ping()
  const timer = setInterval(ping, everyMs)
  return () => clearInterval(timer)
}

/** Скачать файл (голосовое) по file_id. Больше maxBytes — ошибка до скачивания, если Telegram знает размер. */
export async function downloadFile(cfg: TgConfig, fileId: string, maxBytes: number, timeoutMs = 30_000): Promise<Uint8Array> {
  const f = await tgCall<{ file_path?: string; file_size?: number }>(cfg, 'getFile', { file_id: fileId })
  if (!f.file_path) throw new TgError('getFile', 0, 'нет пути к файлу')
  if (f.file_size && f.file_size > maxBytes) throw new TgError('getFile', 413, 'файл слишком большой')
  let res: Response
  try {
    res = await fetch(`${base(cfg)}/file/bot${cfg.token}/${f.file_path}`, { signal: AbortSignal.timeout(timeoutMs) })
  }
  catch (e) {
    throw new TgError('file', 0, `сеть: ${(e as Error).name}`)
  }
  if (!res.ok) throw new TgError('file', res.status, res.statusText)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.length > maxBytes) throw new TgError('file', 413, 'файл слишком большой')
  return buf
}

/** Документ (PDF КП) в чат. */
export async function sendDocument(cfg: TgConfig, chatId: number | string, file: { name: string; bytes: Uint8Array; type: string }, captionHtml?: string): Promise<void> {
  const form = new FormData()
  form.append('chat_id', String(chatId))
  form.append('document', new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type }), file.name)
  if (captionHtml) { form.append('caption', captionHtml); form.append('parse_mode', 'HTML') }
  await tgCall(cfg, 'sendDocument', form, 30_000)
}
