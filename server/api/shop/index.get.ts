import { shopCategories, shopSearch } from '../../lib/shop'

/** Витрина: поиск и разделы. ?q=…&category=…&page=… */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const q = String(query.q ?? '').slice(0, 200)
  const category = String(query.category ?? '').slice(0, 200)
  const page = Number(query.page) || 1
  const [result, categories] = await Promise.all([shopSearch({ query: q, category, page }), shopCategories()])
  return { ...result, categories }
})
