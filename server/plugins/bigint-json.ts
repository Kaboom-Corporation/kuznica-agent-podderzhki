/**
 * Драйвер БД отдаёт int8 как BigInt (копейки и id не теряют точность), а JSON.stringify на BigInt падает —
 * карточка обращения в панели менеджера отвечала 500. Отдаём BigInt строкой, как и toJson() в lib/db.
 */
const proto = BigInt.prototype as unknown as { toJSON?: () => string }
proto.toJSON ??= function (this: bigint) { return this.toString() }

export default defineNitroPlugin(() => {})
