import { db } from '../../lib/db'
import { feedSummary, loadFeed, withFeedUrl } from '../../lib/feed'

/**
 * Каталог из фида магазина раз в сутки (заказчик, чат задачи 27.11: фид обновлять раз в день).
 * Расписание — nuxt.config.ts (scheduledTasks). Адрес — NUXT_FEED_URL; пустой = задача ничего не делает.
 * Битый или урезанный фид каталог не трогает: транзакция откатывается, остаются вчерашние цены.
 */
export default defineTask({
  meta: { name: 'feed:refresh', description: 'Обновить каталог из товарного фида магазина' },
  async run() {
    const url = String(useRuntimeConfig().feedUrl || '')
    if (!url) return { result: 'NUXT_FEED_URL не задан — пропуск' }
    const started = Date.now()
    const client = await db().connect()
    try {
      const r = await withFeedUrl(url, s => loadFeed(client, s))
      const msg = r.applied
        ? `${feedSummary(r.feed)}; за ${Math.round((Date.now() - started) / 1000)} с`
        : `фид не применён: позиций ${r.feed.loaded} (с ценой ${r.feed.priced}), в каталоге было ${r.current}`
      console[r.applied ? 'log' : 'warn'](`[feed:refresh] ${msg}`)
      return { result: msg }
    }
    finally {
      client.release()
    }
  },
})
