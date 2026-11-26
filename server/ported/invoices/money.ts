/**
 * Деньги целыми копейками (BigInt) — без вещественной арифметики (1.32.0, отложенные задания).
 * Сумма приложения хранится как Decimal(12,2), счёт на предоплату = amount × доля / 100: на float 33% от 100,01
 * дало бы 33,0033 с хвостом и расхождение в копейку при сверке остатка. Здесь всё считается целыми числами,
 * округление — от половины копейки вверх. Используют: services/invoices/draft, handlers/appendix-prepayment (Б),
 * handlers/act-remainder (А: остаток = сумма приложения − счета этапа).
 * Чистый модуль без импортов.
 */

/**
 * Копейки из строки, числа или Decimal-подобного объекта (toString). Запятая вместо точки допустима.
 * Третий и дальнейшие знаки округляются от 5 вверх. Не сумма (мусор, NaN, пусто) → null.
 */
export function toCents(value: unknown): bigint | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim().replace(',', '.'))
  if (!m) return null
  const frac = m[3] ?? ''
  let cents = BigInt(m[2]!) * 100n + BigInt(`${frac}00`.slice(0, 2))
  if (frac.length > 2 && frac[2]! >= '5') cents += 1n
  return m[1] === '-' ? -cents : cents
}

/** «125000.00» — рубли строкой с двумя знаками (как в InvoiceRef и Decimal(12,2)). */
export function fromCents(cents: bigint): string {
  const negative = cents < 0n
  const abs = negative ? -cents : cents
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`
}

/** Любая сумма → «125000.00»; не сумма → null. */
export function normalizeMoney(value: unknown): string | null {
  const cents = toCents(value)
  return cents === null ? null : fromCents(cents)
}

/** Доля суммы в целых процентах с округлением от половины копейки вверх: 33% от 100,01 → 33,00. */
export function percentOfCents(cents: bigint, percent: number): bigint {
  if (!Number.isInteger(percent)) throw new RangeError(`percentOfCents: доля должна быть целым числом процентов, получено ${percent}`)
  const negative = cents < 0n
  const abs = negative ? -cents : cents
  const part = (abs * BigInt(percent) + 50n) / 100n
  return negative ? -part : part
}
