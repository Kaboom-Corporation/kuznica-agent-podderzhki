import { q1 } from '../lib/db'

export default defineEventHandler(async () => {
  const row = await q1<{ ok: number }>('select 1 as ok')
  return { ok: row?.ok === 1 }
})
