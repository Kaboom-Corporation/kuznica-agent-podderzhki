<script setup lang="ts">
import ChatPanel, { type ChatPage } from '~/components/ChatPanel.vue'

// Чат во фрейме виджета (public/widget.js) на сайте магазина. Открытую страницу магазина виджет передаёт
// в адресе фрейма (?url=&title=), а при переходах внутри сайта — сообщением kuznica:page.
// Это недоверенные данные чужой страницы: сервер сам чистит заголовок и ищет карточку по адресу (server/agent/page.ts).
const route = useRoute()
const chat = ref<InstanceType<typeof ChatPanel> | null>(null)

function toPage(url: unknown, title: unknown): ChatPage | null {
  const u = typeof url === 'string' && url.length <= 2048 && /^https?:\/\/[^/\s]+/i.test(url) ? url : undefined
  const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  let name = t
  if (!name && u) {
    try { name = new URL(u).hostname } catch {}
  }
  return name ? { url: u, name } : null
}

const page = ref<ChatPage | null>(toPage(route.query.url, route.query.title))

// Кнопка «закрыть» есть только во фрейме: открытая отдельно страница закрываться не должна
const framed = ref(false)
function onMessage(e: MessageEvent) {
  if (e.source !== window.parent || e.data?.type !== 'kuznica:page') return
  page.value = toPage(e.data.url, e.data.title)
}
onMounted(() => {
  framed.value = window.parent !== window
  window.addEventListener('message', onMessage)
})
onBeforeUnmount(() => window.removeEventListener('message', onMessage))

// В сообщении «закрыть» данных нет, поэтому адресат — любой родитель
function close() {
  window.parent.postMessage({ type: 'kuznica:close' }, '*')
}

const starters = computed(() => page.value
  ? ['Сколько это стоит на 10 рабочих мест?', 'Есть ли российский аналог?', 'Подготовьте КП на эту позицию']
  : ['Нужен антивирус на 30 компьютеров', 'Чем заменить Microsoft Office?', 'Как получить закрывающие документы и счёт на юрлицо?'])

useHead({ title: 'Консультант' })
</script>

<template>
  <div class="embed">
    <header class="embed-head">
      <span class="status"><span class="status-dot ok" aria-hidden="true" />Консультант</span>
      <span class="embed-tools">
        <button v-if="chat?.messages.length" class="btn ghost sm" :disabled="chat?.busy" @click="chat?.restart()">Новый диалог</button>
        <button v-if="framed" class="btn ghost sm embed-close" aria-label="Свернуть чат" title="Свернуть" @click="close">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </span>
    </header>
    <div class="embed-body">
      <ChatPanel
        ref="chat"
        dock
        :page="page"
        :starters="starters"
        title="Консультант"
        intro="Спросите про цену на ваше число мест, наличие, сроки или аналоги — отвечу по каталогу и соберу черновик КП."
      />
    </div>
  </div>
</template>

<style scoped>
.embed {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.embed-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 44px;
  padding: 0 8px 0 16px;
  border-bottom: 1px solid var(--line-soft);
  flex: none;
}

.embed-tools {
  display: flex;
  gap: 4px;
}

.embed-close {
  width: 32px;
  padding: 0;
  justify-content: center;
  color: var(--ink-3);
}

.embed-body {
  flex: 1;
  min-height: 0;
}
</style>
