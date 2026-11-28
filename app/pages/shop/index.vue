<script setup lang="ts">
interface ShopItem {
  sku: string; name: string; vendor: string; category: string; unit: string
  term_months: number | null; price: string | null; lot: string | null; stock: number; lead_days: number | null; in_registry: boolean
}
interface ShopResult { items: ShopItem[]; total: number; page: number; pages: number; categories: { name: string; count: number }[] }

useState('shop-page').value = null
useHead({ title: 'Витрина' })

const route = useRoute()
const router = useRouter()
const qs = computed(() => ({
  q: String(route.query.q ?? ''),
  category: String(route.query.category ?? ''),
  page: Number(route.query.page) || 1,
}))
const { data, pending, error } = useFetch<ShopResult>('/api/shop', { query: qs })

const draft = ref(qs.value.q)
watch(() => qs.value.q, v => { draft.value = v })

function go(patch: Partial<{ q: string; category: string; page: number }>) {
  const next = { ...qs.value, page: 1, ...patch }
  router.push({ query: { ...(next.q ? { q: next.q } : {}), ...(next.category ? { category: next.category } : {}), ...(next.page > 1 ? { page: String(next.page) } : {}) } })
}
function submit() { go({ q: draft.value.trim() }) }

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many
}
const fmt = (n: number) => n.toLocaleString('ru-RU')
</script>

<template>
  <div class="list">
    <form class="search" role="search" @submit.prevent="submit">
      <input v-model="draft" class="field search-field" type="search" placeholder="Название, производитель или задача: «антивирус», «Астра», «СЭД»" aria-label="Поиск по каталогу">
      <button class="btn dark" type="submit">Найти</button>
    </form>

    <nav v-if="data?.categories.length" class="cats" aria-label="Разделы каталога">
      <button class="cat" :class="{ on: !qs.category }" @click="go({ category: '' })">Все разделы</button>
      <button v-for="c in data.categories" :key="c.name" class="cat" :class="{ on: qs.category === c.name }" @click="go({ category: c.name })">
        {{ c.name }} <span class="cat-n">{{ fmt(c.count) }}</span>
      </button>
    </nav>

    <p class="summary">
      <template v-if="pending && !data">Загружаю каталог…</template>
      <template v-else-if="error">Каталог сейчас недоступен — спросите консультанта справа, он ищет по тому же каталогу.</template>
      <template v-else-if="data">
        <template v-if="data.total">{{ fmt(data.total) }} {{ plural(data.total, 'позиция', 'позиции', 'позиций') }}</template>
        <template v-else>Ничего не нашлось{{ qs.q ? ` по запросу «${qs.q}»` : '' }}. Опишите задачу консультанту — он подберёт аналог или передаст менеджеру.</template>
        <span v-if="qs.q && data.total" class="muted"> · по запросу «{{ qs.q }}»</span>
      </template>
    </p>

    <ul v-if="data?.items.length" class="grid" :class="{ dim: pending }">
      <li v-for="it in data.items" :key="it.sku">
        <NuxtLink :to="`/shop/${encodeURIComponent(it.sku)}`" class="card">
          <span class="card-cat">{{ it.category }}</span>
          <span class="card-name">{{ it.name }}</span>
          <span class="card-vendor">{{ it.vendor }}<template v-if="it.term_months"> · {{ it.term_months }} мес.</template></span>
          <span v-if="it.lot" class="card-lot">при заказе {{ it.lot }} шт.</span>
          <span class="card-foot">
            <span v-if="it.price" class="card-price num">{{ it.price }}<small v-if="it.unit"> / {{ it.unit }}</small></span>
            <span v-else class="card-price on-request">Цена по запросу</span>
            <span class="card-flags">
              <span v-if="it.stock !== 0" class="status"><span class="status-dot ok" aria-hidden="true" />Доступно</span>
              <span v-else class="status"><span class="status-dot warn" aria-hidden="true" />Под заказ</span>
              <span v-if="it.in_registry" class="reg" title="В реестре российского ПО">Реестр</span>
            </span>
          </span>
        </NuxtLink>
      </li>
    </ul>

    <nav v-if="data && data.pages > 1" class="pager" aria-label="Страницы">
      <button class="btn sm" :disabled="qs.page <= 1" @click="go({ page: qs.page - 1 })">Назад</button>
      <span class="mono pager-pos">{{ qs.page }} из {{ fmt(Math.min(data.pages, 200)) }}</span>
      <button class="btn sm" :disabled="qs.page >= Math.min(data.pages, 200)" @click="go({ page: qs.page + 1 })">Дальше</button>
    </nav>
  </div>
</template>

<style scoped>
.list {
  max-width: 1080px;
  margin: 0 auto;
}

.search {
  display: flex;
  gap: 8px;
}

.search-field {
  height: 38px;
  font-size: 14px;
}

.search .btn {
  height: 38px;
  padding: 0 18px;
}

.cats {
  display: flex;
  gap: 6px;
  margin: 14px 0 0;
  overflow-x: auto;
  scrollbar-width: none;
  padding-bottom: 2px;
}

.cats::-webkit-scrollbar { display: none; }

.cat {
  flex: none;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: var(--ink-2);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 120ms var(--ease), background 120ms var(--ease);
}

.cat:hover { border-color: var(--line-strong); }

.cat.on {
  border-color: var(--ink);
  background: var(--ink);
  color: #fff;
}

.cat-n {
  font-family: var(--mono);
  font-size: 11px;
  opacity: 0.6;
}

.summary {
  margin: 16px 0 12px;
  font-size: 13px;
  color: var(--ink-2);
}

.grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(230px, 100%), 1fr));
  gap: 10px;
  transition: opacity 120ms var(--ease);
}

.grid.dim { opacity: 0.55; }

.card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  height: 100%;
  padding: 14px 14px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
  box-shadow: var(--shadow-card);
  color: inherit;
  text-decoration: none;
  transition: border-color 120ms var(--ease);
}

.card:hover { border-color: var(--line-strong); }

.card:focus-visible {
  outline: 2px solid var(--indigo);
  outline-offset: 1px;
}

.card-cat {
  font-size: 11px;
  color: var(--ink-4);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-name {
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.35;
  color: var(--ink);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-lot {
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-2);
}

.card-vendor {
  font-size: 12px;
  color: var(--ink-3);
}

.card-foot {
  margin-top: auto;
  padding-top: 10px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.card-price {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}

.card-price small {
  font-size: 11px;
  font-weight: 400;
  color: var(--ink-3);
}

.card-price.on-request {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink-3);
}

.card-flags {
  display: flex;
  align-items: center;
  gap: 8px;
}

.reg {
  font-size: 11px;
  font-weight: 500;
  color: var(--indigo);
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 20px;
}

.pager-pos {
  font-size: 12px;
  color: var(--ink-3);
}

@media (max-width: 560px) {
  .grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
