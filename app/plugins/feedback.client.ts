// Виджет сбора замечаний — только для внутренней проверки стенда.
// Грузится, если заданы NUXT_PUBLIC_FEEDBACK_SCRIPT и NUXT_PUBLIC_FEEDBACK_PROJECT
// и в этом браузере включён флаг: ?feedback=1 включает, ?feedback=0 выключает.
const FLAG = 'feedback-widget'

export default defineNuxtPlugin(() => {
  const { feedbackScript, feedbackProject } = useRuntimeConfig().public as Record<string, string>
  if (!feedbackScript || !feedbackProject) return

  const q = new URLSearchParams(location.search).get('feedback')
  try {
    if (q === '1') localStorage.setItem(FLAG, '1')
    if (q === '0') localStorage.removeItem(FLAG)
    if (localStorage.getItem(FLAG) !== '1') return
  } catch {
    if (q !== '1') return
  }

  if (document.querySelector('script[data-feedback-widget]')) return
  const s = document.createElement('script')
  s.src = feedbackScript
  s.async = true
  s.dataset.project = feedbackProject
  s.dataset.feedbackWidget = ''
  document.head.appendChild(s)
})
