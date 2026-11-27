/**
 * Разовая загрузка каталога из товарного фида YML. Разбор и запись — server/lib/feed.ts
 * (тот же код каждые сутки запускает задача feed:refresh на стенде).
 * Запуск: npm run ingest:feed -- путь/к/feed.xml   (или .yml.gz, или https://…)
 * Сам фид в репозиторий не кладём — путь передаётся аргументом.
 */
import { existsSync } from 'node:fs'
import { db } from '../server/lib/db.ts'
import { feedSummary, loadFeed, withFeed } from '../server/lib/feed.ts'

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const FEED = process.argv[2]
  if (!FEED) { console.error('укажи путь к фиду: npm run ingest:feed -- feed.xml'); process.exit(2) }
  const pool = db()
  const client = await pool.connect()
  try {
    const r = await withFeed(FEED, s => loadFeed(client, s))
    if (!r.applied) throw new Error(`фид не применён: позиций с ценой ${r.feed.priced}, в каталоге было ${r.current} — каталог не тронут`)
    console.log(feedSummary(r.feed))
  }
  finally {
    client.release()
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1) })
