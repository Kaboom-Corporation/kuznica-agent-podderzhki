/**
 * Разовая загрузка каталога из товарного фида YML. Разбор и запись — server/lib/feed.ts
 * (тот же код каждые сутки запускает задача feed:refresh на стенде).
 * Запуск: npm run ingest:feed -- путь/к/feed.xml   (или .yml.gz, или https://…)
 * Сам фид в репозиторий не кладём — путь передаётся аргументом.
 */
import { existsSync } from 'node:fs'
import { db } from '../server/lib/db.ts'
import { feedFileStream, feedSummary, fetchFeed, parseFeed, replaceCatalog } from '../server/lib/feed.ts'

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const FEED = process.argv[2]
  if (!FEED) { console.error('укажи путь к фиду: npm run ingest:feed -- feed.xml'); process.exit(2) }
  const feed = /^https?:\/\//.test(FEED) ? await fetchFeed(FEED) : await parseFeed(feedFileStream(FEED))
  if (!feed.items.length) throw new Error('в фиде нет позиций с ценой — каталог не тронут')
  const pool = db()
  const client = await pool.connect()
  try {
    await replaceCatalog(client, feed.items)
    console.log(feedSummary(feed))
  }
  finally {
    client.release()
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1) })
