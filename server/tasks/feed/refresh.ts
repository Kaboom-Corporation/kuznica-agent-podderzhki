import { db, q1 } from '../../lib/db'
import { feedLooksBroken, feedSummary, fetchFeed, replaceCatalog } from '../../lib/feed'

/**
 * Каталог из фида магазина раз в сутки (заказчик, чат задачи 27.11: фид обновлять раз в день).
 * Расписание — nuxt.config.ts (scheduledTasks). Адрес — NUXT_FEED_URL; пустой = задача ничего не делает.
 * Битый или урезанный фид каталог не трогает: остаются вчерашние цены.
 */
export default defineTask({
  meta: { name: 'feed:refresh', description: 'Обновить каталог из товарного фида магазина' },
  async run() {
    const url = String(useRuntimeConfig().feedUrl || '')
    if (!url) return { result: 'NUXT_FEED_URL не задан — пропуск' }
    const started = Date.now()
    const feed = await fetchFeed(url)
    const current = Number((await q1<{ n: number }>('select count(*)::int as n from catalog_items'))?.n ?? 0)
    if (feedLooksBroken(feed.items.length, current)) {
      const msg = `фид не применён: позиций с ценой ${feed.items.length}, в каталоге сейчас ${current}`
      console.warn(`[feed:refresh] ${msg}`)
      return { result: msg }
    }
    const client = await db().connect()
    try {
      await replaceCatalog(client, feed.items)
    }
    finally {
      client.release()
    }
    const msg = `${feedSummary(feed)}; за ${Math.round((Date.now() - started) / 1000)} с`
    console.log(`[feed:refresh] ${msg}`)
    return { result: msg }
  },
})
