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
const error = ref('')
const conversationId = ref<string | null>(null)
const list = ref<HTMLElement | null>(null)
let poll: ReturnType<typeof setInterval> | null = null
let pollUntil = 0

const starters = [
  'Не знаю, что нужно. Надо защитить почту и файлы на 50 сотрудников',
  'Сколько стоит Kaspersky Endpoint Security на 25 компьютеров?',
  'Есть российский аналог Microsoft Office?',
  'Как получить закрывающие документы и счёт на юрлицо?',
]

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

/** После передачи менеджеру или черновика КП ждём ответа менеджера в этом же чате. */
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
function stopPolling() { if (poll) clearInterval(poll); poll = null }

async function send(q?: string) {
  const value = (q ?? text.value).trim()
  if (!value || busy.value) return
  error.value = ''
  messages.value.push({ role: 'user', content: value })
  text.value = ''
  busy.value = true
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
    scrollDown()
  }
}

function restart() {
  stopPolling()
  messages.value = []
  conversationId.value = null
  store(null)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
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
onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="chat">
    <header class="top">
      <div>
        <div class="brand">{{ shopName }}</div>
        <div class="muted small">Помощник подберёт лицензии, посчитает цену и подготовит КП. Цены — из каталога, КП проверяет менеджер.</div>
      </div>
      <button v-if="messages.length" class="btn small" @click="restart">Новый диалог</button>
    </header>

    <main ref="list" class="list" aria-live="polite">
      <div v-if="!messages.length" class="empty">
        <p class="muted">С чего начать:</p>
        <div class="starters">
          <button v-for="s in starters" :key="s" class="btn starter" @click="send(s)">{{ s }}</button>
        </div>
      </div>

      <div v-for="(m, i) in messages" :key="i" class="row" :class="m.role">
        <div class="who" v-if="m.role !== 'user'">{{ m.role === 'manager' ? 'Менеджер' : 'Помощник' }}</div>
        <div class="bubble">
          <div v-if="m.role === 'user'" class="plain">{{ m.content }}</div>
          <div v-else class="md" v-html="renderMd(m.content)" />

          <div v-for="d in m.drafts" :key="d.id" class="draft">
            <span class="chip accent">{{ d.kind === 'proposal' ? 'КП' : 'Счёт' }} {{ d.number }}</span>
            <span class="num">{{ d.total }}</span>
            <span class="muted small">черновик — на проверке у менеджера, пришлём на почту</span>
          </div>
          <div v-if="m.escalated" class="handoff small">Передал вопрос менеджеру. Ответ появится здесь же.</div>
          <div v-if="m.sources?.length" class="sources small">
            <span class="muted">Источники:</span>
            <span v-for="s in uniqSources(m.sources)" :key="s.slug" class="chip">{{ s.title }}</span>
          </div>
        </div>
      </div>

      <div v-if="busy" class="row assistant">
        <div class="who">Помощник</div>
        <div class="bubble typing"><span /><span /><span /><em class="muted small">ищет в каталоге и базе знаний…</em></div>
      </div>
    </main>

    <footer class="composer">
      <p v-if="error" class="err small">{{ error }}</p>
      <div class="inputrow">
        <textarea
          v-model="text" class="field" rows="2" maxlength="4000" :disabled="busy"
          placeholder="Напишите вопрос: что нужно, на сколько сотрудников…" aria-label="Сообщение" @keydown="onKey"
        />
        <button class="btn primary" :disabled="busy || !text.trim()" @click="send()">Отправить</button>
      </div>
      <p class="muted tiny">Персональные данные маскируются перед отправкой модели. <NuxtLink to="/manager">Панель менеджера</NuxtLink></p>
    </footer>
  </div>
</template>

<style scoped>
.chat { max-width: 820px; margin: 0 auto; height: 100dvh; display: flex; flex-direction: column; padding: 0 16px; }
.top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 16px 0 12px; border-bottom: 1px solid var(--line); }
.brand { font-weight: 600; font-size: 17px; }
.small { font-size: 13px; }
.tiny { font-size: 12px; margin: 6px 0 0; }
.list { flex: 1; overflow-y: auto; padding: 16px 0; display: flex; flex-direction: column; gap: 14px; }
.empty { margin: auto 0; }
.starters { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; }
.starter { white-space: normal; text-align: left; justify-content: flex-start; padding: 10px 14px; }
.row { display: flex; flex-direction: column; max-width: 88%; }
.row.user { align-self: flex-end; align-items: flex-end; }
.who { font-size: 12px; color: var(--muted); margin: 0 0 3px 4px; }
.bubble { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px; overflow-wrap: anywhere; }
.user .bubble { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.manager .bubble { border-color: var(--ok); background: var(--ok-soft); }
.plain { white-space: pre-wrap; }
.draft { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); }
.handoff { margin-top: 8px; color: var(--warn); }
.sources { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 10px; }
.typing { display: flex; align-items: center; gap: 5px; }
.typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: blink 1.2s infinite; }
.typing span:nth-child(2) { animation-delay: .2s; }
.typing span:nth-child(3) { animation-delay: .4s; }
.typing em { margin-left: 6px; font-style: normal; }
@keyframes blink { 0%, 80%, 100% { opacity: .25 } 40% { opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .typing span { animation: none; opacity: .6; } }
.composer { padding: 10px 0 14px; border-top: 1px solid var(--line); }
.inputrow { display: flex; gap: 8px; align-items: flex-end; }
.inputrow textarea { resize: none; }
.err { color: var(--bad); margin: 0 0 6px; }
@media (max-width: 560px) { .row { max-width: 100%; } .inputrow { flex-direction: column; align-items: stretch; } }
</style>
