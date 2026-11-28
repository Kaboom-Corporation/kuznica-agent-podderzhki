<script setup lang="ts">
import type { ChatPage } from '~/components/ChatPanel.vue'

interface ShopCard {
  sku: string; name: string; vendor: string; category: string; unit: string
  term_months: number | null; price: string | null; lot: string | null; stock: number; lead_days: number | null; in_registry: boolean
  description: string; url: string | null
}

const route = useRoute()
const sku = computed(() => String(route.params.sku ?? ''))
const { data: card, error } = useFetch<ShopCard>(() => `/api/shop/${encodeURIComponent(sku.value)}`)

// консультант видит открытую карточку: сервер подкладывает её агенту в контекст
const page = useState<ChatPage | null>('shop-page', () => null)
// сбрасывает список (shop/index.vue): снимать здесь в onBeforeUnmount нельзя — при переходе
// с карточки на карточку старая размонтируется уже после того, как новая выставила своё
watch(card, c => { page.value = c ? { sku: c.sku, name: c.name } : null }, { immediate: true })

const sheetOpen = useState('shop-chat-open', () => false)
// назад — к тому же поиску и странице, если пришли из списка
// (читаем после монтирования, чтобы ссылка с сервера и в браузере совпала)
const backTo = ref('/shop')
onMounted(() => {
  const from = window.history.state?.back
  if (typeof from === 'string' && from.startsWith('/shop') && !from.startsWith('/shop/')) backTo.value = from
})
useHead(() => ({ title: card.value?.name ?? 'Товар' }))

// описание из фида склеено через « • » — показываем пунктами
const facts = computed(() => (card.value?.description ?? '').split(' • ').map(s => s.trim()).filter(Boolean))
const safeUrl = computed(() => (card.value?.url && /^https?:\/\//i.test(card.value.url) ? card.value.url : null))
</script>

<template>
  <div class="item">
    <NuxtLink :to="backTo" class="back">← К каталогу</NuxtLink>

    <div v-if="error" class="missing">
      <h1>Такого товара нет в каталоге</h1>
      <p>Возможно, позицию сняли с продажи при последнем обновлении. Опишите консультанту, что нужно, — он подберёт замену.</p>
    </div>

    <article v-else-if="card" class="sheet">
      <p class="crumbs">{{ card.category }}</p>
      <h1 class="name">{{ card.name }}</h1>
      <p class="vendor">{{ card.vendor }}<span class="mono sku"> · {{ card.sku }}</span></p>

      <div class="buy">
        <div>
          <p v-if="card.price" class="price num">{{ card.price }}</p>
          <p v-else class="price on-request">Цена по запросу</p>
          <p class="price-note">
            <template v-if="card.price">за {{ card.unit === 'лицензия' ? 'лицензию' : card.unit || 'единицу' }}<template v-if="card.lot"> при заказе {{ card.lot }} шт.</template><template v-if="card.term_months">, срок {{ card.term_months }} мес.</template> · итог на ваше число мест посчитает консультант</template>
            <template v-else>Сумму назовёт менеджер — консультант передаст ему запрос</template>
          </p>
        </div>
        <button class="btn primary ask" @click="sheetOpen = true">Спросить про этот товар</button>
      </div>

      <ul class="flags">
        <li v-if="card.stock > 0" class="status"><span class="status-dot ok" aria-hidden="true" />На складе: {{ card.stock }} шт.</li>
        <li v-else-if="card.stock < 0" class="status"><span class="status-dot ok" aria-hidden="true" />Доступно к заказу</li>
        <li v-else class="status"><span class="status-dot warn" aria-hidden="true" />Сейчас нет в наличии — срок поставки подтвердит менеджер</li>
        <li v-if="card.in_registry" class="status"><span class="status-dot accent" aria-hidden="true" />В реестре российского ПО</li>
      </ul>

      <section v-if="facts.length" class="about">
        <h2>О товаре</h2>
        <ul>
          <li v-for="(f, i) in facts" :key="i">{{ f }}</li>
        </ul>
      </section>

      <a v-if="safeUrl" :href="safeUrl" class="btn ghost sm src" target="_blank" rel="noopener noreferrer">Страница товара у поставщика ↗</a>
    </article>

    <p v-else class="muted">Загружаю карточку…</p>
  </div>
</template>

<style scoped>
.item {
  max-width: 760px;
  margin: 0 auto;
}

.back {
  display: inline-block;
  font-size: 12.5px;
  color: var(--ink-3);
  text-decoration: none;
  margin-bottom: 14px;
}

.back:hover { color: var(--ink); }

.sheet,
.missing {
  padding: 24px 26px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg);
  box-shadow: var(--shadow-card);
}

.missing h1 { font-size: 18px; margin: 0 0 6px; }
.missing p { margin: 0; color: var(--ink-2); font-size: 13.5px; }

.crumbs {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--ink-4);
}

.name {
  margin: 0;
  font-size: 22px;
  line-height: 1.3;
  font-weight: 600;
  letter-spacing: -0.01em;
  text-wrap: balance;
}

.vendor {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--ink-2);
}

.sku {
  font-size: 11.5px;
  color: var(--ink-4);
}

.buy {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 20px;
  padding: 16px 0;
  border-top: 1px solid var(--line-soft);
  border-bottom: 1px solid var(--line-soft);
}

.price {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
}

.price.on-request {
  font-size: 18px;
  color: var(--ink-2);
}

.price-note {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--ink-3);
}

.ask {
  height: 36px;
  padding: 0 16px;
}

.flags {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin: 16px 0 0;
  padding: 0;
}

.about h2 {
  margin: 22px 0 8px;
  font-size: 13px;
  font-weight: 600;
}

.about ul {
  margin: 0;
  padding-left: 18px;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--ink-2);
}

.src {
  margin-top: 18px;
  padding-left: 0;
}

/* на широком экране чат уже открыт справа — кнопка там лишняя */
@media (min-width: 961px) {
  .ask { display: none; }
}

@media (max-width: 560px) {
  .sheet, .missing { padding: 18px 16px; }
  .name { font-size: 19px; }
  .ask { width: 100%; }
}
</style>
