<script setup lang="ts">
import type { TourStep } from '~/utils/tour'

/**
 * Обучающий тур: подсвечивает элемент страницы и объясняет его. Без библиотек.
 * Шаг без target (или чей элемент не нашёлся) показывается окном по центру.
 * Запуск — start() из кнопки «Как это устроено», ?tour=1 в адресе или сам при первом визите (auto).
 */
const props = defineProps<{
  steps: TourStep[]
  /** ключ в localStorage: тур уже видели */
  id: string
  auto?: boolean
  /** последний шаг: куда вести дальше */
  next?: { label: string; to: string }
}>()

const route = useRoute()
const router = useRouter()
const open = ref(false)
const i = ref(0)
const rect = ref<{ top: number; left: number; width: number; height: number } | null>(null)
const vw = ref(1280)
const vh = ref(800)
const card = ref<HTMLElement | null>(null)
const cardH = ref(180)

// шаги, чьих элементов сейчас нет на странице (нет диалога, не вошли в панель), пропускаем
const live = ref<TourStep[]>([])
const step = computed(() => live.value[i.value])
const last = computed(() => i.value === live.value.length - 1)

function visible(sel?: string) {
  if (!sel) return null
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') return el
  }
  return null
}

function measure() {
  vw.value = window.innerWidth
  vh.value = window.innerHeight
  const el = visible(step.value?.target)
  if (!el) { rect.value = null; return }
  const r = el.getBoundingClientRect()
  const pad = 6
  rect.value = { top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 }
  if (card.value) cardH.value = card.value.offsetHeight
}

async function show(n: number) {
  i.value = n
  await nextTick()
  const el = visible(step.value?.target)
  if (el) {
    const r = el.getBoundingClientRect()
    if (r.top < 60 || r.bottom > window.innerHeight - 40) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  measure()
  // после плавной прокрутки элемент сдвинулся — перемерить
  setTimeout(measure, 350)
  await nextTick()
  card.value?.querySelector<HTMLElement>('.tour-next')?.focus({ preventScroll: true })
}

function start() {
  live.value = props.steps.filter(s => !s.target || visible(s.target))
  if (!live.value.length) return
  open.value = true
  show(0)
}

function close(clearQuery = true) {
  open.value = false
  try { localStorage.setItem(`tour:${props.id}`, '1') } catch {}
  if (clearQuery && route.query.tour) router.replace({ query: { ...route.query, tour: undefined } })
}

function go(d: number) {
  const n = i.value + d
  if (n < 0) return
  if (n >= live.value.length) return close()
  show(n)
}

function onKey(e: KeyboardEvent) {
  if (!open.value) return
  if (e.key === 'Escape') close()
  else if (e.key === 'ArrowRight') go(1)
  else if (e.key === 'ArrowLeft') go(-1)
}

let raf = 0
const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure) }

onMounted(() => {
  window.addEventListener('resize', onMove)
  window.addEventListener('scroll', onMove, true)
  window.addEventListener('keydown', onKey)
  let seen = false
  try { seen = !!localStorage.getItem(`tour:${props.id}`) } catch {}
  // дать странице дорисоваться (данные, шрифты), иначе подсветка встанет мимо
  if (route.query.tour === '1' || (props.auto && !seen)) setTimeout(start, 700)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onMove)
  window.removeEventListener('scroll', onMove, true)
  window.removeEventListener('keydown', onKey)
  cancelAnimationFrame(raf)
})

const narrow = computed(() => vw.value < 600)
// окно подсказки: под элементом, если не влезает — над, по горизонтали прижато к экрану
const cardStyle = computed(() => {
  const r = rect.value
  if (!r || narrow.value) return {}
  const W = 340, gap = 12
  const left = Math.max(16, Math.min(r.left, vw.value - W - 16))
  const below = r.top + r.height + gap
  const top = below + cardH.value < vh.value - 16 ? below : Math.max(16, r.top - gap - cardH.value)
  return { top: `${top}px`, left: `${left}px` }
})

function finish() {
  const to = props.next?.to
  close(!to)
  if (to) router.push(to)
}

// витрина: родитель с туром не пересоздаётся при переходе список → карточка, ловим ?tour=1 по ходу
watch(() => route.fullPath, () => {
  if (route.query.tour === '1') setTimeout(start, 700)
  else if (open.value) open.value = false
})

defineExpose({ start })
</script>

<template>
  <Teleport to="body">
    <Transition name="tour">
      <div v-if="open && step" class="tour" role="dialog" aria-modal="true" :aria-label="step.title">
        <div class="tour-catch" @click="close" />
        <div
          class="tour-hole"
          :class="{ none: !rect }"
          :style="rect ? { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` } : {}"
          aria-hidden="true"
        />
        <div
          ref="card"
          class="tour-card"
          :class="{ center: !rect && !narrow, sheet: narrow }"
          :style="cardStyle"
        >
          <p class="tour-count mono">{{ i + 1 }} / {{ live.length }}</p>
          <h2 class="tour-h">{{ step.title }}</h2>
          <p class="tour-text">{{ step.text }}</p>
          <div class="tour-bar">
            <button class="btn ghost sm" @click="close">{{ last ? 'Закрыть' : 'Пропустить' }}</button>
            <span class="tour-nav">
              <button v-if="i > 0" class="btn sm" @click="go(-1)">Назад</button>
              <button v-if="!last" class="btn primary sm tour-next" @click="go(1)">Дальше</button>
              <button v-else-if="next" class="btn primary sm tour-next" @click="finish">{{ next.label }}</button>
              <button v-else class="btn primary sm tour-next" @click="close">Попробовать</button>
            </span>
          </div>
          <div class="tour-dots" aria-hidden="true">
            <span v-for="(_, n) in live" :key="n" :class="{ on: n === i }" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tour {
  position: fixed;
  inset: 0;
  z-index: 100;
}

.tour-catch {
  position: absolute;
  inset: 0;
}

/* «дырка»: элемент виден, всё вокруг притемнено одной тенью */
.tour-hole {
  position: fixed;
  border-radius: 10px;
  box-shadow: 0 0 0 9999px rgba(17, 18, 20, 0.52), 0 0 0 2px rgba(255, 255, 255, 0.9) inset;
  pointer-events: none;
  transition: top 320ms var(--ease), left 320ms var(--ease), width 320ms var(--ease), height 320ms var(--ease);
}

.tour-hole.none {
  top: 50%;
  left: 50%;
  width: 0;
  height: 0;
}

.tour-card {
  position: fixed;
  width: 340px;
  padding: 16px 16px 12px;
  border-radius: 12px;
  background: var(--bg);
  box-shadow: 0 12px 40px rgba(17, 18, 20, 0.22), 0 0 0 1px rgba(17, 18, 20, 0.06);
  transition: top 320ms var(--ease), left 320ms var(--ease);
}

.tour-card.center {
  top: 50%;
  left: 50%;
  width: 400px;
  transform: translate(-50%, -50%);
  padding: 22px 22px 14px;
}

.tour-card.sheet {
  top: auto;
  left: 0;
  right: 0;
  bottom: 0;
  width: auto;
  border-radius: 14px 14px 0 0;
  padding: 18px 16px calc(12px + env(safe-area-inset-bottom));
}

.tour-count {
  margin: 0 0 6px;
  font-size: 11px;
  color: var(--ink-4);
}

.tour-h {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.center .tour-h { font-size: 18px; }

.tour-text {
  margin: 6px 0 0;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--ink-2);
}

.tour-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 14px;
}

.tour-nav {
  display: flex;
  gap: 6px;
}

.tour-dots {
  display: flex;
  justify-content: center;
  gap: 4px;
  margin-top: 10px;
}

.tour-dots span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--line-strong);
  transition: background 200ms var(--ease), width 200ms var(--ease);
}

.tour-dots span.on {
  width: 14px;
  border-radius: 3px;
  background: var(--indigo);
}

.tour-enter-active,
.tour-leave-active {
  transition: opacity 220ms var(--ease);
}

.tour-enter-from,
.tour-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .tour-hole,
  .tour-card { transition: none; }
}
</style>
