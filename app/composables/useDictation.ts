/**
 * Диктовка: запись с микрофона → /api/asr → распознанный текст.
 * Запись останавливается кнопкой или сама через MAX_SEC. Микрофон отпускаем сразу после записи.
 */
const MAX_SEC = 60

export type DictationState = 'idle' | 'recording' | 'recognizing'

export function useDictation(onText: (text: string) => void) {
  const state = ref<DictationState>('idle')
  const seconds = ref(0)
  const error = ref('')
  const supported = ref(false)
  let rec: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let chunks: Blob[] = []
  let timer: ReturnType<typeof setInterval> | null = null

  onMounted(() => {
    supported.value = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  })

  function release() {
    if (timer) clearInterval(timer)
    timer = null
    stream?.getTracks().forEach(t => t.stop())
    stream = null
  }

  /** Safari пишет только mp4, Chrome и Firefox — webm/ogg с opus */
  function pickType(): string {
    for (const t of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) {
      if (MediaRecorder.isTypeSupported?.(t)) return t
    }
    return ''
  }

  async function start() {
    if (state.value !== 'idle') return
    error.value = ''
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch (e: any) {
      error.value = e?.name === 'NotAllowedError'
        ? 'Нет доступа к микрофону — разрешите его в настройках браузера'
        : 'Микрофон не найден'
      return
    }
    const type = pickType()
    rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    chunks = []
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    rec.onstop = () => upload(rec?.mimeType || type || 'audio/webm')
    rec.start()
    state.value = 'recording'
    seconds.value = 0
    timer = setInterval(() => {
      seconds.value++
      if (seconds.value >= MAX_SEC) stop()
    }, 1000)
  }

  function stop() {
    if (state.value !== 'recording' || !rec) return
    state.value = 'recognizing'
    release()
    rec.stop()
  }

  /** Отмена без распознавания (например, ушли со страницы) */
  function cancel() {
    if (rec && state.value === 'recording') {
      rec.onstop = null
      rec.stop()
    }
    release()
    state.value = 'idle'
  }

  async function upload(mime: string) {
    const blob = new Blob(chunks, { type: mime.split(';')[0] })
    chunks = []
    rec = null
    if (blob.size < 1000) {
      state.value = 'idle'
      error.value = 'Запись пустая — нажмите и говорите'
      return
    }
    const form = new FormData()
    form.append('file', blob, 'voice')
    try {
      const r = await $fetch<{ text: string }>('/api/asr', { method: 'POST', body: form })
      if (r.text) onText(r.text)
      else error.value = 'Не расслышал — попробуйте ещё раз ближе к микрофону'
    } catch (e: any) {
      error.value = e?.data?.statusMessage || e?.statusMessage || 'Не получилось распознать речь — напишите текстом'
    } finally {
      state.value = 'idle'
    }
  }

  function toggle() {
    if (state.value === 'idle') start()
    else if (state.value === 'recording') stop()
  }

  onBeforeUnmount(cancel)

  return { state, seconds, error, supported, toggle, cancel, MAX_SEC }
}
