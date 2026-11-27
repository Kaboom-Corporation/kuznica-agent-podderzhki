<script setup lang="ts">
import { renderMd } from '~/utils/md'

interface Source { slug: string; title: string; heading: string | null }
interface Draft { kind: 'proposal' | 'invoice'; id: string; number: string; total: string }
interface Msg { role: 'user' | 'assistant' | 'manager'; content: string; sources?: Source[]; drafts?: Draft[]; escalated?: boolean }

const shopName = useRuntimeConfig().public.shopName
const KEY = 'chat-conversation'
const messages = ref<Msg[]>([])
const text = ref('')
const busy = ref(false)
const elapsedSec = ref(0)
const error = ref('')
const conversationId = ref<string | null>(null)
const list = ref<HTMLElement | null>(null)
let poll: ReturnType<typeof setInterval> | null = null
let pollUntil = 0
let waitTimer: ReturnType<typeof setInterval> | null = null

// «Цены каталога на ДД.ММ ЧЧ:ММ» — чтобы клиент и жюри видели, насколько свежи цифры
const { data: catalog } = useFetch<{ at: string | null; items: number }>('/api/catalog', { server: false })
const catalogAt = computed(() => {
  const at = catalog.value?.at
  if (!at) return ''
  return new Date(at).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).replace(',', '')
})

const starters = [
  'Не знаю, что нужно. Надо защитить почту и файлы на 50 сотрудников',
  'Сколько стоит Kaspersky Endpoint Security на 25 компьютеров?',
  'Есть российский аналог Microsoft Office?',
  'Как получить закрывающие документы и счёт на юрлицо?',
]

const waitStage = computed(() => {
  if (elapsedSec.value < 5) return 'Маскирую персональные данные…'
  if (elapsedSec.value < 15) return 'Ищу в каталоге и базе знаний…'
  if (elapsedSec.value < 30) return 'Подбираю варианты и рассчитываю цены…'
  return 'Сверяю цифры с каталогом…'
})

function startWaitTimer() {
  elapsedSec.value = 0
  if (waitTimer) clearInterval(waitTimer)
  waitTimer = setInterval(() => { elapsedSec.value++ }, 1000)
}

function stopWaitTimer() {
  if (waitTimer) clearInterval(waitTimer)
  waitTimer = null
}

function store(id: string | null) {
  try { id ? localStorage.setItem(KEY, id) : localStorage.removeItem(KEY) } catch {}
}

async function scrollDown() {
  await nextTick()
  list.value?.scrollTo({ top: list.value.scrollHeight, behavior: 'smooth' })
}

async function loadHistory(id: string) {
  const r = await $fetch<{ messages: { role: Msg['role']; content: string }[] }>(`/api/chat/${id}`)
  return r.messages
}

/** Опрос GET /api/chat/:id раз в 5с только пока ждём ответ менеджера по эскалации или КП. */
function startPolling() {
  pollUntil = Date.now() + 15 * 60_000
  if (poll) return
  poll = setInterval(async () => {
    if (!conversationId.value || Date.now() > pollUntil) return stopPolling()
    try {
      const server = (await loadHistory(conversationId.value)).filter(m => m.role === 'manager')
      const shown = messages.value.filter(m => m.role === 'manager').length
      if (server.length > shown) {
        for (const m of server.slice(shown)) messages.value.push({ role: 'manager', content: m.content })
        scrollDown()
      }
    } catch {}
  }, 5000)
}

function stopPolling() {
  if (poll) clearInterval(poll)
  poll = null
}

async function send(q?: string) {
  const value = (q ?? text.value).trim()
  if (!value || busy.value) return
  error.value = ''
  messages.value.push({ role: 'user', content: value })
  text.value = ''
  busy.value = true
  startWaitTimer()
  scrollDown()
  try {
    const r = await $fetch<{ conversationId: string; text: string; sources: Source[]; drafts: Draft[]; escalated: boolean }>('/api/chat', {
      method: 'POST',
      body: { text: value, conversationId: conversationId.value ?? undefined },
    })
    conversationId.value = r.conversationId
    store(r.conversationId)
    messages.value.push({ role: 'assistant', content: r.text, sources: r.sources, drafts: r.drafts, escalated: r.escalated })
    if (r.escalated || r.drafts.length) startPolling()
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.statusMessage || 'Не получилось отправить. Попробуйте ещё раз.'
    messages.value.pop()
    text.value = value
  } finally {
    busy.value = false
    stopWaitTimer()
    scrollDown()
  }
}

function restart() {
  stopPolling()
  stopWaitTimer()
  messages.value = []
  conversationId.value = null
  error.value = ''
  store(null)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

function uniqSources(s: Source[] = []) {
  const seen = new Set<string>()
  return s.filter(x => !seen.has(x.slug) && seen.add(x.slug))
}

onMounted(async () => {
  let id: string | null = null
  try { id = localStorage.getItem(KEY) } catch {}
  if (!id) return
  try {
    const h = await loadHistory(id)
    conversationId.value = id
    messages.value = h.map(m => ({ role: m.role, content: m.content }))
    scrollDown()
  } catch { store(null) }
})

onBeforeUnmount(() => {
  stopPolling()
  stopWaitTimer()
})
</script>

<template>
  <div class="chat-page">
    <!-- Linear 48px Header -->
    <header class="topbar">
      <div class="topbar-inner chat-inner">
        <div class="brand-group">
          <div class="brand-mark" aria-hidden="true">ДС</div>
          <span class="brand-name">{{ shopName }}</span>
        </div>
        <div class="topbar-right">
          <button v-if="messages.length" class="btn ghost sm" :disabled="busy" @click="restart">
            Новый диалог
          </button>
          <NuxtLink to="/manager" class="btn ghost sm">Панель менеджера</NuxtLink>
        </div>
      </div>
    </header>

    <div class="chat-body">
      <main ref="list" class="thread" aria-live="polite">
        <!-- Welcome: Linear Command-List Style (no boxy card grid) -->
        <div v-if="!messages.length" class="welcome">
          <h1 class="welcome-h1">Подбор ПО и расчёт КП</h1>
          <p class="welcome-desc">
            Опишите задачу своими словами — уточню требования, проверю цены по каталогу, подберу российский аналог и подготовлю черновик КП для менеджера.
          </p>

          <div class="cmd-list" role="list">
            <button
              v-for="s in starters"
              :key="s"
              class="cmd-row"
              :disabled="busy"
              @click="send(s)"
            >
              <span class="cmd-text">{{ s }}</span>
              <span class="cmd-hint mono" aria-hidden="true">↵</span>
            </button>
          </div>
        </div>

        <!-- Messages -->
        <article v-for="(m, i) in messages" :key="i" class="turn" :class="m.role">
          <!-- User -->
          <div v-if="m.role === 'user'" class="user-msg">
            {{ m.content }}
          </div>

          <!-- Assistant / Manager -->
          <div v-else class="agent-msg" :class="{ manager: m.role === 'manager' }">
            <div class="agent-head">
              <span class="status">
                <span class="status-dot" :class="m.role === 'manager' ? 'ok' : 'accent'" aria-hidden="true" />
                <span>{{ m.role === 'manager' ? 'Менеджер' : 'Консультант' }}</span>
              </span>
            </div>

            <div class="md" v-html="renderMd(m.content)" />

            <!-- Stripe / Linear Attachment Row for Draft Proposal -->
            <div v-for="d in m.drafts" :key="d.id" class="attachment">
              <div class="att-left">
                <svg class="att-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
                <div class="att-meta">
                  <div class="att-title">
                    <span>Черновик {{ d.kind === 'proposal' ? 'КП' : 'счёта' }}</span>
                    <span class="mono muted">{{ d.number }}</span>
                  </div>
                  <div class="att-sub">
                    <span class="status">
                      <span class="status-dot warn" aria-hidden="true" />
                      <span>На проверке у менеджера · без подписи и печати</span>
                    </span>
                  </div>
                </div>
              </div>
              <div class="att-total num">{{ d.total }}</div>
            </div>

            <!-- Escalation: Quiet Inline Line -->
            <div v-if="m.escalated" class="inline-note">
              <span class="status">
                <span class="status-dot warn" aria-hidden="true" />
                <span>Вопрос передан менеджеру — ответ появится прямо в этом чате.</span>
              </span>
            </div>

            <!-- Sources: Subtle Footnote -->
            <div v-if="m.sources?.length" class="sources">
              <span>Источники:</span>
              <span v-for="(s, idx) in uniqSources(m.sources)" :key="s.slug">
                <template v-if="idx > 0"> · </template>{{ s.title }}<template v-if="s.heading"> ({{ s.heading }})</template>
              </span>
            </div>
          </div>
        </article>

        <!-- Minimal Spinner Wait Indicator -->
        <div v-if="busy" class="turn assistant">
          <div class="agent-msg">
            <div class="wait-row" role="status">
              <span class="spinner" aria-hidden="true" />
              <span>{{ waitStage }}</span>
              <span class="mono muted">{{ elapsedSec }} с</span>
            </div>
          </div>
        </div>
      </main>

      <!-- Linear Integrated Composer -->
      <footer class="composer-area">
        <p v-if="error" class="err-line" role="alert">{{ error }}</p>
        <div class="composer" :class="{ disabled: busy }">
          <textarea
            v-model="text"
            class="composer-ta"
            rows="2"
            maxlength="4000"
            :disabled="busy"
            placeholder="Напишите задачу, название продукта или запросите КП…"
            aria-label="Сообщение"
            @keydown="onKey"
          />
          <div class="composer-bar">
            <span class="composer-note">
              ПДн маскируются до модели<template v-if="catalogAt"> · <span :title="`Каталог обновляется из фида магазина каждые сутки, позиций: ${catalog?.items}`">цены каталога на {{ catalogAt }}</span></template>
              · <span class="mono">{{ text.length }}/4000</span>
            </span>
            <button class="btn primary" :disabled="busy || !text.trim()" @click="send()">
              Отправить
            </button>
          </div>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.chat-page {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.chat-inner {
  max-width: 780px;
  margin: 0 auto;
}

.chat-body {
  flex: 1;
  width: 100%;
  max-width: 780px;
  margin: 0 auto;
  padding: 0 20px;
  display: flex;
  flex-direction: column;
  height: calc(100dvh - 48px);
}

.thread {
  flex: 1;
  overflow-y: auto;
  padding: 28px 0 20px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* Welcome — Linear Command List */
.welcome {
  margin: auto 0;
  padding: 12px 0 24px;
}

.welcome-h1 {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.welcome-desc {
  margin: 8px 0 22px;
  max-width: 56ch;
  font-size: 14px;
  color: var(--ink-3);
}

.cmd-list {
  border-top: 1px solid var(--line);
}

.cmd-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  text-align: left;
  padding: 11px 8px;
  border: 0;
  border-bottom: 1px solid var(--line-soft);
  background: transparent;
  color: var(--ink-2);
  font-size: 13.5px;
  cursor: pointer;
  transition: background 120ms var(--ease), color 120ms var(--ease);
}

.cmd-row:hover:not(:disabled) {
  background: var(--bg-chrome);
  color: var(--ink);
}

.cmd-hint {
  font-size: 12px;
  color: var(--ink-4);
  opacity: 0;
  transition: opacity 120ms var(--ease);
}

.cmd-row:hover .cmd-hint {
  opacity: 1;
}

/* Turns */
.turn {
  display: flex;
  flex-direction: column;
}

.turn.user {
  align-items: flex-end;
}

.user-msg {
  max-width: 52ch;
  padding: 9px 14px;
  border-radius: 8px;
  background: var(--bg-chrome);
  border: 1px solid var(--line);
  color: var(--ink);
  font-size: 14px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.agent-msg {
  max-width: 66ch;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.agent-msg.manager {
  border-left: 2px solid var(--dot-ok);
  padding-left: 14px;
}

.agent-head {
  display: flex;
  align-items: center;
}

/* Linear / Stripe Attachment Row */
.attachment {
  margin-top: 4px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--line-strong);
  background: var(--bg);
  box-shadow: var(--shadow-card);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.att-left {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
}

.att-icon {
  width: 18px;
  height: 18px;
  color: var(--ink-3);
  margin-top: 2px;
  flex: none;
}

.att-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.att-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink);
}

.att-sub {
  font-size: 12px;
}

.att-total {
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
}

.inline-note {
  padding-top: 2px;
}

.sources {
  font-size: 12px;
  color: var(--ink-4);
  padding-top: 2px;
}

/* Spinner Wait Row */
.wait-row {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  color: var(--ink-3);
}

.spinner {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  border-top-color: var(--indigo);
  animation: spin 0.75s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Linear Integrated Composer */
.composer-area {
  padding: 8px 0 18px;
  background: var(--bg);
}

.err-line {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: var(--dot-bad);
}

.composer {
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--bg);
  box-shadow: var(--shadow-card);
  transition: border-color 120ms var(--ease);
}

.composer:focus-within {
  border-color: var(--indigo);
}

.composer.disabled {
  background: var(--bg-chrome);
}

.composer-ta {
  width: 100%;
  display: block;
  border: 0;
  background: transparent;
  resize: none;
  padding: 10px 12px 6px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ink);
  outline: none;
}

.composer-ta::placeholder {
  color: var(--ink-4);
}

.composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 8px 8px 12px;
  border-top: 1px solid var(--line-soft);
}

.composer-note {
  font-size: 11.5px;
  color: var(--ink-4);
}

@media (max-width: 640px) {
  .chat-body { padding: 0 14px; }
  .composer-note { display: none; }
}
</style>
