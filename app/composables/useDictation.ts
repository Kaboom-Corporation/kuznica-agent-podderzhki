/**
 * Диктовка: запись с микрофона → /api/asr → распознанный текст.
 * Пока человек говорит, каждые ~2,5 с распознаём записанное с начала и показываем черновик (partial).
 * Запись останавливается кнопкой, сама после паузы в речи (SILENCE_MS) или через MAX_SEC.
 * Микрофон отпускаем сразу после записи.
 */
const MAX_SEC = 60
const SILENCE_MS = 1800 // пауза после речи → стоп
const NO_SPEECH_MS = 8000 // так и не заговорили → стоп
const LIVE_EVERY_MS = 2500

export type DictationState = 'idle' | 'recording' | 'recognizing'

export function useDictation(onText: (text: string) => void) {
  const state = ref<DictationState>('idle')
  const seconds = ref(0)
  const error = ref('')
  const supported = ref(false)
  /** промежуточный текст во время записи — окончательный придёт в onText */
  const partial = ref('')
  /** громкость 0..1 — для индикатора на кнопке */
  const level = ref(0)
  let rec: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let chunks: Blob[] = []
  let mime = ''
  let timer: ReturnType<typeof setInterval> | null = null
  let ac: AudioContext | null = null
  let meter: ReturnType<typeof setInterval> | null = null
  let liveTimer: ReturnType<typeof setInterval> | null = null
  let liveBusy = false
  let liveSent = 0
  let session = 0

  onMounted(() => {
    supported.value = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  })

  function release() {
    for (const t of [timer, meter, liveTimer]) if (t) clearInterval(t)
    timer = meter = liveTimer = null
    stream?.getTracks().forEach(t => t.stop())
    stream = null
    ac?.close().catch(() => {})
    ac = null
    level.value = 0
  }

  /** Safari пишет только mp4, Chrome и Firefox — webm/ogg с opus */
  function pickType(): string {
    for (const t of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) {
      if (MediaRecorder.isTypeSupported?.(t)) return t
    }
    return ''
  }

  // Тишина: уровень сравниваем с шумом комнаты, замеренным в первые ~0,4 с
  function watchSilence(s: MediaStream) {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctx) return
    try {
      ac = new Ctx()
      const src = ac.createMediaStreamSource(s)
      const an = ac.createAnalyser()
      an.fftSize = 1024
      src.connect(an)
      const buf = new Float32Array(an.fftSize)
      const t0 = Date.now()
      let floor = 0, samples = 0, spoke = false, lastVoice = Date.now()
      meter = setInterval(() => {
        an.getFloatTimeDomainData(buf)
        let sum = 0
        for (const v of buf) sum += v * v
        const rms = Math.sqrt(sum / buf.length)
        level.value = Math.min(1, rms * 12)
        const now = Date.now()
        if (now - t0 < 400) { floor += rms; samples++; return }
        const th = Math.max(0.012, (samples ? floor / samples : 0) * 2.5)
        if (rms > th) { spoke = true; lastVoice = now }
        else if (spoke && now - lastVoice > SILENCE_MS) stop()
        else if (!spoke && now - t0 > NO_SPEECH_MS) stop()
      }, 100)
    } catch {}
  }

  // Черновик: распознаём всё записанное с начала (кусок без начала файла не декодируется)
  async function live(id: number) {
    if (liveBusy || chunks.length === liveSent || state.value !== 'recording') return
    liveBusy = true
    liveSent = chunks.length
    try {
      const form = new FormData()
      form.append('file', new Blob(chunks, { type: mime.split(';')[0] }), 'voice')
      const r = await $fetch<{ text: string }>('/api/asr?live=1', { method: 'POST', body: form })
      if (id === session && state.value === 'recording' && r.text) partial.value = r.text
    } catch {
      // черновик — не главное: при ошибке просто ждём окончательный текст
    } finally {
      liveBusy = false
    }
  }

  async function start() {
    if (state.value !== 'idle') return
    error.value = ''
    partial.value = ''
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
    mime = rec.mimeType || type || 'audio/webm'
    chunks = []
    liveSent = 0
    const id = ++session
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    rec.onstop = () => upload(mime)
    rec.start(1000)
    state.value = 'recording'
    seconds.value = 0
    timer = setInterval(() => {
      seconds.value++
      if (seconds.value >= MAX_SEC) stop()
    }, 1000)
    watchSilence(stream)
    liveTimer = setInterval(() => live(id), LIVE_EVERY_MS)
  }

  function stop() {
    if (state.value !== 'recording' || !rec) return
    state.value = 'recognizing'
    release()
    rec.stop()
  }

  /** Отмена без распознавания (например, ушли со страницы) */
  function cancel() {
    session++
    if (rec && state.value === 'recording') {
      rec.onstop = null
      rec.stop()
    }
    release()
    partial.value = ''
    state.value = 'idle'
  }

  async function upload(type: string) {
    const blob = new Blob(chunks, { type: type.split(';')[0] })
    chunks = []
    rec = null
    if (blob.size < 1000) {
      state.value = 'idle'
      partial.value = ''
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
      // окончательное распознавание не прошло, а черновик есть — не теряем сказанное
      if (partial.value) onText(partial.value)
      else error.value = e?.data?.statusMessage || e?.statusMessage || 'Не получилось распознать речь — напишите текстом'
    } finally {
      partial.value = ''
      state.value = 'idle'
    }
  }

  function toggle() {
    if (state.value === 'idle') start()
    else if (state.value === 'recording') stop()
  }

  onBeforeUnmount(cancel)

  return { state, seconds, error, supported, partial, level, toggle, cancel, MAX_SEC }
}
