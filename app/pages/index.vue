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
  return 'Сверяю каждую цифру с каталогом…'
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

/** После передачи менеджеру или черновика КП ждём ответа менеджера в этом же чате (раз в 5с, не постоянно). */
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
  <div class="chat-shell">
    <!-- Quiet Top Bar -->
    <header class="topbar">
      <div class="topbar-inner chat-topbar-inner">
        <div class="brand-wrap">
          <div class="brand-mark" aria-hidden="true">ДС</div>
          <span class="brand-title">{{ shopName }}</span>
        </div>
        <div class="topbar-actions">
          <button v-if="messages.length" class="btn small ghost" :disabled="busy" @click="restart">
            Новый диалог
          </button>
          <NuxtLink to="/manager" class="nav-link">Панель менеджера →</NuxtLink>
        </div>
      </div>
    </header>

    <!-- Single-column Breathable Workspace -->
    <div class="chat-container">
      <!-- Quiet Trust Strip -->
      <div class="trust-bar">
        <span class="trust-dot" aria-hidden="true" />
        <span>Цены из каталога, сверка каждой цифры, ПДн скрыты от модели</span>
      </div>

      <!-- Feed -->
      <main ref="list" class="feed" aria-live="polite">
        <!-- Empty / Welcome State -->
        <div v-if="!messages.length" class="welcome">
          <h1 class="welcome-title">Подбор корпоративного ПО и расчёт КП</h1>
          <p class="welcome-sub">
            Опишите задачу своими словами — уточню требования, сравню варианты из каталога, найду российский аналог и соберу черновик КП на проверку менеджеру.
          </p>
          <div class="starters">
            <button
              v-for="s in starters"
              :key="s"
              class="starter-card"
              :disabled="busy"
              @click="send(s)"
            >
              <span>{{ s }}</span>
              <span class="starter-arrow" aria-hidden="true">→</span>
            </button>
          </div>
        </div>

        <!-- Messages -->
        <div v-for="(m, i) in messages" :key="i" class="turn" :class="m.role">
          <!-- User Turn -->
          <div v-if="m.role === 'user'" class="user-pill">
            {{ m.content }}
          </div>

          <!-- Assistant / Manager Turn (Editorial, no heavy box) -->
          <div v-else class="reply-block" :class="{ 'is-manager': m.role === 'manager' }">
            <div class="reply-meta">
              <span class="reply-role">{{ m.role === 'manager' ? 'Менеджер' : 'Консультант' }}</span>
              <span v-if="m.role === 'manager'" class="chip ok">Ответил специалист</span>
            </div>

            <div class="md" v-html="renderMd(m.content)" />

            <!-- THE ONE Elevated Document Card: Draft Proposal / Invoice -->
            <div v-for="d in m.drafts" :key="d.id" class="draft-card">
              <div class="draft-head">
                <div class="draft-title">
                  <svg class="doc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                  </svg>
                  <span>Черновик {{ d.kind === 'proposal' ? 'КП' : 'счёта' }}</span>
                  <span class="mono muted draft-num">{{ d.number }}</span>
                </div>
                <span class="chip warn">На проверке у менеджера</span>
              </div>
              <div class="draft-foot">
                <span class="draft-hint">Документ без подписи и печати — после проверки менеджер отправит финальный PDF.</span>
                <span class="draft-total num">{{ d.total }}</span>
              </div>
            </div>

            <!-- Escalation Inline Notice -->
            <div v-if="m.escalated" class="handoff-note">
              <span class="handoff-dot" aria-hidden="true" />
              <span>Вопрос передан менеджеру — ответ появится прямо в этом чате.</span>
            </div>

            <!-- Quiet Inline Sources -->
            <div v-if="m.sources?.length" class="sources-line">
              <span class="sources-label">Источники:</span>
              <span v-for="s in uniqSources(m.sources)" :key="s.slug" class="source-item">
                {{ s.title }}<template v-if="s.heading"> · {{ s.heading }}</template>
              </span>
            </div>
          </div>
        </div>

        <!-- Smart Architecture Wait Indicator -->
        <div v-if="busy" class="turn assistant">
          <div class="reply-block">
            <div class="reply-meta">
              <span class="reply-role">Консультант</span>
              <span class="mono wait-sec">{{ elapsedSec }} с</span>
            </div>
            <div class="wait-box" role="status">
              <span class="wait-pulse" aria-hidden="true" />
              <span>{{ waitStage }}</span>
            </div>
          </div>
        </div>
      </main>

      <!-- Sticky Minimal Composer -->
      <footer class="composer-wrap">
        <p v-if="error" class="err-line" role="alert">{{ error }}</p>
        <div class="composer-box" :class="{ disabled: busy }">
          <textarea
            v-model="text"
            class="composer-input"
            rows="2"
            maxlength="4000"
            :disabled="busy"
            placeholder="Спросите про лицензии, российские аналоги или запросите КП…"
            aria-label="Сообщение"
            @keydown="onKey"
          />
          <button class="btn primary send-btn" :disabled="busy || !text.trim()" @click="send()">
            Отправить
          </button>
        </div>
        <div class="composer-meta">
          <span>Enter — отправить, Shift+Enter — перенос строки</span>
          <span class="mono">{{ text.length }} / 4000</span>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.chat-shell {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.chat-topbar-inner {
  max-width: 820px;
}

.chat-container {
  flex: 1;
  width: 100%;
  max-width: 820px;
  margin: 0 auto;
  padding: 0 24px;
  display: flex;
  flex-direction: column;
  height: calc(100dvh - 56px);
}

.trust-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
  border-bottom: 1px solid var(--line-soft);
  font-size: 12.5px;
  color: var(--muted);
}

.trust-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #10b981;
  flex: none;
}

.feed {
  flex: 1;
  overflow-y: auto;
  padding: 28px 0 20px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}

/* Welcome State */
.welcome {
  margin: auto 0;
  padding: 12px 0 24px;
}

.welcome-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.025em;
  line-height: 1.25;
  color: var(--text);
}

.welcome-sub {
  margin: 10px 0 24px;
  max-width: 58ch;
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--muted);
}

.starters {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.starter-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  text-align: left;
  padding: 13px 15px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 13.5px;
  line-height: 1.45;
  cursor: pointer;
  transition: border-color 150ms var(--ease), color 150ms var(--ease), background 150ms var(--ease);
}

.starter-card:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
  background: var(--bg-subtle);
}

.starter-arrow {
  color: var(--muted);
  flex: none;
  transition: transform 150ms var(--ease), color 150ms var(--ease);
}

.starter-card:hover .starter-arrow {
  color: var(--accent);
  transform: translateX(2px);
}

/* Conversation Turns */
.turn {
  display: flex;
  flex-direction: column;
}

.turn.user {
  align-items: flex-end;
}

.user-pill {
  max-width: 52ch;
  padding: 10px 16px;
  border-radius: 16px;
  background: var(--bg-muted);
  color: var(--text);
  font-size: 14.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.reply-block {
  max-width: 66ch;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.reply-block.is-manager {
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--ok-soft);
  border: 1px solid var(--ok-line);
}

.reply-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.reply-role {
  font-weight: 600;
  color: var(--text-secondary);
}

/* Draft Proposal Document Card */
.draft-card {
  margin-top: 4px;
  padding: 14px 16px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line-strong);
  border-left: 3px solid var(--accent);
  background: var(--bg-subtle);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.draft-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.draft-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.doc-icon {
  width: 16px;
  height: 16px;
  color: var(--accent);
  flex: none;
}

.draft-num {
  font-size: 12.5px;
  font-weight: 500;
}

.draft-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.draft-hint {
  font-size: 12.5px;
  color: var(--muted);
  max-width: 44ch;
}

.draft-total {
  font-size: 17px;
  font-weight: 600;
  color: var(--text);
}

/* Escalation Notice */
.handoff-note {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--warn-soft);
  border: 1px solid var(--warn-line);
  color: var(--warn);
  font-size: 13px;
}

.handoff-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--warn);
  flex: none;
}

/* Quiet Sources */
.sources-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 12px;
  font-size: 12px;
  color: var(--muted);
  padding-top: 2px;
}

.sources-label {
  color: #a1a1aa;
}

.source-item {
  color: var(--text-secondary);
  text-decoration: underline;
  text-decoration-color: var(--line);
  text-underline-offset: 4px;
}

/* Smart Wait Indicator */
.wait-sec {
  font-size: 11.5px;
  color: var(--muted);
}

.wait-box {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 13.5px;
  color: var(--muted);
  padding: 4px 0;
}

.wait-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.25; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.1); }
}

/* Composer */
.composer-wrap {
  padding: 12px 0 18px;
  background: var(--bg);
}

.err-line {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--bad);
}

.composer-box {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 8px 10px 8px 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  transition: border-color 150ms var(--ease);
}

.composer-box:focus-within {
  border-color: var(--accent);
}

.composer-box.disabled {
  background: var(--bg-subtle);
}

.composer-input {
  flex: 1;
  border: 0;
  background: transparent;
  resize: none;
  padding: 4px 0;
  font-size: 14.5px;
  line-height: 1.5;
  color: var(--text);
  outline: none;
}

.composer-input::placeholder {
  color: #a1a1aa;
}

.send-btn {
  flex: none;
}

.composer-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 7px;
  padding: 0 2px;
  font-size: 11.5px;
  color: #a1a1aa;
}

@media (max-width: 640px) {
  .chat-container { padding: 0 16px; }
  .starters { grid-template-columns: 1fr; }
  .welcome-title { font-size: 20px; }
}
</style>
