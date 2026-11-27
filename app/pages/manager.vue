<script setup lang="ts">
import { qtyUnit, renderMd, rub } from '~/utils/md'

interface Row { id: string; channel: string; status: string; subject: string | null; customer_company: string | null; updated_at: string; last_question: string | null; draft_proposals: number; open_escalations: number; cost_rub: string }
interface Item { sku: string; name: string; unit: string; qty: number; unit_cents: string; discount_pct: number; sum_cents: string }
interface Proposal { id: string; number: string; status: string; customer: any; items: Item[]; subtotal_cents: string; discount_cents: string; total_cents: string; vat_cents: string; notes: string | null; valid_until: string | null }
interface Escalation { id: number; kind: string; question: string; reason: string; resolved: boolean; created_at: string }
interface Run { id: number; model: string; steps: number; input_tokens: number; output_tokens: number; cost_rub: string; duration_ms: number; tools: any; escalated: boolean; verify_issues: any[]; created_at: string }
interface Card { conversation: any; messages: { id: number; role: string; content: string; created_at: string }[]; proposals: Proposal[]; invoices: any[]; escalations: Escalation[]; runs: Run[] }
interface Stats { days: number; totals: { conversations: number; runs: number; escalated_runs: number; cost_rub: string; avg_cost_rub: string; median_ms: number; verify_issues: number }; byModel: { model: string; runs: number; cost_rub: string }[]; proposals: { status: string; n: number; total_cents: string }[]; gaps: (Escalation & { conversation_id: string })[]; learned?: { slug: string; title: string; updated_at: string }[] }

const TOKEN_KEY = 'manager-token'
const token = ref('')
const tokenInput = ref('')
const authError = ref('')
const tab = ref<'queue' | 'stats'>('queue')
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
  draft: ['черновик', 'warn'],
  approved: ['проверено', 'ok'],
  sent: ['отправлено', 'ok'],
  rejected: ['отклонено', 'bad'],
  waiting_manager: ['ждёт менеджера', 'warn'],
  open: ['открыто', ''],
  closed: ['закрыто', ''],
}
const ROLE: Record<string, string> = { user: 'Клиент', assistant: 'Агент', manager: 'Менеджер', tool: 'Инструмент', system: 'Система' }

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
  selected.value = id
  notice.value = ''
  card.value = await api<Card>(`/api/manager/conversations/${id}`)
  email.value = card.value.conversation?.customer_email || ''
  proposalNote.value = ''
}

async function loadStats() {
  stats.value = await api<Stats>(`/api/manager/stats?days=${days.value}`)
}

async function refresh() {
  if (!token.value) return
  try {
    if (tab.value === 'queue') {
      await loadRows()
      if (selected.value) await open(selected.value)
    } else {
      await loadStats()
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
    ? 'Ответ отправлен клиенту и добавлен в базу знаний — агент будет использовать его дальше'
    : 'Ответ отправлен в чат клиента'
})

async function forget(slug: string) {
  forgetting.value = slug
  try {
    await api(`/api/manager/learned/${slug}`, { method: 'DELETE' })
    await loadStats()
  } catch {}
  finally { forgetting.value = '' }
}

async function refreshFeed() {
  if (refreshingFeed.value) return
  refreshingFeed.value = true
  feedNotice.value = ''
  try {
    const r = await api<{ ok: boolean; result?: any }>('/api/manager/feed/refresh', { method: 'POST' })
    feedNotice.value = typeof r.result === 'string' ? r.result : 'Обновление каталога из фида завершено'
  } catch (e: any) {
    feedNotice.value = e?.data?.statusMessage || e?.statusMessage || 'Не удалось обновить фид'
  } finally {
    refreshingFeed.value = false
  }
}

/** PDF закрыт токеном: iframe заголовок не передаст, поэтому забираем файлом и показываем по blob-ссылке. */
async function showPdf(p: Proposal) {
  try {
    const blob = await api<Blob>(`/api/manager/proposals/${p.id}/pdf`, { responseType: 'blob' })
    if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value)
    pdfUrl.value = URL.createObjectURL(blob)
    pdfTitle.value = `${p.number.startsWith('КП') ? p.number : `КП ${p.number}`} · Черновик на проверку менеджеру`
    pdfDialog.value?.showModal()
  } catch (e: any) {
    notice.value = e?.data?.statusMessage || 'PDF не открылся'
  }
}

function onDialogBackdropClick(e: MouseEvent) {
  if (e.target === pdfDialog.value) pdfDialog.value?.close()
}

const toolsOf = (r: Run) => (Array.isArray(r.tools) ? r.tools : []).map((t: any) => (typeof t === 'string' ? t : t?.name)).filter(Boolean).join(', ')
const time = (s: string) => new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const fmtRub = (s: string | number) => Number(s).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽'
const selfShare = computed(() => {
  const t = stats.value?.totals
  if (!t?.runs) return '—'
  return Math.round(100 * (1 - t.escalated_runs / t.runs)) + '%'
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
  <div class="mgr-shell">
    <!-- Quiet Top Bar -->
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand-wrap">
          <div class="brand-mark" aria-hidden="true">ДС</div>
          <span class="brand-title">Панель менеджера</span>
        </div>

        <div v-if="token" class="seg" role="group" aria-label="Раздел">
          <button :aria-pressed="tab === 'queue'" @click="tab = 'queue'">
            <span>Очередь</span>
            <span v-if="waitingCount" class="seg-count">{{ waitingCount }}</span>
          </button>
          <button :aria-pressed="tab === 'stats'" @click="tab = 'stats'">Сводка и БЗ</button>
        </div>

        <div class="topbar-actions">
          <NuxtLink to="/" class="nav-link">Чат клиента →</NuxtLink>
          <button v-if="token" class="btn small ghost" @click="logout">Выйти</button>
        </div>
      </div>
    </header>

    <!-- Login Screen -->
    <main v-if="!token" class="login-wrap">
      <form class="login-card" @submit.prevent="login">
        <h1 class="login-title">Вход в панель менеджера</h1>
        <p class="login-sub">Введите токен доступа (<code class="mono">NUXT_MANAGER_TOKEN</code>). Без токена панель закрыта.</p>
        <label class="field-label" for="tok">Токен менеджера</label>
        <input id="tok" v-model="tokenInput" class="field" type="password" autocomplete="current-password" placeholder="••••••••••••" />
        <button class="btn primary login-btn" :disabled="!tokenInput.trim()">Войти</button>
        <p v-if="authError" class="err-msg" role="alert">{{ authError }}</p>
      </form>
    </main>

    <!-- Catalyst Split-View Queue + Detail -->
    <div v-else-if="tab === 'queue'" class="split-layout">
      <!-- Left Triage Queue -->
      <aside class="queue-pane">
        <div class="queue-bar">
          <div class="seg" role="group" aria-label="Фильтр">
            <button :aria-pressed="filter === 'waiting_manager'" @click="filter = 'waiting_manager'">Ждут</button>
            <button :aria-pressed="filter === ''" @click="filter = ''">Все</button>
          </div>
          <button class="btn small ghost" @click="refresh">Обновить</button>
        </div>

        <p v-if="!rows.length" class="empty-queue muted">Пусто. Новые обращения появятся автоматически.</p>

        <ul v-else role="list" class="queue-list">
          <li v-for="r in rows" :key="r.id">
            <button class="queue-row" :class="{ active: r.id === selected }" @click="open(r.id)">
              <div class="row-top">
                <span class="row-title">{{ r.customer_company || r.subject || (r.channel === 'email' ? 'Почта' : 'Веб-чат') }}</span>
                <span class="row-time num">{{ time(r.updated_at) }}</span>
              </div>
              <p class="row-snippet">{{ r.last_question || r.subject || 'Без текста' }}</p>
              <div class="row-meta">
                <span v-if="r.draft_proposals" class="meta-warn">КП: {{ r.draft_proposals }}</span>
                <span v-if="r.open_escalations" class="meta-bad">Эскалаций: {{ r.open_escalations }}</span>
                <span class="muted">{{ r.channel === 'email' ? 'почта' : 'чат' }}</span>
                <span class="num muted">{{ fmtRub(r.cost_rub) }}</span>
              </div>
            </button>
          </li>
        </ul>
      </aside>

      <!-- Right Detail Workspace -->
      <main v-if="card" class="detail-pane">
        <!-- Page Heading + Trust Strip -->
        <div class="detail-head">
          <div class="detail-head-top">
            <div class="detail-title-wrap">
              <h1 class="detail-title">
                {{ card.conversation.subject || card.messages.find(m => m.role === 'user')?.content?.slice(0, 84) || 'Обращение' }}
              </h1>
              <span class="chip" :class="STATUS[card.conversation.status]?.[1]">
                {{ STATUS[card.conversation.status]?.[0] || card.conversation.status }}
              </span>
            </div>
            <p class="detail-sub">
              {{ card.conversation.customer_company || 'Компания не указана' }} · {{ card.conversation.channel === 'email' ? 'Почта' : 'Веб-чат' }} · {{ time(card.conversation.created_at) }}
            </p>
          </div>

          <!-- Trust & Audit Strip -->
          <div class="trust-strip">
            <span v-if="card.runs.length" class="chip" :class="cardVerifyIssues ? 'bad' : 'ok'">
              {{ cardVerifyIssues ? `Сверка цифр: ${cardVerifyIssues} расхожд.` : '✓ Цифры сверены' }}
            </span>
            <span class="chip">ПДн скрыты до модели</span>
            <span v-if="cardLastModel" class="chip mono">{{ cardLastModel }}</span>
            <span class="chip mono">{{ fmtRub(cardTotalCost) }}</span>
          </div>
        </div>

        <div class="detail-body">
          <p v-if="notice" class="notice-banner" role="status">{{ notice }}</p>

          <!-- Open Escalations -->
          <div v-for="e in card.escalations.filter(x => !x.resolved)" :key="e.id" class="esc-banner">
            <div class="esc-info">
              <span class="chip" :class="KIND[e.kind]?.[1]">{{ KIND[e.kind]?.[0] || e.kind }}</span>
              <span>{{ e.reason }}</span>
            </div>
            <button class="btn small" :disabled="busy" @click="resolve(e)">Закрыть</button>
          </div>

          <!-- Proposals Review -->
          <div v-for="p in card.proposals" :key="p.id" class="proposal-box">
            <div class="proposal-head">
              <div class="proposal-id">
                <strong>{{ p.number.startsWith('КП') ? p.number : `КП ${p.number}` }}</strong>
                <span class="chip" :class="STATUS[p.status]?.[1]">{{ STATUS[p.status]?.[0] || p.status }}</span>
                <span v-if="p.valid_until" class="muted tiny">до {{ p.valid_until }}</span>
              </div>
              <div class="proposal-total-top">
                <span class="num total-lg">{{ rub(p.total_cents) }}</span>
                <span class="muted tiny">вкл. НДС {{ rub(p.vat_cents) }}</span>
              </div>
            </div>

            <div class="table-wrap">
              <table class="clean-table">
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
                      <div class="item-name">{{ i.name }}</div>
                      <div class="mono muted tiny">{{ i.sku }}</div>
                    </td>
                    <td class="r num">{{ qtyUnit(i.qty, i.unit) }}</td>
                    <td class="r num">{{ rub(i.unit_cents) }}</td>
                    <td class="r num">{{ i.discount_pct ? `${i.discount_pct}%` : '—' }}</td>
                    <td class="r num strong-cell">{{ rub(i.sum_cents) }}</td>
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

            <p v-if="p.notes" class="muted tiny">{{ p.notes }}</p>

            <div class="proposal-actions">
              <button class="btn small" @click="showPdf(p)">Открыть PDF</button>
              <template v-if="p.status === 'draft'">
                <input v-model="email" class="field mail-input" type="email" placeholder="Email клиента (опционально)" aria-label="Почта клиента" />
                <input v-model="proposalNote" class="field note-input" type="text" placeholder="Комментарий к письму" aria-label="Комментарий к письму" />
                <div class="action-group">
                  <button class="btn danger small" :disabled="busy" @click="reject(p)">Отклонить</button>
                  <button class="btn primary small" :disabled="busy" @click="approve(p)">Подтвердить и отправить</button>
                </div>
              </template>
            </div>
          </div>

          <!-- Conversation History -->
          <section class="section-block">
            <h2 class="section-label">Переписка</h2>
            <div class="thread-list">
              <div
                v-for="m in card.messages.filter(x => ['user', 'assistant', 'manager'].includes(x.role))"
                :key="m.id"
                class="thread-item"
                :class="m.role"
              >
                <div class="thread-meta">
                  <span class="thread-role">{{ ROLE[m.role] || m.role }}</span>
                  <span class="mono muted tiny">{{ time(m.created_at) }}</span>
                </div>
                <div class="md" v-html="renderMd(m.content)" />
              </div>
            </div>
          </section>

          <!-- Manager Reply + Self-Learning Toggle -->
          <form class="reply-form" @submit.prevent="sendReply">
            <textarea
              v-model="reply"
              class="field"
              rows="3"
              maxlength="4000"
              placeholder="Напишите ответ клиенту — он появится в его чате и закроет открытые эскалации…"
              aria-label="Ответ клиенту"
            />
            <div class="reply-footer">
              <label class="learn-toggle" :class="{ active: remember }">
                <input v-model="remember" type="checkbox" />
                <span>
                  <strong>Запомнить ответ в базе знаний</strong>
                  <small>Агент сам ответит следующему клиенту с таким же вопросом</small>
                </span>
              </label>
              <button class="btn dark" :disabled="busy || !reply.trim()">Ответить клиенту</button>
            </div>
          </form>

          <!-- Progressive Disclosure: Technical Audit -->
          <details class="audit-details">
            <summary>
              <span>Технический аудит запусков ({{ card.runs.length }})</span>
              <span class="mono muted">{{ fmtRub(cardTotalCost) }}</span>
            </summary>
            <div class="table-wrap audit-table-wrap">
              <table class="clean-table">
                <thead>
                  <tr>
                    <th>Время</th>
                    <th>Модель</th>
                    <th>Инструменты</th>
                    <th class="r">Токены</th>
                    <th class="r">₽</th>
                    <th class="r">Время</th>
                    <th>Сверка</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in card.runs" :key="r.id">
                    <td class="num tiny">{{ time(r.created_at) }}</td>
                    <td class="mono tiny">{{ r.model }}</td>
                    <td class="mono tiny muted">{{ toolsOf(r) || '—' }}</td>
                    <td class="r num tiny">{{ r.input_tokens }} / {{ r.output_tokens }}</td>
                    <td class="r num tiny">{{ Number(r.cost_rub).toFixed(2) }}</td>
                    <td class="r num tiny">{{ (r.duration_ms / 1000).toFixed(1) }} с</td>
                    <td>
                      <span class="chip" :class="r.verify_issues?.length ? 'bad' : 'ok'">
                        {{ r.verify_issues?.length ? `расхождений: ${r.verify_issues.length}` : 'сходится' }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </main>

      <main v-else class="detail-empty">
        <p class="muted">Выберите обращение в очереди слева</p>
      </main>
    </div>

    <!-- Stats & Knowledge Base Gaps (Shared-Border Strip) -->
    <main v-else-if="stats" class="stats-page">
      <div class="stats-head">
        <div>
          <h1 class="stats-title">Сводка и база знаний</h1>
          <p class="muted tiny">Экономика обращений, качество сверки и обучение агента</p>
        </div>
        <div class="stats-controls">
          <button class="btn small" :disabled="refreshingFeed" @click="refreshFeed">
            {{ refreshingFeed ? 'Обновляю фид…' : 'Обновить каталог из фида' }}
          </button>
          <div class="seg" role="group" aria-label="Период">
            <button v-for="d in [1, 7, 30]" :key="d" :aria-pressed="days === d" @click="days = d">
              {{ d === 1 ? 'Сутки' : `${d} дней` }}
            </button>
          </div>
        </div>
      </div>

      <p v-if="feedNotice" class="notice-banner" role="status">{{ feedNotice }}</p>

      <!-- Shared-Border Stat Strip -->
      <dl class="kpi-strip">
        <div class="kpi-cell">
          <dt>Обращений</dt>
          <dd class="kpi-val num">{{ stats.totals.conversations }}</dd>
          <dd class="kpi-sub">{{ stats.totals.runs }} запусков агента</dd>
        </div>
        <div class="kpi-cell">
          <dt>Без участия менеджера</dt>
          <dd class="kpi-val num">{{ selfShare }}</dd>
          <dd class="kpi-sub">{{ stats.totals.runs - stats.totals.escalated_runs }} из {{ stats.totals.runs }}</dd>
        </div>
        <div class="kpi-cell">
          <dt>Средняя цена запроса</dt>
          <dd class="kpi-val num">{{ fmtRub(stats.totals.avg_cost_rub) }}</dd>
          <dd class="kpi-sub">всего {{ fmtRub(stats.totals.cost_rub) }}</dd>
        </div>
        <div class="kpi-cell">
          <dt>Медиана ответа</dt>
          <dd class="kpi-val num">{{ (stats.totals.median_ms / 1000).toFixed(1) }} с</dd>
          <dd class="kpi-sub">включая поиск по каталогу</dd>
        </div>
        <div class="kpi-cell">
          <dt>Расхождений сверки</dt>
          <dd class="kpi-val num">{{ stats.totals.verify_issues }}</dd>
          <dd class="kpi-sub">уходят менеджеру</dd>
        </div>
      </dl>

      <!-- Proposals + Models -->
      <div class="stats-cols">
        <section class="stats-section">
          <h2>КП за период</h2>
          <p v-if="!stats.proposals.length" class="muted tiny">Пока нет</p>
          <ul v-else class="kv-list">
            <li v-for="p in stats.proposals" :key="p.status" class="kv-row">
              <span class="chip" :class="STATUS[p.status]?.[1]">{{ STATUS[p.status]?.[0] || p.status }}</span>
              <span class="num">{{ p.n }} шт. · {{ rub(p.total_cents) }}</span>
            </li>
          </ul>
        </section>

        <section class="stats-section">
          <h2>Модели</h2>
          <p v-if="!stats.byModel.length" class="muted tiny">Пока нет</p>
          <ul v-else class="kv-list">
            <li v-for="m in stats.byModel" :key="m.model" class="kv-row">
              <span class="mono tiny">{{ m.model }}</span>
              <span class="num tiny">{{ m.runs }} запусков · {{ fmtRub(m.cost_rub) }}</span>
            </li>
          </ul>
        </section>
      </div>

      <!-- Self-Learned Knowledge Base -->
      <section class="stats-section">
        <h2>Агент научился на ответах менеджера</h2>
        <p v-if="!stats.learned?.length" class="muted tiny">
          Пока пусто. Отметьте «Запомнить ответ в базе знаний» под ответом клиенту — запись появится здесь.
        </p>
        <ul v-else class="stacked-list">
          <li v-for="l in stats.learned" :key="l.slug" class="stacked-row">
            <span class="chip ok">в базе знаний</span>
            <span class="stacked-main">{{ l.title.replace(/^Ответ менеджера: /, '') }}</span>
            <span class="num muted tiny">{{ time(l.updated_at) }}</span>
            <button
              class="btn small ghost"
              :disabled="forgetting === l.slug"
              title="Убрать из базы знаний"
              @click="forget(l.slug)"
            >
              Забыть
            </button>
          </li>
        </ul>
      </section>

      <!-- Open Escalations & Gaps -->
      <section class="stats-section">
        <h2>Открытые эскалации и пробелы базы знаний</h2>
        <p v-if="!stats.gaps.length" class="muted tiny">Нет открытых эскалаций</p>
        <ul v-else class="stacked-list">
          <li v-for="g in stats.gaps" :key="g.id" class="stacked-row">
            <span class="chip" :class="KIND[g.kind]?.[1]">{{ KIND[g.kind]?.[0] || g.kind }}</span>
            <span class="stacked-main">{{ g.question }}</span>
            <button class="btn small" @click="tab = 'queue'; open(g.conversation_id)">Открыть</button>
          </li>
        </ul>
      </section>
    </main>

    <!-- Native <dialog> PDF Viewer -->
    <dialog ref="pdfDialog" class="pdf-dialog" aria-label="PDF коммерческого предложения" @click="onDialogBackdropClick">
      <div class="pdf-bar">
        <span class="mono tiny">{{ pdfTitle }}</span>
        <button class="btn small ghost" @click="pdfDialog?.close()">Закрыть</button>
      </div>
      <iframe v-if="pdfUrl" :src="pdfUrl" title="PDF КП" />
    </dialog>
  </div>
</template>

<style scoped>
.mgr-shell {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.tiny {
  font-size: 12.5px;
}

/* Login */
.login-wrap {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 24px;
}

.login-card {
  width: 100%;
  max-width: 380px;
  padding: 28px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.login-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.login-sub {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--muted);
}

.field-label {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-secondary);
}

.login-btn {
  margin-top: 4px;
  width: 100%;
}

.err-msg {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--bad);
}

/* Catalyst Split-View */
.split-layout {
  flex: 1;
  max-width: 1280px;
  width: 100%;
  margin: 0 auto;
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
  min-height: calc(100dvh - 56px);
}

.queue-pane {
  border-right: 1px solid var(--line);
  background: var(--bg-subtle);
  display: flex;
  flex-direction: column;
}

.queue-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}

.empty-queue {
  padding: 24px 16px;
  font-size: 13px;
  margin: 0;
}

.queue-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.queue-row {
  width: 100%;
  text-align: left;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  padding: 14px 16px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 5px;
  transition: background 150ms var(--ease);
}

.queue-row:hover {
  background: rgba(255, 255, 255, 0.75);
}

.queue-row.active {
  background: var(--surface);
  box-shadow: inset 3px 0 0 0 var(--accent);
}

.row-top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

.row-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-time {
  font-size: 11px;
  color: var(--muted);
}

.row-snippet {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11.5px;
  margin-top: 2px;
}

.meta-warn {
  color: var(--warn);
  font-weight: 600;
}

.meta-bad {
  color: var(--bad);
  font-weight: 600;
}

/* Detail Workspace */
.detail-pane {
  background: var(--bg);
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.detail-empty {
  display: grid;
  place-items: center;
  min-height: 360px;
  font-size: 14px;
}

.detail-head {
  padding: 20px 28px 16px;
  border-bottom: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.detail-title-wrap {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.detail-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.detail-sub {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--muted);
}

.trust-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.detail-body {
  padding: 22px 28px 32px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.notice-banner {
  margin: 0;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  color: var(--accent);
  font-size: 13px;
}

.esc-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--warn-soft);
  border: 1px solid var(--warn-line);
  font-size: 13px;
}

.esc-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* Proposal Box */
.proposal-box {
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.proposal-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}

.proposal-id {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.proposal-total-top {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.total-lg {
  font-size: 18px;
  font-weight: 600;
}

.table-wrap {
  overflow-x: auto;
}

.clean-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.clean-table th {
  text-align: left;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--muted);
  padding: 6px 8px 8px 0;
  border-bottom: 1px solid var(--line);
}

.clean-table td {
  padding: 9px 8px 9px 0;
  border-bottom: 1px solid var(--line-soft);
  vertical-align: top;
}

.clean-table tr:last-child td {
  border-bottom: 0;
}

.clean-table .r {
  text-align: right;
  padding-right: 0;
  padding-left: 12px;
}

.item-name {
  font-weight: 500;
  color: var(--text);
}

.strong-cell {
  font-weight: 600;
}

.proposal-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--line-soft);
}

.mail-input {
  width: 210px;
  padding: 5px 10px;
  font-size: 12.5px;
  height: 30px;
}

.note-input {
  flex: 1;
  min-width: 160px;
  padding: 5px 10px;
  font-size: 12.5px;
  height: 30px;
}

.action-group {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

/* Conversation Thread */
.section-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-label {
  margin: 0;
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}

.thread-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  border-left: 2px solid var(--line-soft);
  padding-left: 16px;
}

.thread-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.thread-item.manager {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--ok-soft);
  border: 1px solid var(--ok-line);
}

.thread-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.thread-role {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-secondary);
}

/* Reply Form & Learning Toggle */
.reply-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}

.reply-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.learn-toggle {
  display: inline-flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--bg-subtle);
  cursor: pointer;
  font-size: 12.5px;
  transition: border-color 150ms var(--ease), background 150ms var(--ease);
}

.learn-toggle.active {
  border-color: var(--ok-line);
  background: var(--ok-soft);
}

.learn-toggle input {
  margin-top: 3px;
  accent-color: var(--ok);
}

.learn-toggle strong {
  display: block;
  font-weight: 600;
  color: var(--text);
}

.learn-toggle small {
  display: block;
  color: var(--muted);
  font-size: 11.5px;
}

/* Technical Audit Details */
.audit-details {
  border-top: 1px solid var(--line);
  padding-top: 14px;
}

.audit-details summary {
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  list-style: none;
}

.audit-details summary::-webkit-details-marker {
  display: none;
}

.audit-details summary:hover {
  color: var(--text);
}

.audit-table-wrap {
  margin-top: 12px;
}

/* Stats Page */
.stats-page {
  max-width: 1040px;
  width: 100%;
  margin: 0 auto;
  padding: 28px 24px 48px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.stats-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}

.stats-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.stats-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* Shared-Border KPI Strip */
.kpi-strip {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.kpi-cell {
  padding: 18px 18px 18px 0;
  border-right: 1px solid var(--line);
  padding-left: 18px;
}

.kpi-cell:first-child {
  padding-left: 0;
}

.kpi-cell:last-child {
  border-right: 0;
  padding-right: 0;
}

.kpi-cell dt {
  font-size: 12px;
  color: var(--muted);
}

.kpi-val {
  margin: 6px 0 4px;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.03em;
  color: var(--text);
}

.kpi-sub {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.stats-cols {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 28px;
}

.stats-section h2 {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.kv-list,
.stacked-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--line);
}

.kv-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line-soft);
}

.stacked-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 0;
  border-bottom: 1px solid var(--line-soft);
}

.stacked-main {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  color: var(--text);
}

/* Native PDF Dialog */
.pdf-dialog {
  width: min(920px, 95vw);
  height: 90dvh;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 24px 48px rgba(9, 9, 11, 0.18);
}

.pdf-dialog::backdrop {
  background: rgba(9, 9, 11, 0.35);
  backdrop-filter: blur(3px);
}

.pdf-dialog[open] {
  display: flex;
  flex-direction: column;
}

.pdf-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
}

.pdf-dialog iframe {
  flex: 1;
  border: 0;
  width: 100%;
}

@media (max-width: 960px) {
  .split-layout { grid-template-columns: 1fr; }
  .queue-pane { border-right: 0; border-bottom: 1px solid var(--line); }
  .kpi-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .kpi-cell { border-right: 0; border-bottom: 1px solid var(--line-soft); padding: 14px 0; }
  .stats-cols { grid-template-columns: 1fr; }
  .detail-head, .detail-body { padding-left: 16px; padding-right: 16px; }
}
</style>
