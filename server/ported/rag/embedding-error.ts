/**
 * Ошибка «не удалось построить эмбеддинг» — отдельный тип, чтобы вызывающий мог отличить сбой эмбеддингов
 * от сбоя самого поиска (SQL, pgvector, БД).
 *
 * Поиск по умолчанию глотает сбой эмбеддингов и откатывается на полнотекст + триграммы. Инструменту агента
 * такая тишина может быть вредна: пустой результат модель прочтёт как «в базе этого нет». Поэтому есть режим
 * throwOnEmbeddingError, который отдаёт этот тип.
 *
 * Чистый модуль: ни БД, ни Nuxt-автоимпортов.
 */
export class EmbeddingUnavailableError extends Error {
  /** Исходная ошибка провайдера эмбеддингов (HTTP 401, таймаут, сеть…). */
  readonly originalError: unknown

  constructor(originalError: unknown) {
    const reason = originalError instanceof Error ? originalError.message : String(originalError)
    super(`Не удалось получить эмбеддинг: ${reason}`)
    this.name = 'EmbeddingUnavailableError'
    this.originalError = originalError
  }
}
