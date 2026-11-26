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

/** Простой лимит на IP для публичного чата: модель платная, демо открыто. */
const hits = new Map<string, number[]>()
export function rateLimit(event: H3Event, perMinute = 12): void {
  const ip = getRequestIP(event, { xForwardedFor: true }) || 'unknown'
  const now = Date.now()
  const list = (hits.get(ip) || []).filter(t => now - t < 60_000)
  if (list.length >= perMinute) throw createError({ statusCode: 429, statusMessage: 'Слишком много сообщений, подождите минуту' })
  list.push(now)
  hits.set(ip, list)
  if (hits.size > 5000) hits.clear()
}

export function uuidParam(event: H3Event, name = 'id'): string {
  const v = getRouterParam(event, name) || ''
  if (!/^[0-9a-f-]{36}$/i.test(v)) throw createError({ statusCode: 400, statusMessage: 'неверный id' })
  return v
}
