import { shopCard, SKU_RE } from '../../lib/shop'

/** Карточка товара витрины */
export default defineEventHandler(async (event) => {
  const sku = decodeURIComponent(getRouterParam(event, 'sku') || '')
  if (!SKU_RE.test(sku)) throw createError({ statusCode: 400, statusMessage: 'неверный артикул' })
  const card = await shopCard(sku)
  if (!card) throw createError({ statusCode: 404, statusMessage: 'Такого товара нет в каталоге' })
  return card
})
