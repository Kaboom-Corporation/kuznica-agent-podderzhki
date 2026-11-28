<script setup lang="ts">
import { qtyUnit, renderMd, rub } from '~/utils/md'
import GuideTour from '~/components/GuideTour.vue'
import { TOUR_MANAGER } from '~/utils/tour'

interface Row { id: string; channel: string; status: string; subject: string | null; customer_company: string | null; updated_at: string; last_question: string | null; draft_proposals: number; open_escalations: number; cost_rub: string }
interface Item { sku: string; name: string; unit: string; qty: number; unit_cents: string; discount_pct: number; sum_cents: string }
interface Proposal { id: string; number: string; status: string; customer: any; items: Item[]; subtotal_cents: string; discount_cents: string; total_cents: string; vat_cents: string; notes: string | null; valid_until: string | null }
interface Escalation { id: number; kind: string; question: string; reason: string; resolved: boolean; created_at: string }
interface Run { id: number; model: string; steps: number; input_tokens: number; output_tokens: number; cost_rub: string; duration_ms: number; tools: any; escalated: boolean; verify_issues: any[]; created_at: string }
interface Card { conversation: any; messages: { id: number; role: string; content: string; created_at: string }[]; proposals: Proposal[]; invoices: any[]; escalations: Escalation[]; runs: Run[] }
interface Stats { days: number; totals: { conversations: number; runs: number; escalated_runs: number; cost_rub: string; avg_cost_rub: string; median_ms: number; verify_issues: number }; closed?: { total: number; by_agent: number; with_proposal: number } | null; byModel: { model: string; runs: number; cost_rub: string }[]; proposals: { status: string; n: number; total_cents: string }[]; gaps: (Escalation & { conversation_id: string })[]; learned?: { slug: string; title: string; updated_at: string }[] }

const TOKEN_KEY = 'manager-token'
const token = ref('')
const tokenInput = ref('')
const authError = ref('')
const tab = ref<'queue' | 'stats'>('queue')
const tour = ref<InstanceType<typeof GuideTour> | null>(null)
const filter = ref<'' | 'waiting_manager'>('waiting_manager')
const rows = ref<Row[]>([])
const card = ref<Card | null>(null)
const selected = ref<string | null>(null)
const stats = ref<Stats | null>(null)
const days = ref(7)
const reply = ref('')
const email = ref('')
const proposalNote = ref('')
const remember = ref(false)
const busy = ref(false)
const notice = ref('')
const forgetting = ref('')
const refreshingFeed = ref(false)
const feedNotice = ref('')
const pdfUrl = ref('')
const pdfTitle = ref('Черновик КП — на проверку менеджеру')
const pdfDialog = ref<HTMLDialogElement | null>(null)

const KIND: Record<string, [string, string]> = {
  needs_human: ['Нужен менеджер', 'warn'],
  no_answer: ['Нет ответа в базе', 'warn'],
  low_confidence: ['Агент не уверен', 'warn'],
  verify_failed: ['Сверка цифр не прошла', 'bad'],
  proposal: ['КП на проверку', 'accent'],
  invoice: ['Счёт на проверку', 'accent'],
  gateway: ['Модель недоступна', 'bad'],
  ollama: ['Модель недоступна', 'bad'],
}
const STATUS: Record<string, [string, string]> = {
  draft: ['Черновик', 'warn'],
  approved: ['Проверено', 'ok'],
  sent: ['Отправлено', 'ok'],
  rejected: ['Отклонено', 'bad'],
  waiting_manager: ['Ждёт менеджера', 'warn'],
  open: ['Открыто', 'ok'],
  closed: ['Закрыто', ''],
}
const ROLE: Record<string, string> = { user: 'Клиент', assistant: 'Консультант', manager: 'Менеджер', tool: 'Инструмент', system: 'Система' }

const headers = computed(() => ({ authorization: `Bearer ${token.value}` }))
const waitingCount = computed(() => rows.value.filter(r => r.status === 'waiting_manager').length)
const cardTotalCost = computed(() => card.value ? card.value.runs.reduce((s, r) => s + Number(r.cost_rub), 0) : 0)
const cardVerifyIssues = computed(() => card.value ? card.value.runs.reduce((s, r) => s + (r.verify_issues?.length || 0), 0) : 0)
const cardLastModel = computed(() => card.value?.runs.at(-1)?.model || '')

async function api<T>(url: string, opts: any = {}): Promise<T> {
  try {
    return await $fetch<T>(url, { ...opts, headers: { ...headers.value, ...(opts.headers || {}) } })
  } catch (e: any) {
    if (e?.statusCode === 401 || e?.statusCode === 503) {
      authError.value = e?.data?.statusMessage || e?.statusMessage || 'Нужен токен менеджера'
      token.value = ''
      try { sessionStorage.removeItem(TOKEN_KEY) } catch {}
    }
    throw e
  }
}

function login() {
  token.value = tokenInput.value.trim()
  tokenInput.value = ''
  authError.value = ''
  try { sessionStorage.setItem(TOKEN_KEY, token.value) } catch {}
  refresh()
}

function logout() {
  token.value = ''
  rows.value = []
  card.value = null
  selected.value = null
  stats.value = null
  try { sessionStorage.removeItem(TOKEN_KEY) } catch {}
}

async function loadRows() {
  rows.value = await api<Row[]>(`/api/manager/conversations${filter.value ? `?status=${filter.value}` : ''}`)
}

async function open(id: string) {
  const other = selected.value !== id
  selected.value = id
  notice.value = ''
  card.value = await api<Card>(`/api/manager/conversations/${id}`)
  email.value = card.value.conversation?.customer_email || ''
  proposalNote.value = ''
  // Рабочая область листается сама по себе: другое обращение открываем с начала
  if (other) nextTick(() => document.querySelector('.inbox > .workspace')?.scrollTo({ top: 0 }))
}

async function loadStats() {
  stats.value = await api<Stats>(`/api/manager/stats?days=${days.value}`)
}

let kbLoaded = false

async function refresh() {
  if (!token.value) return
  try {
    if (tab.value === 'queue') {
      await loadRows()
      if (selected.value) await open(selected.value)
    } else {
      await loadStats()
      // Список статей — при первом заходе на вкладку и после правок, не каждые 10 секунд
      if (!kbLoaded) { await loadKb(); kbLoaded = true }
    }
  } catch {}
}

async function act(fn: () => Promise<string>) {
  busy.value = true
  notice.value = ''
  try { notice.value = await fn() } catch (e: any) { notice.value = e?.data?.statusMessage || e?.statusMessage || 'Не получилось' }
  finally {
    busy.value = false
    try { await loadRows(); if (selected.value) await open(selected.value) } catch {}
  }
}

const approve = (p: Proposal) => act(async () => {
  const r = await api<{ number: string; status: string; mail: string; error: string | null }>(`/api/manager/proposals/${p.id}/approve`, {
    method: 'POST',
    body: {
      email: email.value.trim() || undefined,
      note: proposalNote.value.trim() || undefined,
    },
  })
  proposalNote.value = ''
  return r.mail === 'sent'
    ? `КП ${r.number} проверено и отправлено клиенту`
    : `КП ${r.number} проверено${r.error ? ` (письмо не ушло: ${r.error})` : ', письмо сохранено в журнале'}`
})

const reject = (p: Proposal) => act(async () => {
  const r = await api<{ number: string }>(`/api/manager/proposals/${p.id}/reject`, { method: 'POST' })
  return `КП ${r.number} отклонено, клиенту ничего не ушло`
})

const resolve = (e: Escalation) => act(async () => {
  await api(`/api/manager/escalations/${e.id}/resolve`, { method: 'POST' })
  return 'Эскалация закрыта'
})

const sendReply = () => act(async () => {
  const r = await api<{ learned: { title: string } | null }>(`/api/manager/conversations/${selected.value}/reply`, {
    method: 'POST',
    body: { text: reply.value, remember: remember.value },
  })
  reply.value = ''
  remember.value = false
  return r.learned
    ? 'Ответ отправлен и добавлен в базу знаний'
    : 'Ответ отправлен в чат клиента'
})

async function forget(slug: string) {
  forgetting.value = slug
  try {
    await api(`/api/manager/learned/${slug}`, { method: 'DELETE' })
    await Promise.all([loadStats(), loadKb()])
  } catch {}
  finally { forgetting.value = '' }
}

async function refreshFeed() {
  if (refreshingFeed.value) return
  refreshingFeed.value = true
  feedNotice.value = ''
  try {
    const r = await api<{ ok: boolean; result?: any }>('/api/manager/feed/refresh', { method: 'POST' })
    feedNotice.value = typeof r.result === 'string' ? r.result : 'Каталог обновлён из фида'
  } catch (e: any) {
    feedNotice.value = e?.data?.statusMessage || e?.statusMessage || 'Не удалось обновить фид'
  } finally {
    refreshingFeed.value = false
  }
}

async function showPdf(p: Proposal) {
  try {
    const blob = await api<Blob>(`/api/manager/proposals/${p.id}/pdf`, { responseType: 'blob' })
    if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value)
    pdfUrl.value = URL.createObjectURL(blob)
    pdfTitle.value = `${p.number.startsWith('КП') ? p.number : `КП ${p.number}`} · Черновик`
    pdfDialog.value?.showModal()
  } catch (e: any) {
    notice.value = e?.data?.statusMessage || 'PDF не открылся'
  }
}

function onDialogBackdropClick(e: MouseEvent) {
  if (e.target === pdfDialog.value) pdfDialog.value?.close()
}

// База знаний: список статей и правка в окне. Сохранение режет текст на куски и пересчитывает поиск.
interface KbItem { id: number; slug: string; title: string; kind: 'store' | 'panel' | 'learned'; chunks: number; updated_at: string }
const KB_KIND: Record<KbItem['kind'], string> = { store: 'база магазина', panel: 'правка менеджера', learned: 'из ответа менеджера' }
const kb = ref<KbItem[]>([])
const kbQuery = ref('')
const kbDialog = ref<HTMLDialogElement | null>(null)
const kbEdit = ref<{ id: number | null; title: string; content: string; kind: KbItem['kind'] | null }>({ id: null, title: '', content: '', kind: null })
const kbBusy = ref(false)
const kbNotice = ref('')
const kbFiltered = computed(() => {
  const s = kbQuery.value.trim().toLowerCase()
  return s ? kb.value.filter(d => d.title.toLowerCase().includes(s)) : kb.value
})

async function loadKb() {
  kb.value = await api<KbItem[]>('/api/manager/kb')
}

async function editKb(id: number | null) {
  kbNotice.value = ''
  if (id == null) kbEdit.value = { id: null, title: '', content: '', kind: null }
  else {
    const d = await api<{ id: number; title: string; content: string; kind: KbItem['kind'] }>(`/api/manager/kb/${id}`)
    kbEdit.value = { id: d.id, title: d.title, content: d.content, kind: d.kind }
  }
  kbDialog.value?.showModal()
}

async function saveKbDoc() {
  kbBusy.value = true
  kbNotice.value = ''
  try {
    const { id, title, content } = kbEdit.value
    const r = await api<{ id: number; chunks: number }>(id == null ? '/api/manager/kb' : `/api/manager/kb/${id}`, {
      method: id == null ? 'POST' : 'PUT',
      body: { title, content },
    })
    kbDialog.value?.close()
    kbNotice.value = `Сохранено: ${r.chunks} ${r.chunks === 1 ? 'фрагмент' : 'фрагмента(ов)'} в поиске. Агент учтёт со следующего вопроса.`
    await Promise.all([loadKb(), loadStats()])
  }
  catch (e: any) {
    kbNotice.value = e?.data?.statusMessage || e?.statusMessage || 'Не сохранилось'
  }
  finally { kbBusy.value = false }
}

async function deleteKbDoc() {
  const { id, kind } = kbEdit.value
  if (id == null) return
  kbBusy.value = true
  try {
    await api(`/api/manager/kb/${id}`, { method: 'DELETE' })
    kbDialog.value?.close()
    kbNotice.value = kind === 'store' ? 'Статья удалена. Вернётся при следующей загрузке базы магазина.' : 'Статья удалена'
    await Promise.all([loadKb(), loadStats()])
  }
  catch (e: any) {
    kbNotice.value = e?.data?.statusMessage || 'Не удалилось'
  }
  finally { kbBusy.value = false }
}

function onKbBackdropClick(e: MouseEvent) {
  if (e.target === kbDialog.value && !kbBusy.value) kbDialog.value?.close()
}

const rowDot = (r: Row) => r.open_escalations ? 'bad' : r.draft_proposals ? 'warn' : r.status === 'open' ? 'ok' : ''
const toolsOf = (r: Run) => (Array.isArray(r.tools) ? r.tools : []).map((t: any) => (typeof t === 'string' ? t : t?.name)).filter(Boolean).join(', ')
const time = (s: string) => new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const fmtRub = (s: string | number) => Number(s).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽'
const selfShare = computed(() => {
  const t = stats.value?.totals
  if (!t?.runs) return '—'
  return Math.round(100 * (1 - t.escalated_runs / t.runs)) + '%'
})
const closedShare = computed(() => {
  const c = stats.value?.closed
  if (!c?.total) return '—'
  return Math.round(100 * c.by_agent / c.total) + '%'
})

watch(filter, refresh)
watch(tab, refresh)
watch(days, refresh)

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  try { token.value = sessionStorage.getItem(TOKEN_KEY) || '' } catch {}
  refresh()
  timer = setInterval(refresh, 10_000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value)
})
</script>

<template>
  <div class="mgr-page">
    <!-- Linear 48px Header with Underline Tabs -->
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand-group">
          <div class="brand-mark" aria-hidden="true">ДС</div>
          <span class="brand-name hide-narrow">Демо Софт</span>
          <span class="crumb-sep hide-narrow">/</span>
          <span class="muted hide-narrow" style="font-size:13px">Менеджер</span>

          <nav v-if="token" class="view-tabs" aria-label="Разделы">
            <button class="view-tab" :aria-pressed="tab === 'queue'" @click="tab = 'queue'">
              <span>Очередь</span>
              <span v-if="waitingCount" class="tab-count">{{ waitingCount }}</span>
            </button>
            <button class="view-tab" :aria-pressed="tab === 'stats'" @click="tab = 'stats'">
              Сводка и БЗ
            </button>
          </nav>
        </div>

        <div class="topbar-right">
          <button class="btn ghost sm hide-narrow" @click="tour?.start()">Как это устроено</button>
          <NuxtLink to="/" class="btn ghost sm">Чат клиента</NuxtLink>
          <button v-if="token" class="btn ghost sm" @click="logout">Выйти</button>
        </div>
      </div>
    </header>

    <!-- Login -->
    <main v-if="!token" class="login-wrap">
      <form class="login-box" @submit.prevent="login">
        <h1 class="login-h1">Вход в панель менеджера</h1>
        <p class="login-desc">Укажите токен доступа (<code>NUXT_MANAGER_TOKEN</code>).</p>
        <input
          id="tok"
          v-model="tokenInput"
          class="field"
          type="password"
          autocomplete="current-password"
          placeholder="Токен менеджера"
          aria-label="Токен менеджера"
        />
        <button class="btn primary" style="width:100%; margin-top:4px" :disabled="!tokenInput.trim()">Войти</button>
        <p v-if="authError" class="err-text" role="alert">{{ authError }}</p>
      </form>
    </main>

    <!-- Linear Split-View Inbox -->
    <div v-else-if="tab === 'queue'" class="inbox">
      <!-- Left List (#F7F8F9) -->
      <aside class="inbox-list">
        <div class="inbox-bar">
          <div class="filter-links">
            <button class="filter-btn" :aria-pressed="filter === 'waiting_manager'" @click="filter = 'waiting_manager'">Ждут</button>
            <button class="filter-btn" :aria-pressed="filter === ''" @click="filter = ''">Все</button>
          </div>
          <button class="btn ghost sm" @click="refresh">Обновить</button>
        </div>

        <p v-if="!rows.length" class="empty-note">Очередь пуста</p>

        <ul v-else role="list" class="issue-list">
          <li v-for="r in rows" :key="r.id">
            <button class="issue-row" :class="{ active: r.id === selected }" @click="open(r.id)">
              <span class="status-dot issue-dot" :class="rowDot(r)" aria-hidden="true" />
              <div class="issue-main">
                <div class="issue-top">
                  <span class="issue-title">{{ r.customer_company || r.subject || (r.channel === 'email' ? 'Почта' : r.channel === 'telegram' ? 'Telegram' : 'Веб-чат') }}</span>
                  <span class="issue-time num">{{ time(r.updated_at) }}</span>
                </div>
                <p class="issue-preview">{{ r.last_question || r.subject || 'Без текста' }}</p>
                <div class="issue-sub">
                  <span v-if="r.draft_proposals">КП: {{ r.draft_proposals }}</span>
                  <span v-if="r.open_escalations">Эскалация</span>
                  <span>{{ r.channel === 'email' ? 'почта' : r.channel === 'telegram' ? 'Telegram' : 'чат' }}</span>
                  <span class="num">{{ fmtRub(r.cost_rub) }}</span>
                </div>
              </div>
            </button>
          </li>
        </ul>
      </aside>

      <!-- Right Workspace (#FFFFFF) -->
      <main v-if="card" class="workspace">
        <!-- Linear 44px Sub-header with Quiet Metadata (zero badges) -->
        <div class="ws-bar">
          <div class="ws-bar-left">
            <span class="status">
              <span class="status-dot" :class="STATUS[card.conversation.status]?.[1]" aria-hidden="true" />
              <span>{{ STATUS[card.conversation.status]?.[0] || card.conversation.status }}</span>
            </span>
            <span class="crumb-sep">·</span>
            <span class="muted">{{ card.conversation.customer_company || 'Компания не указана' }}</span>
          </div>
          <div class="ws-bar-right">
            <span v-if="card.runs.length" class="status">
              <span class="status-dot" :class="cardVerifyIssues ? 'bad' : 'ok'" aria-hidden="true" />
              <span>{{ cardVerifyIssues ? `Сверка: ${cardVerifyIssues} расхожд.` : 'Цифры сверены' }}</span>
            </span>
            <span v-if="cardLastModel" class="mono muted">{{ cardLastModel }}</span>
            <span class="mono muted">{{ fmtRub(cardTotalCost) }}</span>
          </div>
        </div>

        <div class="ws-content">
          <h1 class="ws-title">
            {{ card.conversation.subject || card.messages.find(m => m.role === 'user')?.content?.slice(0, 88) || 'Обращение' }}
          </h1>

          <p v-if="notice" class="ws-notice" role="status">{{ notice }}</p>

          <!-- Open Escalations (Quiet hairline rows) -->
          <div v-for="e in card.escalations.filter(x => !x.resolved)" :key="e.id" class="esc-row">
            <div class="esc-left">
              <span class="status">
                <span class="status-dot" :class="KIND[e.kind]?.[1]" aria-hidden="true" />
                <strong>{{ KIND[e.kind]?.[0] || e.kind }}</strong>
              </span>
              <span class="esc-reason">{{ e.reason }}</span>
            </div>
            <button class="btn sm" :disabled="busy" @click="resolve(e)">Закрыть</button>
          </div>

          <!-- Stripe-style Proposal Card -->
          <section v-for="p in card.proposals" :key="p.id" class="doc-card">
            <div class="doc-head">
              <div class="doc-id">
                <strong class="mono">{{ p.number.startsWith('КП') ? p.number : `КП ${p.number}` }}</strong>
                <span class="status">
                  <span class="status-dot" :class="STATUS[p.status]?.[1]" aria-hidden="true" />
                  <span>{{ STATUS[p.status]?.[0] || p.status }}</span>
                </span>
                <span v-if="p.valid_until" class="muted" style="font-size:12px">до {{ p.valid_until }}</span>
              </div>
              <div class="doc-sum">
                <span class="num doc-total">{{ rub(p.total_cents) }}</span>
                <span class="muted" style="font-size:11.5px">вкл. НДС {{ rub(p.vat_cents) }}</span>
              </div>
            </div>

            <div class="table-wrap">
              <table class="tbl">
                <thead>
                  <tr>
                    <th>Позиция</th>
                    <th class="r">Кол-во</th>
                    <th class="r">Цена</th>
                    <th class="r">Скидка</th>
                    <th class="r">Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="i in p.items" :key="i.sku">
                    <td>
                      <div class="tbl-name">{{ i.name }}</div>
                      <div class="mono muted" style="font-size:11.5px">{{ i.sku }}</div>
                    </td>
                    <td class="r num">{{ qtyUnit(i.qty, i.unit) }}</td>
                    <td class="r num">{{ rub(i.unit_cents) }}</td>
                    <td class="r num">{{ i.discount_pct ? `${i.discount_pct}%` : '—' }}</td>
                    <td class="r num tbl-strong">{{ rub(i.sum_cents) }}</td>
                  </tr>
                </tbody>
                <tfoot v-if="Number(p.discount_cents)">
                  <tr>
                    <td colspan="4" class="r muted">Скидка</td>
                    <td class="r num">−{{ rub(p.discount_cents) }}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <p v-if="p.notes" class="doc-note">{{ p.notes }}</p>

            <div class="doc-foot">
              <button class="btn sm" @click="showPdf(p)">Открыть PDF</button>
              <template v-if="p.status === 'draft'">
                <input v-model="email" class="field doc-input" type="email" placeholder="Email клиента" aria-label="Почта клиента" />
                <input v-model="proposalNote" class="field doc-input-note" type="text" placeholder="Комментарий к письму" aria-label="Комментарий" />
                <div class="doc-btns">
                  <button class="btn danger sm" :disabled="busy" @click="reject(p)">Отклонить</button>
                  <button class="btn primary sm" :disabled="busy" @click="approve(p)">Подтвердить и отправить</button>
                </div>
              </template>
            </div>
          </section>

          <!-- Conversation History -->
          <section class="ws-section">
            <h2 class="sec-h">Переписка</h2>
            <div class="msg-list">
              <div
                v-for="m in card.messages.filter(x => ['user', 'assistant', 'manager'].includes(x.role))"
                :key="m.id"
                class="msg-item"
                :class="m.role"
              >
                <div class="msg-meta">
                  <span class="msg-author">{{ ROLE[m.role] || m.role }}</span>
                  <span class="mono muted" style="font-size:11.5px">{{ time(m.created_at) }}</span>
                </div>
                <div class="md" v-html="renderMd(m.content)" />
              </div>
            </div>
          </section>

          <!-- Linear Issue Comment Composer -->
          <form class="comment-box" @submit.prevent="sendReply">
            <textarea
              v-model="reply"
              class="comment-ta"
              rows="3"
              maxlength="4000"
              placeholder="Напишите ответ клиенту — появится в его чате и закроет эскалации…"
              aria-label="Ответ клиенту"
            />
            <div class="comment-bar">
              <label class="remember-check">
                <input v-model="remember" type="checkbox" />
                <span>Запомнить ответ в базе знаний для следующих клиентов</span>
              </label>
              <button class="btn dark" :disabled="busy || !reply.trim()">Ответить</button>
            </div>
          </form>

          <!-- Technical Audit -->
          <details class="audit">
            <summary>
              <span>Запуски агента ({{ card.runs.length }})</span>
              <span class="mono muted">{{ fmtRub(cardTotalCost) }}</span>
            </summary>
            <div class="table-wrap" style="margin-top:10px">
              <table class="tbl">
                <thead>
                  <tr>
                    <th>Время</th>
                    <th>Модель</th>
                    <th>Инструменты</th>
                    <th class="r">Токены</th>
                    <th class="r">₽</th>
                    <th class="r" title="Время ответа в секундах">Сек</th>
                    <th style="white-space:nowrap">Сверка</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in card.runs" :key="r.id">
                    <td class="num muted" style="font-size:12px">{{ time(r.created_at) }}</td>
                    <td class="mono" style="font-size:12px">{{ r.model }}</td>
                    <td class="mono muted" style="font-size:12px">{{ toolsOf(r) || '—' }}</td>
                    <td class="r num" style="font-size:12px">{{ r.input_tokens }} / {{ r.output_tokens }}</td>
                    <td class="r num" style="font-size:12px">{{ Number(r.cost_rub).toFixed(2) }}</td>
                    <td class="r num" style="font-size:12px">{{ (r.duration_ms / 1000).toFixed(1) }}</td>
                    <td style="white-space:nowrap">
                      <span class="status">
                        <span class="status-dot" :class="r.verify_issues?.length ? 'bad' : 'ok'" aria-hidden="true" />
                        <span>{{ r.verify_issues?.length ? `${r.verify_issues.length} расхожд.` : 'ОК' }}</span>
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </main>

      <main v-else class="ws-empty">
        <span class="muted">Выберите обращение в списке</span>
      </main>
    </div>

    <!-- Stripe-style Stats & KB View -->
    <main v-else-if="stats" class="stats-wrap">
      <div class="stats-top">
        <div>
          <h1 class="stats-h1">Сводка и база знаний</h1>
          <p class="muted" style="margin:2px 0 0; font-size:12.5px">Экономика, сверка цифр и обучение агента</p>
        </div>
        <div class="stats-actions">
          <button class="btn sm" :disabled="refreshingFeed" @click="refreshFeed">
            {{ refreshingFeed ? 'Обновляю фид…' : 'Обновить каталог из фида' }}
          </button>
          <div class="filter-links">
            <button v-for="d in [1, 7, 30]" :key="d" class="filter-btn" :aria-pressed="days === d" @click="days = d">
              {{ d === 1 ? 'Сутки' : `${d} дней` }}
            </button>
          </div>
        </div>
      </div>

      <p v-if="feedNotice" class="ws-notice" role="status">{{ feedNotice }}</p>

      <!-- Shared-Border Metric Strip -->
      <dl class="metrics">
        <div class="metric">
          <dt>Обращений</dt>
          <dd class="metric-val num">{{ stats.totals.conversations }}</dd>
          <dd class="metric-sub">{{ stats.totals.runs }} запусков</dd>
        </div>
        <div v-if="stats.closed" class="metric" title="Обращение обошлось без менеджера: ни передачи, ни ответа человека, ни отклонённого КП. КП, которое менеджер подтвердил одной кнопкой, тоже считается закрытым агентом">
          <dt>Закрыто агентом</dt>
          <dd class="metric-val num">{{ closedShare }}</dd>
          <dd class="metric-sub">{{ stats.closed.by_agent }} из {{ stats.closed.total }}, с КП: {{ stats.closed.with_proposal }}</dd>
        </div>
        <div class="metric">
          <dt>Без менеджера</dt>
          <dd class="metric-val num">{{ selfShare }}</dd>
          <dd class="metric-sub">{{ stats.totals.runs - stats.totals.escalated_runs }} из {{ stats.totals.runs }}</dd>
        </div>
        <div class="metric">
          <dt>Цена обращения</dt>
          <dd class="metric-val num">{{ fmtRub(stats.totals.avg_cost_rub) }}</dd>
          <dd class="metric-sub">всего {{ fmtRub(stats.totals.cost_rub) }}</dd>
        </div>
        <div class="metric">
          <dt>Медиана ответа</dt>
          <dd class="metric-val num">{{ (stats.totals.median_ms / 1000).toFixed(1) }} с</dd>
          <dd class="metric-sub">с поиском по каталогу</dd>
        </div>
        <div class="metric">
          <dt>Ошибки сверки</dt>
          <dd class="metric-val num">{{ stats.totals.verify_issues }}</dd>
          <dd class="metric-sub">уходят менеджеру</dd>
        </div>
      </dl>

      <div class="stats-grid">
        <section class="stats-sec">
          <h2 class="sec-h">КП за период</h2>
          <p v-if="!stats.proposals.length" class="muted" style="font-size:13px">Пока нет</p>
          <ul v-else class="line-list">
            <li v-for="p in stats.proposals" :key="p.status" class="line-row">
              <span class="status">
                <span class="status-dot" :class="STATUS[p.status]?.[1]" aria-hidden="true" />
                <span>{{ STATUS[p.status]?.[0] || p.status }}</span>
              </span>
              <span class="num">{{ p.n }} шт. · {{ rub(p.total_cents) }}</span>
            </li>
          </ul>
        </section>

        <section class="stats-sec">
          <h2 class="sec-h">Модели</h2>
          <p v-if="!stats.byModel.length" class="muted" style="font-size:13px">Пока нет</p>
          <ul v-else class="line-list">
            <li v-for="m in stats.byModel" :key="m.model" class="line-row">
              <span class="mono" style="font-size:12.5px">{{ m.model }}</span>
              <span class="num muted" style="font-size:12.5px">{{ m.runs }} · {{ fmtRub(m.cost_rub) }}</span>
            </li>
          </ul>
        </section>
      </div>

      <section class="stats-sec">
        <h2 class="sec-h">Агент научился на ответах менеджера</h2>
        <p v-if="!stats.learned?.length" class="muted" style="font-size:13px">
          Пока нет. Отметьте «Запомнить ответ в базе знаний» при ответе клиенту.
        </p>
        <ul v-else class="line-list">
          <li v-for="l in stats.learned" :key="l.slug" class="line-row">
            <div class="line-left">
              <span class="status-dot ok" aria-hidden="true" />
              <span>{{ l.title.replace(/^Ответ менеджера: /, '') }}</span>
            </div>
            <div class="line-right">
              <span class="num muted" style="font-size:12px">{{ time(l.updated_at) }}</span>
              <button class="btn ghost sm" :disabled="forgetting === l.slug" @click="forget(l.slug)">Забыть</button>
            </div>
          </li>
        </ul>
      </section>

      <section class="stats-sec">
        <div class="kb-head">
          <h2 class="sec-h">База знаний · {{ kb.length }}</h2>
          <div class="kb-tools">
            <input v-model="kbQuery" class="field kb-search" type="search" placeholder="Найти статью" aria-label="Найти статью">
            <button class="btn sm" @click="editKb(null)">Новая статья</button>
          </div>
        </div>
        <p v-if="kbNotice" class="kb-notice" role="status">{{ kbNotice }}</p>
        <ul class="line-list kb-list">
          <li v-for="d in kbFiltered" :key="d.id" class="line-row">
            <div class="line-left">
              <span class="status-dot" :class="{ ok: d.kind !== 'store' }" aria-hidden="true" />
              <span>{{ d.title }}</span>
            </div>
            <div class="line-right">
              <span class="muted" style="font-size:12px">{{ KB_KIND[d.kind] }} · {{ d.chunks }} фр.</span>
              <button class="btn ghost sm" @click="editKb(d.id)">Изменить</button>
            </div>
          </li>
          <li v-if="!kbFiltered.length" class="muted" style="font-size:13px;padding:8px 0">Ничего не нашлось</li>
        </ul>
      </section>

      <section class="stats-sec">
        <h2 class="sec-h">Открытые эскалации и пробелы БЗ</h2>
        <p v-if="!stats.gaps.length" class="muted" style="font-size:13px">Нет открытых эскалаций</p>
        <ul v-else class="line-list">
          <li v-for="g in stats.gaps" :key="g.id" class="line-row">
            <div class="line-left">
              <span class="status-dot" :class="KIND[g.kind]?.[1]" aria-hidden="true" />
              <span>{{ g.question }}</span>
            </div>
            <button class="btn sm" @click="tab = 'queue'; open(g.conversation_id)">Открыть</button>
          </li>
        </ul>
      </section>
    </main>

    <!-- Native PDF Dialog -->
    <dialog ref="pdfDialog" class="pdf-dialog" aria-label="PDF коммерческого предложения" @click="onDialogBackdropClick">
      <div class="pdf-head">
        <span class="mono" style="font-size:12px">{{ pdfTitle }}</span>
        <button class="btn ghost sm" @click="pdfDialog?.close()">Закрыть</button>
      </div>
      <iframe v-if="pdfUrl" :src="pdfUrl" title="PDF КП" />
    </dialog>

    <dialog ref="kbDialog" class="pdf-dialog kb-dialog" aria-label="Статья базы знаний" @click="onKbBackdropClick">
      <form class="kb-form" @submit.prevent="saveKbDoc">
        <div class="pdf-head">
          <span style="font-size:13px;font-weight:600">{{ kbEdit.id == null ? 'Новая статья' : 'Правка статьи' }}</span>
          <button type="button" class="btn ghost sm" :disabled="kbBusy" @click="kbDialog?.close()">Закрыть</button>
        </div>
        <div class="kb-body">
          <label class="kb-label">Заголовок
            <input v-model="kbEdit.title" class="field" maxlength="200" required>
          </label>
          <label class="kb-label kb-grow">Текст · разделы с «## », агент находит ответ по разделу
            <textarea v-model="kbEdit.content" class="field kb-ta" maxlength="40000" required spellcheck="true" />
          </label>
          <p v-if="kbEdit.kind === 'store'" class="muted" style="font-size:12px;margin:0">
            Статья из базы магазина. После правки перезагрузка базы её не затрёт.
          </p>
          <p v-if="kbNotice && kbDialog?.open" class="kb-notice" role="alert">{{ kbNotice }}</p>
        </div>
        <div class="kb-foot">
          <button v-if="kbEdit.id != null" type="button" class="btn ghost sm kb-del" :disabled="kbBusy" @click="deleteKbDoc">Удалить</button>
          <span class="muted" style="font-size:12px;margin-left:auto">{{ kbEdit.content.length.toLocaleString('ru-RU') }} зн.</span>
          <button type="submit" class="btn dark" :disabled="kbBusy">{{ kbBusy ? 'Сохраняю…' : 'Сохранить' }}</button>
        </div>
      </form>
    </dialog>
    <GuideTour ref="tour" id="manager" :steps="TOUR_MANAGER" />
  </div>
</template>

<style scoped>
.mgr-page {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

/* Login */
.login-wrap {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--bg-chrome);
}

.login-box {
  width: 100%;
  max-width: 340px;
  padding: 24px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--bg);
  box-shadow: var(--shadow-card);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.login-h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.login-desc {
  margin: 0 0 4px;
  font-size: 12.5px;
  color: var(--ink-3);
}

.err-text {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: var(--dot-bad);
}

/* Linear Split-View Inbox */
.inbox {
  flex: 1;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  min-height: calc(100dvh - 48px);
}

.inbox-list {
  background: var(--bg-chrome);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
}

.inbox-bar {
  height: 44px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.filter-links {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.filter-btn {
  border: 0;
  background: transparent;
  padding: 4px 8px;
  border-radius: 5px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink-3);
  cursor: pointer;
}

.filter-btn:hover {
  color: var(--ink);
}

.filter-btn[aria-pressed='true'] {
  background: var(--bg-active);
  color: var(--ink);
}

.empty-note {
  padding: 24px 16px;
  margin: 0;
  font-size: 13px;
  color: var(--ink-3);
}

.issue-list {
  list-style: none;
  margin: 0;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.issue-row {
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 10px 10px;
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  transition: background 110ms var(--ease);
}

.issue-row:hover {
  background: var(--bg-hover);
}

.issue-row.active {
  background: var(--bg-active);
}

.issue-dot {
  margin-top: 6px;
}

.issue-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.issue-top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

.issue-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.issue-time {
  font-size: 11px;
  color: var(--ink-4);
}

.issue-preview {
  margin: 0;
  font-size: 12.5px;
  color: var(--ink-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.issue-sub {
  display: flex;
  gap: 8px;
  font-size: 11.5px;
  color: var(--ink-3);
}

/* Right Workspace */
.workspace {
  background: var(--bg);
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ws-empty {
  display: grid;
  place-items: center;
  min-height: 360px;
  font-size: 13.5px;
}

.ws-bar {
  height: 44px;
  padding: 0 28px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  font-size: 12.5px;
}

.ws-bar-left,
.ws-bar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.ws-content {
  max-width: 860px;
  width: 100%;
  padding: 24px 28px 40px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.ws-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.ws-notice {
  margin: 0;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--line-strong);
  background: var(--bg-chrome);
  font-size: 13px;
  color: var(--ink);
}

.esc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--bg-chrome);
  font-size: 13px;
}

.esc-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.esc-reason {
  color: var(--ink-2);
}

/* Stripe-style Proposal Card */
.doc-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
  box-shadow: var(--shadow-card);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.doc-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}

.doc-id {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.doc-sum {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.doc-total {
  font-size: 17px;
  font-weight: 600;
}

.table-wrap {
  overflow-x: auto;
}

.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.tbl th {
  text-align: left;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--ink-3);
  padding: 6px 8px 8px 0;
  border-bottom: 1px solid var(--line);
}

.tbl td {
  padding: 9px 8px 9px 0;
  border-bottom: 1px solid var(--line-soft);
  vertical-align: top;
}

.tbl tr:last-child td {
  border-bottom: 0;
}

.tbl .r {
  text-align: right;
  padding-right: 0;
  padding-left: 12px;
  white-space: nowrap;
}

/* Число по правому краю не должно прилипать к соседней колонке справа */
.tbl .r:not(:last-child) {
  padding-right: 20px;
}

.tbl-name {
  font-weight: 500;
}

.tbl-strong {
  font-weight: 600;
}

.doc-note {
  margin: 0;
  font-size: 12.5px;
  color: var(--ink-3);
}

.doc-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--line-soft);
}

.doc-input {
  width: 185px;
  height: 26px;
  padding: 2px 8px;
  font-size: 12px;
}

.doc-input-note {
  flex: 1;
  min-width: 140px;
  height: 26px;
  padding: 2px 8px;
  font-size: 12px;
}

.doc-btns {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

/* Conversation */
.ws-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sec-h {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-3);
  letter-spacing: 0.01em;
}

.msg-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.msg-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 12px;
  border-left: 2px solid var(--line-soft);
}

.msg-item.user {
  border-left-color: var(--line-strong);
}

.msg-item.manager {
  border-left-color: var(--dot-ok);
}

.msg-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.msg-author {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
}

/* Linear Comment Composer */
.comment-box {
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--bg);
  box-shadow: var(--shadow-card);
}

.comment-box:focus-within {
  border-color: var(--indigo);
}

.comment-ta {
  width: 100%;
  display: block;
  border: 0;
  background: transparent;
  resize: none;
  padding: 10px 12px 6px;
  font-size: 13.5px;
  line-height: 1.5;
  outline: none;
}

.comment-ta::placeholder {
  color: var(--ink-4);
}

.comment-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px 8px 12px;
  border-top: 1px solid var(--line-soft);
}

.remember-check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--ink-2);
  cursor: pointer;
}

.remember-check input {
  accent-color: var(--indigo);
}

/* Technical Audit */
.audit {
  border-top: 1px solid var(--line);
  padding-top: 14px;
}

.audit summary {
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink-3);
  list-style: none;
}

.audit summary::-webkit-details-marker {
  display: none;
}

.audit summary:hover {
  color: var(--ink);
}

/* Stats Page */
.stats-wrap {
  max-width: 980px;
  width: 100%;
  margin: 0 auto;
  padding: 28px 24px 48px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.stats-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}

.stats-h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.stats-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.metrics {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.metric {
  padding: 16px 16px 16px 16px;
  border-right: 1px solid var(--line);
}

.metric:first-child { padding-left: 0; }
.metric:last-child { border-right: 0; padding-right: 0; }

.metric dt {
  font-size: 12px;
  color: var(--ink-3);
}

.metric-val {
  margin: 5px 0 3px;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.03em;
}

.metric-sub {
  margin: 0;
  font-size: 11.5px;
  color: var(--ink-4);
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 28px;
}

.stats-sec {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.line-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--line);
}

.line-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line-soft);
  font-size: 13px;
}

.line-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.line-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

/* PDF Dialog */
.pdf-dialog {
  width: min(920px, 95vw);
  height: 90dvh;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--bg);
  box-shadow: 0 20px 44px rgba(17, 18, 20, 0.16);
}

.pdf-dialog::backdrop {
  background: rgba(17, 18, 20, 0.3);
  backdrop-filter: blur(2px);
}

.pdf-dialog[open] {
  display: flex;
  flex-direction: column;
}

.pdf-head {
  height: 44px;
  padding: 0 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--line);
}

.pdf-dialog iframe {
  flex: 1;
  border: 0;
  width: 100%;
}

/* База знаний */
.kb-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.kb-head .sec-h { margin: 0; }
.kb-tools { display: flex; gap: 8px; align-items: center; }
.kb-search { width: 220px; }
.kb-list { max-height: 420px; overflow-y: auto; }
.kb-list .line-left span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-notice { font-size: 13px; margin: 6px 0; color: var(--ink-2); }
.kb-dialog { width: min(760px, 95vw); }
.kb-form { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.kb-body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px; padding: 14px; }
.kb-label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--ink-3); }
.kb-label .field { width: 100%; color: var(--ink); }
.kb-grow { flex: 1; min-height: 0; }
.kb-ta { flex: 1; min-height: 200px; resize: none; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 10px; }
.kb-foot { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--line); }

/* Широкий экран: страница не листается, список и рабочая область листаются каждая внутри себя,
   шапки колонок остаются на месте */
@media (min-width: 961px) {
  .mgr-page:has(.inbox) { height: 100dvh; overflow: hidden; }
  .inbox { flex: 1 1 auto; min-height: 0; height: calc(100dvh - 48px); overflow: hidden; }
  .inbox-list, .inbox > .workspace, .inbox > .ws-empty { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .inbox-bar { position: sticky; top: 0; z-index: 2; flex-shrink: 0; background: var(--bg-chrome); }
  .ws-bar { position: sticky; top: 0; z-index: 2; flex-shrink: 0; background: var(--bg); }
}

@media (max-width: 960px) {
  .inbox { grid-template-columns: minmax(0, 1fr); }
  .inbox-list { border-right: 0; border-bottom: 1px solid var(--line); }
  .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .metric { border-right: 0; border-bottom: 1px solid var(--line-soft); padding: 12px 0; }
  .stats-grid { grid-template-columns: 1fr; }
  .ws-bar, .ws-content { padding-left: 16px; padding-right: 16px; }
}

/* Узкий экран: в шапке остаются знак, вкладки и действия — без наложения и переносов */
.view-tab, .topbar-right .btn { white-space: nowrap; }
@media (max-width: 600px) {
  .hide-narrow { display: none; }
  .topbar-inner { gap: 6px; padding: 0 12px; }
  .view-tabs { margin-left: 2px; gap: 0; }
  .view-tab { padding: 0 6px; }
  .topbar-right { gap: 2px; }
  .topbar-right .btn { padding-left: 6px; padding-right: 6px; }
  .kb-tools { width: 100%; }
  .kb-search { flex: 1; width: auto; min-width: 0; }
  .kb-list .line-right .muted { display: none; }
  .kb-dialog { width: 100vw; max-width: 100vw; height: 100dvh; max-height: 100dvh; border-radius: 0; margin: 0; }
}
</style>
