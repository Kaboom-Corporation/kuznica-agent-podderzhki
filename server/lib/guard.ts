import { timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'

/**
 * Панель менеджера: токен в заголовке Authorization: Bearer … или x-manager-token.
 * Токен не задан — панель закрыта (fail-closed), а не открыта всем.
 */
export function requireManager(event: H3Event): void {
  const want = String(useRuntimeConfig().managerToken || '')
  if (!want) throw createError({ statusCode: 503, statusMessage: 'Панель менеджера выключена: не задан NUXT_MANAGER_TOKEN' })
  const auth = getHeader(event, 'authorization') || ''
  const got = auth.startsWith('Bearer ') ? auth.slice(7) : (getHeader(event, 'x-manager-token') || '')
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw createError({ statusCode: 401, statusMessage: 'Нужен токен менеджера' })
}

/**
 * Адрес клиента. X-Forwarded-For подделывается, поэтому ему верим только за своим прокси (NUXT_TRUST_PROXY=1)
 * и берём правый адрес — тот, что дописал наш прокси.
 */
function clientIp(event: H3Event): string {
  if (process.env.NUXT_TRUST_PROXY === '1') {
    const xff = String(getHeader(event, 'x-forwarded-for') || '').split(',').map(s => s.trim()).filter(Boolean)
    if (xff.length) return xff.at(-1)!
  }
  return getRequestIP(event) || 'unknown'
}

/** Лимит для публичного чата: модель платная, демо открыто. На адрес и общий на весь процесс. */
const hits = new Map<string, number[]>()
let global: number[] = []
const MAX_KEYS = 5000
export function rateLimit(event: H3Event, perMinute = 12, globalPerMinute = Number(process.env.NUXT_CHAT_GLOBAL_PER_MIN) || 120): void {
  const now = Date.now()
  global = global.filter(t => now - t < 60_000)
  if (global.length >= globalPerMinute) throw createError({ statusCode: 429, statusMessage: 'Помощник сейчас перегружен, попробуйте через минуту' })
  const ip = clientIp(event)
  const list = (hits.get(ip) || []).filter(t => now - t < 60_000)
  if (list.length >= perMinute) throw createError({ statusCode: 429, statusMessage: 'Слишком много сообщений, подождите минуту' })
  list.push(now)
  global.push(now)
  hits.delete(ip)
  hits.set(ip, list) // Map хранит порядок вставки: в начале — самые давние адреса
  while (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value!)
}

export function uuidParam(event: H3Event, name = 'id'): string {
  const v = getRouterParam(event, name) || ''
  if (!/^[0-9a-f-]{36}$/i.test(v)) throw createError({ statusCode: 400, statusMessage: 'неверный id' })
  return v
}
