import { requireManager } from '../../../lib/guard'
import { listKb } from '../../../lib/kb-edit'

/** Все статьи базы знаний: база магазина, правленные в панели и выученные из ответов менеджера. */
export default defineEventHandler(async (event) => {
  requireManager(event)
  return await listKb()
})
