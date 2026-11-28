/**
 * Канал Telegram: сообщение клиента → агент → ответ в чат. Только личные чаты, группы бот не слушает.
 *
 * Вебхук отвечает Telegram сразу, а сообщение обрабатывается здесь в фоне: агент думает 10–30 с,
 * а медленный вебхук Telegram повторяет. Сообщения одного чата идут строго по очереди,
 * чтобы ответы не перепутались и агент видел предыдущую реплику в истории.
 * Ответ менеджера и подтверждённое КП доходят в тот же чат (notifyTelegram, sendProposalToTelegram).
 */
import { timingSafeEqual } from 'node:crypto'
import { ask, MAX_QUESTION_CHARS } from '../agent/loop'
import { transcribe } from './asr'
import { q, q1 } from './db'
import { takeSlot } from './guard'
import { DEFAULT_TG_API, downloadFile, keepTyping, sendDocument, sendHtml, TgError, type TgConfig } from './telegram'
import { escapeTg, formatAgentReply, mdToTgBlocks, packTg } from './telegram-format'

/** Сообщений в минуту на один чат; общий потолок процесса — тот же, что у веб-чата. */
const PER_CHAT_PER_MIN = 10
/** Голосовое длиннее — просим покороче: распознавание держит соединение, а клиент ждёт. */
const MAX_VOICE_SEC = 120
const MAX_VOICE_BYTES = 5 * 1024 * 1024

const GREETING = [
  '<b>Здравствуйте! Я консультант магазина лицензий.</b>',
  'Помогу подобрать программу, подскажу российский аналог, назову цену и наличие по каталогу и подготовлю коммерческое предложение. КП и счёт сначала проверяет менеджер, потом они приходят сюда.',
  'Сложные вопросы передаю менеджеру — его ответ тоже придёт в этот чат.',
  'Пишите вопрос текстом или голосовым. Чтобы начать новое обращение, отправьте /new.',
].join('\n\n')

export interface TgBotConfig extends TgConfig { secret: string }

export interface TgUser { id: number; is_bot?: boolean; first_name?: string; last_name?: string }
export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: { id: number; type: string }
  text?: string
  voice?: { file_id: string; duration?: number; mime_type?: string; file_size?: number }
}
export interface TgUpdate { update_id: number; message?: TgMessage }

/** Настройки канала из runtimeConfig. Нет токена — канал выключен. */
export function tgConfig(): TgBotConfig | null {
  const c = useRuntimeConfig()
  const token = String(c.telegramBotToken || '').trim()
  if (!token) return null
  return { token, secret: String(c.telegramWebhookSecret || ''), apiUrl: String(c.telegramApiUrl || DEFAULT_TG_API) }
}

/** Секрет вебхука: сравнение за постоянное время, пустой секрет не подходит никогда. */
export function secretOk(got: string | undefined | null, want: string): boolean {
  if (!want || !got) return false
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** true — обновление новое; false — уже приходило (повтор Telegram). */
export async function claimUpdate(updateId: number): Promise<boolean> {
  const row = await q1(`insert into telegram_updates (update_id) values ($1) on conflict do nothing returning update_id`, [updateId])
  // журнал повторов нужен на часы, не навсегда
  if (Math.random() < 0.01) q(`delete from telegram_updates where received_at < now() - interval '3 days'`).catch(() => {})
  return !!row
}

const chains = new Map<number, Promise<void>>()

/** Обработка в фоне, по очереди внутри чата. Промис никогда не падает: ошибки уходят в журнал. */
export function enqueueUpdate(cfg: TgBotConfig, u: TgUpdate): Promise<void> {
  const chatId = u.message?.chat.id
  if (chatId === undefined) return Promise.resolve()
  const prev = chains.get(chatId) ?? Promise.resolve()
  const next = prev.then(() => handleMessage(cfg, u.message!)).catch((e) => {
    console.error(`[telegram] обновление ${u.update_id}:`, (e as Error).message)
  })
  chains.set(chatId, next)
  next.finally(() => { if (chains.get(chatId) === next) chains.delete(chatId) })
  return next
}

const say = (cfg: TgConfig, chatId: number, html: string) => sendHtml(cfg, chatId, [html])

async function handleMessage(cfg: TgBotConfig, m: TgMessage): Promise<void> {
  if (m.chat.type !== 'private' || m.from?.is_bot) return
  const chatId = m.chat.id
  let text = (m.text ?? '').trim()

  const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text)?.[1]?.toLowerCase()
  if (cmd === 'start' || cmd === 'help') return say(cfg, chatId, GREETING)
  if (cmd === 'new') {
    await q(`update telegram_chats set conversation_id = null, updated_at = now() where chat_id = $1`, [chatId])
    return say(cfg, chatId, 'Начинаем новое обращение. Напишите, пожалуйста, ваш вопрос.')
  }
  if (cmd) return say(cfg, chatId, 'Такой команды нет. Просто напишите вопрос, а /new начнёт новое обращение.')

  if (!text && !m.voice) return say(cfg, chatId, 'Я понимаю текст и голосовые сообщения. Напишите, пожалуйста, вопрос.')

  const over = takeSlot(`tg:${chatId}`, PER_CHAT_PER_MIN)
  if (over) return say(cfg, chatId, over === 'global' ? 'Консультант сейчас перегружен, напишите, пожалуйста, через минуту.' : 'Слишком много сообщений подряд. Подождите минуту, и я отвечу.')

  if (!text && m.voice) {
    const heard = await fromVoice(cfg, chatId, m.voice)
    if (!heard) return
    text = heard
  }
  if (text.length > MAX_QUESTION_CHARS) return say(cfg, chatId, `Сообщение слишком длинное. Сократите, пожалуйста, до ${MAX_QUESTION_CHARS} символов.`)

  const stop = keepTyping(cfg, chatId)
  let chunks: string[]
  try {
    const conversationId = await currentConversation(chatId, m.from)
    const r = await ask({ channel: 'telegram', text, conversationId })
    // обращение могло быть пересоздано агентом (удалили из базы) — чат запоминает то, что вернул агент
    if (r.conversationId !== conversationId) await bindChat(chatId, r.conversationId)
    chunks = formatAgentReply({ text: r.text, sources: r.sources, drafts: r.drafts, escalated: !!r.escalation })
  }
  catch (e) {
    console.error(`[telegram] агент не ответил чату:`, (e as Error).message)
    chunks = ['Не получилось ответить — что-то сломалось у нас. Попробуйте, пожалуйста, ещё раз через минуту.']
  }
  finally {
    stop()
  }
  await sendHtml(cfg, chatId, chunks)
}

/** Голосовое → текст своей моделью распознавания. null — клиенту уже объяснили, что не так. */
async function fromVoice(cfg: TgConfig, chatId: number, v: NonNullable<TgMessage['voice']>): Promise<string | null> {
  const asr = String(useRuntimeConfig().asrUrl || '')
  if (!asr) { await say(cfg, chatId, 'Голосовые сообщения я пока не распознаю. Напишите, пожалуйста, вопрос текстом.'); return null }
  if ((v.duration ?? 0) > MAX_VOICE_SEC) { await say(cfg, chatId, 'Голосовое слишком длинное. Запишите, пожалуйста, до двух минут или напишите текстом.'); return null }
  const stop = keepTyping(cfg, chatId)
  try {
    const audio = await downloadFile(cfg, v.file_id, MAX_VOICE_BYTES)
    const text = await transcribe(asr, audio, v.mime_type || 'audio/ogg')
    if (!text) { await say(cfg, chatId, 'Не разобрал слова в голосовом. Повторите, пожалуйста, или напишите текстом.'); return null }
    // клиент видит, что распознано: если ошиблись, он поправит текстом
    await say(cfg, chatId, `<i>Распознал: «${escapeTg(text.length > 500 ? `${text.slice(0, 500)}…` : text)}»</i>`)
    return text
  }
  catch (e) {
    console.error('[telegram] голосовое:', e instanceof TgError ? e.message : (e as any)?.status || (e as Error).message)
    await say(cfg, chatId, 'Не получилось распознать голосовое. Напишите, пожалуйста, вопрос текстом.')
    return null
  }
  finally {
    stop()
  }
}

/** Текущее обращение чата; закрытое или потерянное — заводим новое с каналом telegram. */
async function currentConversation(chatId: number, from?: TgUser): Promise<string> {
  const row = await q1<{ id: string }>(
    `select c.id from telegram_chats t join conversations c on c.id = t.conversation_id where t.chat_id = $1 and c.status <> 'closed'`, [chatId])
  if (row) return row.id
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ').slice(0, 200) || null
  const created = await q1<{ id: string }>(
    `insert into conversations (channel, customer_name, telegram_chat_id) values ('telegram', $1, $2) returning id`, [name, chatId])
  await bindChat(chatId, created!.id)
  return created!.id
}

async function bindChat(chatId: number, conversationId: string): Promise<void> {
  await q(`update conversations set telegram_chat_id = $1 where id = $2 and telegram_chat_id is null`, [chatId, conversationId])
  await q(
    `insert into telegram_chats (chat_id, conversation_id) values ($1, $2)
     on conflict (chat_id) do update set conversation_id = excluded.conversation_id, updated_at = now()`, [chatId, conversationId])
}

async function chatOf(conversationId: string): Promise<{ cfg: TgConfig; chatId: string } | null> {
  const row = await q1<{ telegram_chat_id: bigint | null }>(`select telegram_chat_id from conversations where id = $1`, [conversationId])
  if (!row?.telegram_chat_id) return null
  const cfg = tgConfig()
  if (!cfg) return null
  return { cfg, chatId: String(row.telegram_chat_id) }
}

/**
 * Ответ менеджера клиенту в Telegram. null — обращение не из Telegram (или канал выключен);
 * 'failed' — не доставлено, причина в журнале. Не бросает: ответ в панели уже сохранён.
 */
export async function notifyTelegram(conversationId: string, text: string): Promise<'sent' | 'failed' | null> {
  try {
    const to = await chatOf(conversationId)
    if (!to) return null
    await sendHtml(to.cfg, to.chatId, packTg(['<b>Ответ менеджера:</b>', ...mdToTgBlocks(text)]))
    return 'sent'
  }
  catch (e) {
    console.error(`[telegram] ответ менеджера в обращение ${conversationId} не доставлен:`, (e as Error).message)
    return 'failed'
  }
}

/** Подтверждённое менеджером КП — PDF в чат клиента. Правила те же, что у notifyTelegram. */
export async function sendProposalToTelegram(conversationId: string, number: string, pdf: Uint8Array, note?: string): Promise<'sent' | 'failed' | null> {
  try {
    const to = await chatOf(conversationId)
    if (!to) return null
    await sendDocument(to.cfg, to.chatId, { name: `${number}.pdf`, bytes: pdf, type: 'application/pdf' },
      `Менеджер проверил коммерческое предложение № ${escapeTg(number)}. Документ — в файле.`)
    if (note?.trim()) await sendHtml(to.cfg, to.chatId, packTg(['<b>Комментарий менеджера:</b>', ...mdToTgBlocks(note)]))
    return 'sent'
  }
  catch (e) {
    console.error(`[telegram] КП ${number} в обращение ${conversationId} не доставлено:`, (e as Error).message)
    return 'failed'
  }
}
