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
}))
// Первая страница — через useFetch (рендерится на сервере), следующие догружаются при прокрутке
const { data, pending, error } = useFetch<ShopResult>('/api/shop', { query: qs })
const firstSku = useState<string | null>('shop-first', () => null)
watch(data, d => { firstSku.value = d?.items[0]?.sku ?? null }, { immediate: true })

const MAX_PAGES = 200
const more = ref<ShopItem[]>([])
const loaded = ref(1)
const loadingMore = ref(false)
const moreError = ref(false)
watch(qs, () => { more.value = []; loaded.value = 1; moreError.value = false })
const items = computed(() => [...(data.value?.items ?? []), ...more.value])
const lastPage = computed(() => Math.min(data.value?.pages ?? 1, MAX_PAGES))
const hasMore = computed(() => !!data.value && !pending.value && loaded.value < lastPage.value)

async function loadMore() {
  if (!hasMore.value || loadingMore.value) return
  loadingMore.value = true
  moreError.value = false
  const want = qs.value
  try {
    const r = await $fetch<ShopResult>('/api/shop', { query: { ...want, page: loaded.value + 1 } })
    if (want !== qs.value) return
    const seen = new Set(items.value.map(i => i.sku))
    more.value.push(...r.items.filter(i => !seen.has(i.sku)))
    loaded.value++
  }
  catch { moreError.value = true }
  finally { loadingMore.value = false }
}

// Датчик у нижнего края: подгружаем заранее, за экран до конца списка
const sentinel = ref<HTMLElement | null>(null)
let io: IntersectionObserver | null = null
onMounted(() => {
  io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting) && !moreError.value) loadMore() }, { rootMargin: '800px 0px' })
  watch(sentinel, (el, old) => { if (old) io?.unobserve(old); if (el) io?.observe(el) }, { immediate: true })
})
onBeforeUnmount(() => io?.disconnect())

const draft = ref(qs.value.q)
watch(() => qs.value.q, v => { draft.value = v })

function go(patch: Partial<{ q: string; category: string }>) {
  const next = { ...qs.value, ...patch }
  router.push({ query: { ...(next.q ? { q: next.q } : {}), ...(next.category ? { category: next.category } : {}) } })
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
      <template v-if="pending"><span class="sk sk-line" aria-hidden="true" /><span class="sr-only">Загружаю каталог…</span></template>
      <template v-else-if="error">Каталог сейчас недоступен — спросите консультанта справа, он ищет по тому же каталогу.</template>
      <template v-else-if="data">
        <template v-if="data.total">{{ fmt(data.total) }} {{ plural(data.total, 'позиция', 'позиции', 'позиций') }}</template>
        <template v-else>Ничего не нашлось{{ qs.q ? ` по запросу «${qs.q}»` : '' }}. Опишите задачу консультанту — он подберёт аналог или передаст менеджеру.</template>
        <span v-if="qs.q && data.total" class="muted"> · по запросу «{{ qs.q }}»</span>
      </template>
    </p>

    <!-- Скелет на время загрузки: те же размеры карточек, сетка не прыгает -->
    <ul v-if="pending" class="grid" aria-hidden="true">
      <li v-for="n in 12" :key="n" class="card sk-card" :style="{ animationDelay: `${(n % 4) * 90}ms` }">
        <span class="sk sk-cat" /><span class="sk sk-name" /><span class="sk sk-name short" /><span class="sk sk-vendor" />
        <span class="card-foot"><span class="sk sk-price" /><span class="sk sk-flag" /></span>
      </li>
    </ul>

    <ul v-else-if="items.length" class="grid">
      <li v-for="(it, i) in items" :key="it.sku" :class="{ 'anim-in': i >= (data?.items.length ?? 0) }">
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

    <ul v-if="loadingMore" class="grid more-sk" aria-hidden="true">
      <li v-for="n in 4" :key="n" class="card sk-card" :style="{ animationDelay: `${n * 90}ms` }">
        <span class="sk sk-cat" /><span class="sk sk-name" /><span class="sk sk-vendor" />
        <span class="card-foot"><span class="sk sk-price" /><span class="sk sk-flag" /></span>
      </li>
    </ul>

    <div v-if="!pending && items.length" ref="sentinel" class="tail" aria-live="polite">
      <template v-if="moreError">
        Не удалось догрузить. <button class="btn sm" @click="loadMore">Повторить</button>
      </template>
      <template v-else-if="hasMore">
        <span class="mono">Показано {{ fmt(items.length) }} из {{ fmt(data?.total ?? 0) }}</span>
      </template>
      <template v-else-if="(data?.total ?? 0) > items.length">
        <span class="mono">Показаны первые {{ fmt(items.length) }} — уточните поиск или раздел</span>
      </template>
      <template v-else-if="items.length > 24">
        <span class="mono">Это все {{ fmt(items.length) }}</span>
      </template>
    </div>
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

/* Скелет: серые плашки с бегущим бликом */
.sk {
  display: block;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--bg-hover) 0%, var(--bg-active) 40%, var(--bg-hover) 80%) 0 0 / 300% 100%;
  animation: sk-shine 1.3s linear infinite;
  animation-delay: inherit;
}

@keyframes sk-shine {
  from { background-position: 100% 0; }
  to { background-position: -50% 0; }
}

.sk-card { min-height: 150px; pointer-events: none; }
.sk-card:hover { border-color: var(--line); }
.sk-line { display: inline-block; width: 140px; height: 12px; vertical-align: middle; }
.sk-cat { width: 40%; height: 9px; margin-bottom: 4px; }
.sk-name { width: 92%; height: 13px; }
.sk-name.short { width: 64%; }
.sk-vendor { width: 46%; height: 10px; margin-top: 4px; }
.sk-price { width: 76px; height: 14px; }
.sk-flag { width: 64px; height: 10px; }

.more-sk { margin-top: 10px; }

.tail {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 48px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--ink-3);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (max-width: 560px) {
  .grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
