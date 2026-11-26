// Нарезка текста на чанки с перекрытием

interface ChunkOptions {
  chunkSize?: number   // Примерное кол-во символов на чанк (~512 токенов ≈ 2000 символов)
  overlap?: number     // Перекрытие между чанками в символах
  minLength?: number   // Чанки короче отбрасываются (по умолчанию 50)
}

const DEFAULT_CHUNK_SIZE = 2000
const DEFAULT_OVERLAP = 200
const MIN_CHUNK_LENGTH = 50   // Чанки короче — мусор (заголовки, обрывки разметки)

/**
 * Жёсткая нарезка фрагмента без границ предложений: транскрипт созвона одним
 * абзацем, дамп без пунктуации, слипшийся HTML→текст. Режем по границам слов,
 * а если слова длиннее лимита (сплошной поток) — по символам.
 * Это фолбэк: вызывается только когда границ предложений уже не осталось.
 */
function hardSplit(text: string, maxLen: number): string[] {
  const parts: string[] = []
  let rest = text

  while (rest.length > maxLen) {
    // Последний пробел в пределах лимита — чтобы не рвать слово посередине.
    // Если пробела нет или он слишком близко к началу (длинное «слово»),
    // режем ровно по лимиту: важнее гарантия длины, чем красота границы.
    let cut = rest.lastIndexOf(' ', maxLen)
    if (cut < maxLen / 2) cut = maxLen

    const part = rest.slice(0, cut).trim()
    if (part) parts.push(part)
    rest = rest.slice(cut).trim()
  }

  if (rest) parts.push(rest)
  return parts
}

/**
 * Разбивает сверхдлинный абзац на сегменты не длиннее maxLen: сначала по границам
 * предложений (сохраняем осмысленные границы), а предложения, которые сами длиннее
 * лимита, — жёстко через hardSplit().
 */
function splitOversized(text: string, maxLen: number): string[] {
  const segments: string[] = []
  let buffer = ''

  const flush = () => {
    const trimmed = buffer.trim()
    if (trimmed) segments.push(trimmed)
    buffer = ''
  }

  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (!sentence) continue

    if (sentence.length > maxLen) {
      // Границ предложений внутри нет — уходим в жёсткую нарезку
      flush()
      segments.push(...hardSplit(sentence, maxLen))
      continue
    }

    if (buffer.length + sentence.length + 1 <= maxLen) {
      buffer += (buffer ? ' ' : '') + sentence
    } else {
      flush()
      buffer = sentence
    }
  }

  flush()
  return segments
}

/**
 * Нарезает текст на чанки по абзацам с перекрытием.
 *
 * Гарантия: ни один чанк не длиннее chunkSize — даже если в тексте нет ни абзацев,
 * ни предложений. Иначе длинный текст одним куском эмбеддился бы только по началу —
 * середина и конец в вектор не попадали и не находились поиском.
 */
export function chunkText(text: string, options?: ChunkOptions): string[] {
  const chunkSize = options?.chunkSize || DEFAULT_CHUNK_SIZE
  const overlap = options?.overlap || DEFAULT_OVERLAP

  // Разбиваем по двойным переносам (абзацы) или одинарным если абзацев мало
  let paragraphs = text.split(/\n\n+/)
  if (paragraphs.length <= 1) {
    paragraphs = text.split(/\n/)
  }

  // Лимит для нарезки сверхдлинных абзацев: оставляем место под перекрытие,
  // чтобы чанк «хвост предыдущего + сегмент» не вылезал за chunkSize
  const segmentLimit = Math.max(Math.floor(chunkSize / 2), chunkSize - overlap - 2)

  // Разворачиваем абзацы в единицы сборки: обычные абзацы идут как есть
  // (границы сохраняются), сверхдлинные — предварительно нарезаются
  const units: string[] = []
  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue

    if (trimmed.length > chunkSize) {
      units.push(...splitOversized(trimmed, segmentLimit))
    } else {
      units.push(trimmed)
    }
  }

  const chunks: string[] = []
  let currentChunk = ''

  for (const unit of units) {
    // Если текущий чанк + единица не превышают лимит — добавляем
    if (currentChunk.length + unit.length + 2 <= chunkSize) {
      currentChunk += (currentChunk ? '\n\n' : '') + unit
      continue
    }

    if (currentChunk) {
      chunks.push(currentChunk)
      // Берём хвост текущего чанка как перекрытие — но только если он влезает
      // вместе со следующей единицей, иначе нарушим гарантию длины
      const tail = overlap > 0
        ? (currentChunk.length > overlap ? currentChunk.slice(-overlap) : currentChunk)
        : ''
      currentChunk = tail && tail.length + unit.length + 2 <= chunkSize
        ? tail + '\n\n' + unit
        : unit
    } else {
      currentChunk = unit
    }
  }

  // Сохраняем последний чанк
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim())
  }

  // Фильтруем слишком короткие чанки — мусор
  const min = options?.minLength ?? MIN_CHUNK_LENGTH
  return chunks.filter(c => c.length >= min)
}

export interface MarkdownChunk {
  /** Заголовок раздела `##` (без решёток); null — текст до первого заголовка. */
  heading: string | null
  content: string
}

/**
 * Нарезка markdown по заголовкам `##`: каждый раздел режется chunkText() с перекрытием внутри раздела
 * (между разделами перекрытия нет — граница раздела смысловая). Заголовок `#` в начале файла — название документа,
 * в чанки не идёт. Короткие разделы (карточка FAQ в две строки) сохраняются: порог длины здесь 20 символов.
 */
export function chunkMarkdown(markdown: string, options?: ChunkOptions): MarkdownChunk[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const sections: Array<{ heading: string | null, body: string[] }> = [{ heading: null, body: [] }]
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    // без пересекающихся квантификаторов (было /^##\s+(.+?)\s*#*\s*$/ — полиномиальный перебор на длинной строке)
    const h = !inFence ? /^##[ \t]+(.*)$/.exec(line) : null
    const heading = h ? h[1]!.replace(/[\s#]+$/, '') : ''
    if (h && heading) {
      sections.push({ heading, body: [] })
      continue
    }
    if (!inFence && /^#\s+/.test(line) && sections.length === 1 && !sections[0]!.body.some(l => l.trim())) continue
    sections[sections.length - 1]!.body.push(line)
  }

  const out: MarkdownChunk[] = []
  for (const s of sections) {
    const text = s.body.join('\n').trim()
    if (!text) continue
    for (const content of chunkText(text, { minLength: 20, ...options })) {
      out.push({ heading: s.heading, content })
    }
  }
  return out
}
