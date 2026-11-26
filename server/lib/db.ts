import pg from 'pg'

// bigint (int8) из Postgres → BigInt, чтобы копейки не теряли точность.
pg.types.setTypeParser(20, (v: string) => BigInt(v))
// numeric → строка (cost_rub и т.п. — форматируем сами)
pg.types.setTypeParser(1700, (v: string) => v)

let pool: pg.Pool | null = null

export function db(): pg.Pool {
  if (!pool) {
    const url = process.env.NUXT_DATABASE_URL || process.env.DATABASE_URL || 'postgres://agent:agent@localhost:5433/agent'
    pool = new pg.Pool({ connectionString: url, max: 10 })
  }
  return pool
}

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db().query(text, params as any[])
  return res.rows as T[]
}

export async function q1<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params)
  return rows[0] ?? null
}

/** JSON.stringify, который понимает BigInt (копейки отдаём строкой). */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
}
