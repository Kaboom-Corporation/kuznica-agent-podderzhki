import { loadProposal, proposalPdf } from '../../../../lib/documents'
import { requireManager, uuidParam } from '../../../../lib/guard'

/** PDF КП для просмотра менеджером (до и после подтверждения). */
export default defineEventHandler(async (event) => {
  requireManager(event)
  const p = await loadProposal(uuidParam(event))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'КП не найдено' })
  const pdf = await proposalPdf(p)
  setHeader(event, 'content-type', 'application/pdf')
  setHeader(event, 'content-disposition', `inline; filename="${encodeURIComponent(p.number)}.pdf"`)
  return Buffer.from(pdf)
})
