<script setup lang="ts">
import { qtyUnit, renderMd, rub } from '~/utils/md'

interface Row { id: string; channel: string; status: string; subject: string | null; customer_company: string | null; updated_at: string; last_question: string | null; draft_proposals: number; open_escalations: number; cost_rub: string }
interface Item { sku: string; name: string; unit: string; qty: number; unit_cents: string; discount_pct: number; sum_cents: string }
interface Proposal { id: string; number: string; status: string; customer: any; items: Item[]; subtotal_cents: string; discount_cents: string; total_cents: string; vat_cents: string; notes: string | null; valid_until: string | null }
interface Escalation { id: number; kind: string; question: string; reason: string; resolved: boolean; created_at: string }
interface Run { id: number; model: string; steps: number; input_tokens: number; output_tokens: number; cost_rub: string; duration_ms: number; tools: any; escalated: boolean; verify_issues: any[]; created_at: string }
interface Card { conversation: any; messages: { id: number; role: string; content: string; created_at: string }[]; proposals: Proposal[]; invoices: any[]; escalations: Escalation[]; runs: Run[] }
interface Stats { days: number; totals: { conversations: number; runs: number; escalated_runs: number; cost_rub: string; avg_cost_rub: string; median_ms: number; verify_issues: number }; byModel: { model: string; runs: number; cost_rub: string }[]; proposals: { status: string; n: number; total_cents: string }[]; gaps: (Escalation & { conversation_id: string })[] }

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
const busy = ref(false)
const notice = ref('')
const pdfUrl = ref('')
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
  draft: ['черновик', 'warn'], approved: ['проверено', 'ok'], sent: ['отправлено', 'ok'], rejected: ['отклонено', 'bad'],
  waiting_manager: ['ждёт менеджера', 'warn'], open: ['открыто', ''], closed: ['закрыто', ''],
}
const ROLE: Record<string, string> = { user: 'Клиент', assistant: 'Агент', manager: 'Менеджер', tool: 'Инструмент', system: 'Система' }

const headers = computed(() => ({ authorization: `Bearer ${token.value}` }))

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

async function loadRows() {
  rows.value = await api<Row[]>(`/api/manager/conversations${filter.value ? `?status=${filter.value}` : ''}`)
}
async function open(id: string) {
  selected.value = id
  notice.value = ''
  card.value = await api<Card>(`/api/manager/conversations/${id}`)
  email.value = card.value.conversation?.customer_email || ''
}
async function loadStats() {
  stats.value = await api<Stats>(`/api/manager/stats?days=${days.value}`)
}
async function refresh() {
  if (!token.value) return
  try {
    if (tab.value === 'queue') { await loadRows(); if (selected.value) await open(selected.value) }
    else await loadStats()
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
  const r = await api<{ number: string; status: string; mail: string; error: string | null }>(`/api/manager/proposals/${p.id}/approve`, { method: 'POST', body: { email: email.value || undefined } })
  return r.mail === 'sent' ? `КП ${r.number} проверено и отправлено клиенту` : `КП ${r.number} проверено${r.error ? ` (письмо не ушло: ${r.error})` : ', письмо сохранено в журнале'}`
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
  await api(`/api/manager/conversations/${selected.value}/reply`, { method: 'POST', body: { text: reply.value } })
  reply.value = ''
  return 'Ответ отправлен в чат клиента'
})

/** PDF закрыт токеном: iframe заголовок не передаст, поэтому забираем файлом и показываем по blob-ссылке. */
async function showPdf(p: Proposal) {
  try {
    const blob = await api<Blob>(`/api/manager/proposals/${p.id}/pdf`, { responseType: 'blob' })
    if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value)
    pdfUrl.value = URL.createObjectURL(blob)
    pdfDialog.value?.showModal()
  } catch (e: any) { notice.value = e?.data?.statusMessage || 'PDF не открылся' }
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
onBeforeUnmount(() => { if (timer) clearInterval(timer); if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value) })
</script>

<template>
  <div class="wrap">
    <header class="top">
      <div class="brand">Панель менеджера</div>
      <div v-if="token" class="seg" role="group" aria-label="Раздел">
        <button :aria-pressed="tab === 'queue'" @click="tab = 'queue'">Очередь</button>
        <button :aria-pressed="tab === 'stats'" @click="tab = 'stats'">Сводка</button>
      </div>
      <NuxtLink to="/" class="small">Чат клиента →</NuxtLink>
    </header>

    <form v-if="!token" class="login" @submit.prevent="login">
      <label for="tok">Токен менеджера</label>
      <input id="tok" v-model="tokenInput" class="field" type="password" autocomplete="current-password" />
      <button class="btn primary" :disabled="!tokenInput.trim()">Войти</button>
      <p v-if="authError" class="err small">{{ authError }}</p>
    </form>

    <!-- Очередь -->
    <div v-else-if="tab === 'queue'" class="queue">
      <aside class="side">
        <div class="seg" role="group" aria-label="Фильтр">
          <button :aria-pressed="filter === 'waiting_manager'" @click="filter = 'waiting_manager'">Ждут менеджера</button>
          <button :aria-pressed="filter === ''" @click="filter = ''">Все</button>
        </div>
        <p v-if="!rows.length" class="muted small">Пусто. Новые обращения появятся сами.</p>
        <button v-for="r in rows" :key="r.id" class="item" :class="{ on: r.id === selected }" @click="open(r.id)">
          <div class="line1">
            <span class="q">{{ r.subject || r.last_question || 'Без текста' }}</span>
            <span class="muted tiny num">{{ time(r.updated_at) }}</span>
          </div>
          <div class="line2">
            <span v-if="r.open_escalations" class="chip warn">эскалаций: {{ r.open_escalations }}</span>
            <span v-if="r.draft_proposals" class="chip accent">КП: {{ r.draft_proposals }}</span>
            <span class="chip">{{ r.channel === 'email' ? 'почта' : 'чат' }}</span>
            <span class="muted tiny num">{{ fmtRub(r.cost_rub) }}</span>
          </div>
        </button>
      </aside>

      <section v-if="card" class="detail">
        <div class="head">
          <div>
            <div class="title">{{ card.conversation.subject || card.messages.find(m => m.role === 'user')?.content?.slice(0, 80) || 'Обращение' }}</div>
            <div class="muted tiny">{{ card.conversation.customer_company || 'компания не указана' }} · {{ time(card.conversation.created_at) }}</div>
          </div>
          <span class="chip" :class="STATUS[card.conversation.status]?.[1]">{{ STATUS[card.conversation.status]?.[0] || card.conversation.status }}</span>
        </div>
        <p v-if="notice" class="notice small" role="status">{{ notice }}</p>

        <div v-for="e in card.escalations.filter(x => !x.resolved)" :key="e.id" class="esc">
          <span class="chip" :class="KIND[e.kind]?.[1]">{{ KIND[e.kind]?.[0] || e.kind }}</span>
          <span class="small">{{ e.reason }}</span>
          <button class="btn small" :disabled="busy" @click="resolve(e)">Закрыть</button>
        </div>

        <div v-for="p in card.proposals" :key="p.id" class="prop">
          <div class="prophead">
            <strong>{{ p.number.startsWith('КП') ? p.number : `КП ${p.number}` }}</strong>
            <span class="chip" :class="STATUS[p.status]?.[1]">{{ STATUS[p.status]?.[0] || p.status }}</span>
            <span v-if="p.valid_until" class="muted tiny">действует до {{ p.valid_until }}</span>
          </div>
          <div class="tablewrap">
            <table>
              <thead><tr><th>Позиция</th><th class="r">Кол-во</th><th class="r">Цена</th><th class="r">Скидка</th><th class="r">Сумма</th></tr></thead>
              <tbody>
                <tr v-for="i in p.items" :key="i.sku">
                  <td>{{ i.name }} <span class="muted tiny num">{{ i.sku }}</span></td>
                  <td class="r num">{{ qtyUnit(i.qty, i.unit) }}</td>
                  <td class="r num">{{ rub(i.unit_cents) }}</td>
                  <td class="r num">{{ i.discount_pct ? i.discount_pct + '%' : '—' }}</td>
                  <td class="r num">{{ rub(i.sum_cents) }}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr v-if="Number(p.discount_cents)"><td colspan="4" class="r">Скидка</td><td class="r num">−{{ rub(p.discount_cents) }}</td></tr>
                <tr><td colspan="4" class="r"><strong>Итого</strong> <span class="muted tiny">в т. ч. НДС {{ rub(p.vat_cents) }}</span></td><td class="r num"><strong>{{ rub(p.total_cents) }}</strong></td></tr>
              </tfoot>
            </table>
          </div>
          <p v-if="p.notes" class="muted small">{{ p.notes }}</p>
          <div class="actions">
            <button class="btn small" @click="showPdf(p)">Открыть PDF</button>
            <template v-if="p.status === 'draft'">
              <input v-model="email" class="field mail" type="email" placeholder="почта клиента" aria-label="Почта клиента" />
              <button class="btn primary small" :disabled="busy" @click="approve(p)">Проверено, отправить</button>
              <button class="btn danger small" :disabled="busy" @click="reject(p)">Отклонить</button>
            </template>
          </div>
        </div>

        <div class="msgs">
          <div v-for="m in card.messages.filter(x => ['user', 'assistant', 'manager'].includes(x.role))" :key="m.id" class="msg" :class="m.role">
            <div class="muted tiny">{{ ROLE[m.role] || m.role }} · {{ time(m.created_at) }}</div>
            <div class="md" v-html="renderMd(m.content)" />
          </div>
        </div>

        <form class="reply" @submit.prevent="sendReply">
          <textarea v-model="reply" class="field" rows="3" maxlength="4000" placeholder="Ответ клиенту — появится в его чате" aria-label="Ответ клиенту" />
          <button class="btn primary" :disabled="busy || !reply.trim()">Ответить клиенту</button>
        </form>

        <details class="runs">
          <summary>Запуски агента: {{ card.runs.length }} · {{ fmtRub(card.runs.reduce((s, r) => s + Number(r.cost_rub), 0)) }}</summary>
          <div class="tablewrap">
            <table>
              <thead><tr><th>Время</th><th>Модель</th><th>Инструменты</th><th class="r">Токены</th><th class="r">₽</th><th class="r">с</th><th>Сверка</th></tr></thead>
              <tbody>
                <tr v-for="r in card.runs" :key="r.id">
                  <td class="num tiny">{{ time(r.created_at) }}</td>
                  <td class="tiny">{{ r.model }}</td>
                  <td class="tiny">{{ toolsOf(r) || '—' }}</td>
                  <td class="r num tiny">{{ r.input_tokens }} / {{ r.output_tokens }}</td>
                  <td class="r num tiny">{{ Number(r.cost_rub).toFixed(2) }}</td>
                  <td class="r num tiny">{{ (r.duration_ms / 1000).toFixed(1) }}</td>
                  <td><span class="chip" :class="r.verify_issues?.length ? 'bad' : 'ok'">{{ r.verify_issues?.length ? `расхождений: ${r.verify_issues.length}` : 'сходится' }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      </section>
      <section v-else class="detail empty muted">Выберите обращение слева</section>
    </div>

    <!-- Сводка -->
    <div v-else-if="stats" class="stats">
      <div class="seg" role="group" aria-label="Период">
        <button v-for="d in [1, 7, 30]" :key="d" :aria-pressed="days === d" @click="days = d">{{ d === 1 ? 'Сутки' : `${d} дней` }}</button>
      </div>
      <div class="tiles">
        <div class="tile"><div class="muted tiny">Обращений</div><div class="big num">{{ stats.totals.conversations }}</div></div>
        <div class="tile"><div class="muted tiny">Ответов без менеджера</div><div class="big num">{{ selfShare }}</div><div class="muted tiny">по запускам агента: {{ stats.totals.runs - stats.totals.escalated_runs }} из {{ stats.totals.runs }}</div></div>
        <div class="tile"><div class="muted tiny">Средняя цена запроса</div><div class="big num">{{ fmtRub(stats.totals.avg_cost_rub) }}</div><div class="muted tiny">всего {{ fmtRub(stats.totals.cost_rub) }}</div></div>
        <div class="tile"><div class="muted tiny">Медиана ответа</div><div class="big num">{{ (stats.totals.median_ms / 1000).toFixed(1) }} с</div></div>
        <div class="tile"><div class="muted tiny">Сверка цифр не сошлась</div><div class="big num">{{ stats.totals.verify_issues }}</div><div class="muted tiny">такие ответы уходят менеджеру</div></div>
      </div>

      <div class="cols">
        <div class="panel">
          <h3>КП за период</h3>
          <p v-if="!stats.proposals.length" class="muted small">Пока нет</p>
          <div v-for="p in stats.proposals" :key="p.status" class="kv">
            <span class="chip" :class="STATUS[p.status]?.[1]">{{ STATUS[p.status]?.[0] || p.status }}</span>
            <span class="num">{{ p.n }} шт · {{ rub(p.total_cents) }}</span>
          </div>
        </div>
        <div class="panel">
          <h3>Модели</h3>
          <div v-for="m in stats.byModel" :key="m.model" class="kv">
            <span class="small">{{ m.model }}</span>
            <span class="num small">{{ m.runs }} · {{ fmtRub(m.cost_rub) }}</span>
          </div>
        </div>
      </div>

      <div class="panel">
        <h3>Открытые эскалации и пробелы базы знаний</h3>
        <p v-if="!stats.gaps.length" class="muted small">Нет открытых</p>
        <div v-for="g in stats.gaps" :key="g.id" class="gap">
          <span class="chip" :class="KIND[g.kind]?.[1]">{{ KIND[g.kind]?.[0] || g.kind }}</span>
          <span class="small q">{{ g.question }}</span>
          <button class="btn small" @click="tab = 'queue'; open(g.conversation_id)">Открыть</button>
        </div>
      </div>
    </div>

    <dialog ref="pdfDialog" class="pdf" aria-label="PDF коммерческого предложения">
      <div class="pdfbar">
        <span class="small">Черновик КП — на проверку менеджеру</span>
        <button class="btn small" @click="pdfDialog?.close()">Закрыть</button>
      </div>
      <iframe v-if="pdfUrl" :src="pdfUrl" title="PDF КП" />
    </dialog>
  </div>
</template>

<style scoped>
.wrap { max-width: 1280px; margin: 0 auto; padding: 0 16px 24px; }
.top { display: flex; align-items: center; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
.top a { margin-left: auto; }
.brand { font-weight: 600; font-size: 17px; }
.small { font-size: 13px; }
.tiny { font-size: 12px; }
.err { color: var(--bad); }
.login { max-width: 340px; margin: 60px auto; display: flex; flex-direction: column; gap: 10px; }
.queue { display: grid; grid-template-columns: 340px 1fr; gap: 16px; align-items: start; }
.side { display: flex; flex-direction: column; gap: 8px; position: sticky; top: 12px; max-height: calc(100dvh - 90px); overflow-y: auto; }
.item { text-align: left; border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 6px; }
.item.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.line1 { display: flex; justify-content: space-between; gap: 8px; }
.q { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.line2 { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.detail { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.detail.empty { align-items: center; justify-content: center; min-height: 300px; }
.head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.title { font-weight: 600; }
.notice { background: var(--accent-soft); color: var(--accent); padding: 8px 12px; border-radius: 8px; margin: 0; }
.esc { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 12px; border-radius: 8px; background: var(--warn-soft); }
.esc .btn { margin-left: auto; }
.prop { border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.prophead { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.tablewrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 500; }
.r { text-align: right; }
tfoot td { border-bottom: 0; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.mail { max-width: 240px; padding: 4px 10px; }
.msgs { display: flex; flex-direction: column; gap: 10px; }
.msg { padding: 10px 12px; border-radius: 8px; background: var(--surface-2); overflow-wrap: anywhere; }
.msg.user { background: var(--accent-soft); }
.msg.manager { background: var(--ok-soft); }
.reply { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.runs summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.stats { display: flex; flex-direction: column; gap: 16px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.tile, .panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; }
.big { font-size: 26px; font-weight: 600; margin: 4px 0; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
.kv { display: flex; justify-content: space-between; gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--line); }
.kv:last-child { border-bottom: 0; }
.gap { display: flex; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line); }
.gap .q { flex: 1; }
.pdf { width: min(900px, 96vw); height: 90dvh; padding: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); color: var(--text); }
.pdf::backdrop { background: rgb(0 0 0 / .45); }
.pdf[open] { display: flex; flex-direction: column; }
.pdfbar { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.pdf iframe { flex: 1; border: 0; width: 100%; }
@media (max-width: 900px) {
  .queue, .cols { grid-template-columns: 1fr; }
  .side { position: static; max-height: none; }
  .top { flex-wrap: wrap; }
}
</style>
