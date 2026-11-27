import { requireManager } from '../../../lib/guard'

/**
 * Обновить каталог из фида сейчас, не дожидаясь ночного запуска. Та же задача feed:refresh:
 * битый фид каталог не трогает. Повторное нажатие во время загрузки не запускает вторую —
 * Nitro отдаёт результат уже идущей задачи.
 */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const { result } = await runTask('feed:refresh')
  return { ok: true, result }
})
