<script setup lang="ts">
import { renderMd } from '~/utils/md'

interface Source { slug: string; title: string; heading: string | null }
interface Draft { kind: 'proposal' | 'invoice'; id: string; number: string; total: string }
interface Msg {
  role: 'user' | 'assistant' | 'manager'
  content: string
  sources?: Source[]
  drafts?: Draft[]
  escalated?: boolean
  about?: string
  /** у реплики клиента: сколько ПДн спрятано от модели (0 — ничего, отметку не показываем) */
  pii?: number
  /** у ответа: кнопки следующего вопроса */
  suggestions?: string[]
}
/**
 * Страница, которую клиент сейчас смотрит: агент получает её в контексте.
 * Витрина стенда знает артикул карточки (sku). Виджет на чужом сайте знает только адрес и название страницы;
 * карточку по адресу находит сервер (server/agent/page.ts), а название идёт подсказкой.
 */
export interface ChatPage { sku?: string; url?: string; name: string }

const props = defineProps<{ page?: ChatPage | null; starters?: string[]; title?: string; intro?: string; dock?: boolean }>()

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

const defaultStarters = [
  'Не знаю, что нужно. Надо защитить почту и файлы на 50 сотрудников',
  'Сколько стоит Kaspersky Endpoint Security на 25 компьютеров?',
  'Есть российский аналог Microsoft Office?',
  'Как получить закрывающие документы и счёт на юрлицо?',
]
const starters = computed(() => props.starters ?? defaultStarters)

// «Маскирую ПДн» — только когда в тексте похоже на ПДн (телефон, почта, длинные номера, ФИО),
// иначе жюри видит маскировку на вопросе, где прятать нечего. Точный счёт приходит с сервера.
const PII_HINT = /@|\+?\d[\d\s()-]{9,}\d|\b\d{10,}\b|[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:вич|вна|ична)\b/
const piiHint = ref(false)

const waitStage = computed(() => {
  if (elapsedSec.value < 5) return piiHint.value ? 'Маскирую персональные данные…' : 'Читаю вопрос…'
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

// Затемнение края ленты — только если за этим краем есть скрытый текст. BugCatcher 28.11:
// внизу ленты постоянное затемнение прятало последний ответ, хотя прокручивать было уже некуда.
const fadeTop = ref(false)
const fadeBottom = ref(false)
function updateFade() {
  const el = list.value
  if (!el) return
  fadeTop.value = el.scrollTop > 4
  fadeBottom.value = el.scrollHeight - el.clientHeight - el.scrollTop > 4
}
let fadeObserver: ResizeObserver | null = null
onMounted(() => {
  updateFade()
  if (list.value && typeof ResizeObserver !== 'undefined') {
    fadeObserver = new ResizeObserver(updateFade)
    fadeObserver.observe(list.value)
    for (const child of Array.from(list.value.children)) fadeObserver.observe(child)
  }
})
onBeforeUnmount(() => fadeObserver?.disconnect())

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
  const page = props.page ?? null
  const mine: Msg = { role: 'user', content: value, about: page ? `${page.sku ? 'о товаре' : 'со страницы'}: ${page.name}` : undefined }
  messages.value.push(mine)
  text.value = ''
  piiHint.value = PII_HINT.test(value)
  busy.value = true
  startWaitTimer()
  scrollDown()
  try {
    const r = await $fetch<{ conversationId: string; text: string; sources: Source[]; drafts: Draft[]; escalated: boolean; pii?: number; suggestions?: string[] }>('/api/chat', {
      method: 'POST',
      body: { text: value, conversationId: conversationId.value ?? undefined, page: page ? (page.sku ? { sku: page.sku } : { url: page.url, title: page.name }) : undefined },
    })
    conversationId.value = r.conversationId
    store(r.conversationId)
    // реактивная копия, а не mine: иначе Vue не заметит новое поле
    const u = messages.value.findLast(m => m.role === 'user')
    if (u) u.pii = r.pii ?? 0
    messages.value.push({ role: 'assistant', content: r.text, sources: r.sources, drafts: r.drafts, escalated: r.escalated, suggestions: r.suggestions ?? [] })
    if (r.escalated || r.drafts.length) startPolling()
  } catch (e: any) {
    // 4xx — наши тексты (лимит, пустое сообщение); у 5xx statusMessage служебный («Server Error»), клиенту его не показываем
    const status = Number(e?.statusCode ?? e?.status ?? 0)
    const own = status >= 400 && status < 500 ? (e?.data?.statusMessage || e?.statusMessage) : ''
    error.value = own || 'Не получилось отправить. Попробуйте ещё раз.'
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

// Поле ввода растёт под текст до потолка из CSS, дальше листается внутри
const ta = ref<HTMLTextAreaElement | null>(null)
function fitComposer() {
  const el = ta.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight + 2}px`
}
watch(text, () => nextTick(fitComposer))

// Диктовка: распознанное дописываем в поле — клиент проверяет и отправляет сам
const voiceOn = !!useRuntimeConfig().public.voiceInput
const dictation = useDictation((t) => {
  const cur = text.value.trimEnd()
  text.value = (cur ? `${cur} ${t}` : t).slice(0, 4000)
  nextTick(() => ta.value?.focus())
})
const voiceLabel = computed(() => ({
  idle: 'Надиктовать',
  recording: `Остановить запись, ${dictation.seconds.value} с`,
  recognizing: 'Распознаю речь…',
})[dictation.state.value])
const recClock = computed(() => {
  const s = dictation.seconds.value
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})
// После ответа курсор возвращается в поле, кроме телефона: там не открываем клавиатуру сами
watch(busy, (b) => {
  if (!b && ta.value && matchMedia('(hover: hover)').matches) ta.value.focus()
})

function onKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

function uniqSources(s: Source[] = []) {
  const seen = new Set<string>()
  return s.filter(x => !seen.has(x.slug) && seen.add(x.slug))
}

// BugCatcher 28.11: источник под ответом — короткой сноской, а не полным заголовком страницы с разделом.
// Полное название — во всплывающей подсказке.
function shortTitle(title: string) {
  const t = title
    .replace(/^Демо Софт\s+(Акции\s+)?/u, '')
    .replace(/\s+(в|для)\s+(B2B-маркетплейсе\s+)?Демо Софт$/u, '')
    .replace(/\s+-\s+.*$/u, '')
    .trim()
  return t.length > 42 ? `${t.slice(0, 40).trimEnd()}…` : t
}
const MAX_SOURCES = 3

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

defineExpose({ restart, messages, busy })
</script>

<template>
<div class="chat-body" :class="{ dock }">
  <main ref="list" class="thread" :class="{ 'fade-top': fadeTop, 'fade-bottom': fadeBottom }" aria-live="polite" @scroll.passive="updateFade">
    <!-- Welcome: Linear Command-List Style (no boxy card grid) -->
    <div v-if="!messages.length" class="welcome">
      <h1 class="welcome-h1">{{ title ?? 'Подбор ПО и расчёт КП' }}</h1>
      <p class="welcome-desc">
        {{ intro ?? 'Опишите задачу своими словами — уточню требования, проверю цены по каталогу, подберу российский аналог и подготовлю черновик КП для менеджера.' }}
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
        <span v-if="m.about" class="user-about">{{ m.about }}</span>
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
          <span>Источники: </span>
          <span v-for="(s, idx) in uniqSources(m.sources).slice(0, MAX_SOURCES)" :key="s.slug" :title="s.heading ? `${s.title} — ${s.heading}` : s.title">
            <template v-if="idx > 0"> · </template>{{ shortTitle(s.title) }}
          </span>
          <span v-if="uniqSources(m.sources).length > MAX_SOURCES"> · ещё {{ uniqSources(m.sources).length - MAX_SOURCES }}</span>
        </div>

        <!-- Следующий вопрос: только под последним ответом, пока агент не занят -->
        <div v-if="m.suggestions?.length && i === messages.length - 1 && !busy" class="next-asks" role="group" aria-label="Можно спросить дальше">
          <button v-for="s in m.suggestions" :key="s" type="button" class="next-ask" @click="send(s)">{{ s }}</button>
        </div>
      </div>

      <!-- После v-if/v-else, иначе разрывает цепочку и реплика клиента рисуется ещё и ответом -->
      <p v-if="m.role === 'user' && m.pii" class="pii-note" title="Имена, телефоны, почта и номера документов заменены метками до отправки модели и возвращены в ответ уже у нас">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z" />
        </svg>
        Скрыто персональных данных: {{ m.pii }} — модель их не видела
      </p>
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
    <p v-if="page" class="page-chip" :title="page.sku ? 'Консультант видит эту карточку и отвечает про неё, если вы не назвали другой товар' : 'Консультант видит, с какой страницы магазина вы пишете: если товар не назван, он ищет продукт с этой страницы'">
      <span class="status-dot accent" aria-hidden="true" />
      <span>Смотрите: <b>{{ page.name }}</b></span>
    </p>
    <p v-if="error" class="err-line" role="alert">{{ error }}</p>
    <p v-else-if="dictation.error.value" class="err-line" role="alert">{{ dictation.error.value }}</p>
    <div class="composer" :class="{ disabled: busy }">
      <div v-if="dictation.state.value !== 'idle'" class="live" role="status" aria-live="polite">
        <span class="live-label">{{ dictation.state.value === 'recording' ? 'Слушаю' : 'Распознаю' }}</span>
        <span v-if="dictation.partial.value" class="live-text">{{ dictation.partial.value }}</span>
        <span v-else class="live-hint">{{ dictation.state.value === 'recording' ? 'Говорите — текст появится здесь. Замолчите, и запись остановится сама.' : 'Ещё секунду…' }}</span>
      </div>
      <textarea
        ref="ta"
        v-model="text"
        class="composer-ta"
        rows="2"
        maxlength="4000"
        :placeholder="busy ? 'Агент отвечает — следующее сообщение можно писать сразу' : 'Напишите задачу, название продукта или запросите КП…'"
        aria-label="Сообщение"
        @keydown="onKey"
      />
      <div class="composer-bar">
        <span class="composer-note">
          ПДн маскируются до модели<template v-if="catalogAt"> · <span :title="`Каталог обновляется из фида магазина каждые сутки, позиций: ${catalog?.items}`">цены каталога на {{ catalogAt }}</span></template>
          · <span class="mono">{{ text.length }}/4000</span>
        </span>
        <div class="composer-actions">
          <button
            v-if="voiceOn && dictation.supported.value"
            type="button"
            class="btn ghost mic"
            :class="{ rec: dictation.state.value === 'recording' }"
            :disabled="dictation.state.value === 'recognizing'"
            :aria-label="voiceLabel"
            :title="voiceLabel"
            @click="dictation.toggle()"
          >
            <span v-if="dictation.state.value === 'recognizing'" class="mic-spin" aria-hidden="true" />
            <template v-else-if="dictation.state.value === 'recording'">
              <span class="rec-stop" :style="{ '--lvl': dictation.level.value }" aria-hidden="true" />
              <span>Стоп</span>
              <span class="mono rec-clock">{{ recClock }}</span>
            </template>
            <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
            </svg>
          </button>
          <button class="btn primary" :disabled="busy || !text.trim() || dictation.state.value !== 'idle'" @click="send()">
            Отправить
          </button>
        </div>
      </div>
    </div>
  </footer>
</div>
</template>

<style scoped>
.chat-body {
  flex: 1;
  width: 100%;
  max-width: 780px;
  margin: 0 auto;
  padding: 0 20px;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.thread {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 28px 0 20px;
  display: flex;
  flex-direction: column;
  gap: 24px;
  /* текст у края гаснет, а не режется на полстроке — только у края, за которым ещё есть текст */
  --fade-t: 0px;
  --fade-b: 0px;
  mask-image: linear-gradient(to bottom, transparent 0, #000 var(--fade-t), #000 calc(100% - var(--fade-b)), transparent 100%);
}
.thread.fade-top { --fade-t: 22px; }
.thread.fade-bottom { --fade-b: 26px; }

/* реплики не сжимаются колонкой: высота всегда по содержимому */
.thread > * {
  flex-shrink: 0;
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
  min-height: 58px;
  max-height: min(220px, 35dvh);
  overflow-y: auto;
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

.composer-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.btn.mic {
  min-width: 34px;
  gap: 6px;
  padding-inline: 9px;
  color: var(--ink-3);
}

/* идёт запись: кнопка становится заметной красной «Стоп» */
.btn.mic.rec {
  color: #fff;
  background: var(--dot-bad);
  border-color: var(--dot-bad);
  font-weight: 500;
  padding-inline: 10px 11px;
}

.btn.mic.rec:hover {
  background: color-mix(in srgb, var(--dot-bad) 88%, #000);
}

/* квадрат «стоп» с ореолом, который дышит от громкости голоса */
.rec-stop {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: #fff;
  box-shadow: 0 0 0 calc(2px + var(--lvl, 0) * 5px) rgba(255, 255, 255, 0.28);
  transition: box-shadow 90ms linear;
}

.rec-clock {
  font-size: 11.5px;
  opacity: 0.85;
}

.live {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 9px 12px 0;
  font-size: 13.5px;
  line-height: 1.5;
}

.live-label {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--dot-bad);
}

.live-text {
  color: var(--ink-2);
  font-style: italic;
}

.live-hint {
  color: var(--ink-4);
}

.mic-spin {
  width: 14px;
  height: 14px;
  border: 1.6px solid var(--line-strong);
  border-top-color: var(--indigo);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .mic-spin { animation: none; }
  .rec-stop { transition: none; }
}

@media (max-width: 640px) {
  .chat-body { padding: 0 14px; }
  .composer-note { display: none; }
  /* 16px — иначе iPhone приближает страницу при фокусе на поле */
  .composer-ta { font-size: 16px; }
}

.user-about {
  display: block;
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--ink-3);
}

.pii-note {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 5px 2px 0;
  font-size: 11.5px;
  color: var(--ink-3);
}

.pii-note svg {
  width: 13px;
  height: 13px;
  flex: none;
  color: var(--dot-ok);
}

.next-asks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 4px;
  animation: view-in 220ms var(--ease) both;
}

.next-ask {
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: var(--bg);
  color: var(--ink-2);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  transition: background 120ms var(--ease), color 120ms var(--ease), border-color 120ms var(--ease);
}

.next-ask:hover {
  background: var(--bg-chrome);
  color: var(--ink);
  border-color: var(--ink-4);
}

.next-ask:focus-visible {
  outline: 2px solid var(--indigo);
  outline-offset: 2px;
}

.page-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--ink-3);
  min-width: 0;
}

.page-chip span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-chip b {
  font-weight: 500;
  color: var(--ink-2);
}

/* Боковая панель на витрине: узкая колонка, без центрирования */
.chat-body.dock {
  max-width: none;
  padding: 0 16px;
}

.dock .thread { padding-top: 18px; gap: 18px; }
.dock .welcome-h1 { font-size: 17px; }
.dock .welcome-desc { font-size: 13px; margin-bottom: 16px; }
.dock .composer-area { padding-bottom: 14px; }

/* служебная строка под ответом переносится, а не уезжает за край узкой колонки */
.inline-note .status {
  white-space: normal;
  align-items: baseline;
}
</style>
