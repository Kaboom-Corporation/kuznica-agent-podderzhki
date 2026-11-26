/**
 * AI Provider interface — абстракция над LLM API.
 * Позволяет подключать Claude, OpenAI-совместимые модели и mock.
 */

export interface AIMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  /**
   * Текст сообщения. Для assistant-сообщения с нативными tool_calls контент
   * может быть пустым ('') — вся полезная нагрузка в tool_calls.
   */
  content: string
  /**
   * Нативные tool-calls ассистента (OpenAI function-calling). Сохраняем «сырой»
   * формат ответа модели, чтобы вернуть его обратно в следующий запрос как есть.
   * Только для role:'assistant'.
   */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  /** Идентификатор tool-call, на который отвечает это сообщение. Только для role:'tool'. */
  tool_call_id?: string
  /** Имя инструмента. Для role:'tool' — какой инструмент вернул результат. */
  name?: string
}

export type AITier = 'fast' | 'strong'

export interface AICompletionOptions {
  model?: string
  /**
   * Модель шлюза (RouterAI/OpenRouter), выбранная человеком: «anthropic/claude-opus-5.5», «openai/gpt-5.5».
   * Читает только поставщик openrouter. Остальные (ollama, прямой Anthropic, OpenAI) берут свою модель, чтобы
   * запасной поставщик не получил чужой id и не упал на нём.
   */
  gatewayModel?: string
  maxTokens?: number
  temperature?: number
  system?: string
  /** Запросить JSON output */
  jsonMode?: boolean
  /**
   * Пометить system-промпт кэшируемым (Anthropic prompt caching, cache_control).
   * Включать там, где system повторяется между вызовами: agentic loop,
   * многоходовой чат. Провайдеры без поддержки кэша флаг игнорируют.
   */
  cacheSystem?: boolean
  /**
   * Маркеры конца статичной части в первом user-сообщении (например, '=== КОНЕЦ ИТОГА ===',
   * '=== КОНЕЦ ДОКУМЕНТА ==='). При cacheSystem на Claude префикс до маркера помечается
   * вторым cache_control: ephemeral, чтобы повторные вопросы по документу попадали в cache read.
   */
  cacheUserMarkers?: readonly string[]
  /**
   * Динамический хвост system (текущая дата и т.п.): добавляется ПОСЛЕ основного system и не входит в
   * кэшируемый блок, поэтому его смена не сбрасывает кэш основной части (cache_control ставится только на
   * `system`). Без cacheSystem просто приклеивается к system через пустую строку.
   */
  systemTail?: string
  /**
   * Тир задачи для каскада: 'strong' — тяжёлая (оркестратор, агентный loop) → облачную
   * модель первой (ollama 7B таймаутит на больших промптах); 'fast'/undefined — обычный
   * порядок (local-first ollama, дёшево). См. CascadingProvider.
   */
  tier?: AITier
  /**
   * Не размышлять. Claude 5.x через OpenRouter-совместимый шлюз сами решают, размышлять ли; размышление не видно,
   * но оплачивается и съедает тот же max_tokens (14.11.2026: обзор «документов по делу» потратил ~13 000 из 16 000
   * токенов и оборвался). Выключить его шлюз не даёт, поэтому шлём reasoning.effort=low (request-shape.thinkingFields, замер 25.11.2026)
   * и только моделям, которые размышляют (outputTokenFloor > 0).
   * Прочие провайдеры поле не читают.
   */
  noThinking?: boolean
  /**
   * Per-request timeout в миллисекундах.
   * Если не указан — используется default провайдера (30 секунд).
   * Long-running calls (orchestrator agentic loop, knowledge RAG chat) могут
   * передавать большее значение, например 90000 для разовых cases.
   */
  timeoutMs?: number
  /**
   * Внешняя отмена запроса: общий дедлайн вызывающего (оценка тендера, отклик, ТЗ), закрытый клиент и т.п.
   * Провайдер обрывает сам HTTP-запрос к модели, а не только перестаёт ждать ответ: иначе модель дописывает
   * ответ «в пустоту» и токены списываются зря. Действует вместе с timeoutMs — запрос обрывается по тому,
   * что наступит раньше. Каскад по отменённому сигналу не идёт к следующему провайдеру и не считает отмену
   * сбоем провайдера (см. CascadingProvider).
   */
  signal?: AbortSignal
  /**
   * Строгий поток, только для completeStream (сейчас юридические вызовы, law-base/model-call.ts). Обрыв при тишине
   * дольше silenceMs, jsonMode как в complete; поток без конца, ошибка в потоке и пустой ответ — ошибка, а не результат.
   * Без этого поля completeStream ведёт себя как раньше. complete поле не читает.
   */
  strictStream?: { silenceMs: number }
  /**
   * Только для completeStream. Каскад зовёт его, когда поток перезапускается у следующего поставщика ПОСЛЕ того,
   * как предыдущая попытка уже отдала хотя бы одну дельту: вызывающий должен сбросить накопленный текст,
   * иначе начало ответа задвоится.
   */
  onStreamRestart?: () => void
  /**
   * Общий дедлайн вызывающего — момент времени в мс (как Date.now()). Таймаут одной попытки не превысит остаток
   * до него, а без явного timeoutMs попытке достаётся весь остаток (а не 30 с по умолчанию у провайдера).
   * Не задан — поведение прежнее. В отличие от signal не обрывает уже идущий запрос по внешнему событию.
   */
  deadlineMs?: number
  /**
   * Нативные определения инструментов (OpenAI function-calling). Если заданы —
   * провайдер, умеющий function-calling (OpenAI-совместимый), пробросит их в body
   * и вернёт распознанные вызовы в AICompletionResult.toolCalls. Провайдеры без
   * поддержки (anthropic-обёртка, mock, ollama) флаг игнорируют.
   */
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: object } }>
  /** Стратегия выбора инструмента: 'auto' (деф) | 'none' | 'required'. */
  toolChoice?: 'auto' | 'none' | 'required'
}

export interface AICompletionResult {
  text: string
  inputTokens: number
  outputTokens: number
  /**
   * Сколько входных токенов провайдер прочитал из кэша промпта. Это ЧАСТЬ inputTokens, а не добавка к нему:
   * inputTokens остаётся полным входом вызова, поэтому журналы и прежние расчёты не меняются. Нужно бюджету цикла:
   * чтение из кэша стоит 0,1 обычного входного токена, а постоянная часть запроса агента (system + описания
   * инструментов, десятки тысяч токенов) кэшируется целиком (см. billableInputTokens в run-budget.ts).
   * Провайдер без разбивки (mock, посредник, который её не отдаёт) оставляет поле undefined.
   */
  cachedInputTokens?: number
  /** Сколько входных токенов записано в кэш промпта. Тоже ЧАСТЬ inputTokens; запись стоит 1,25 обычного входа. */
  cacheWriteInputTokens?: number
  model: string
  /**
   * Кто ответил: имя поставщика в каскаде (ollama / openrouter / anthropic / gateway …). Нужно пайплайну для лога и
   * аудита: в каскаде заранее неизвестно, на ком он закончился. Не заполнено — поставщик не сообщил.
   */
  provider?: string
  /**
   * true, если модель остановилась НЕ сама, а упёрлась в предел выходных токенов (Anthropic stop_reason=max_tokens,
   * OpenAI-совместимые finish_reason=length): текст оборван на полуслове. Провайдер при этом НЕ падает и текст отдаёт,
   * как раньше — остальной код ведёт себя прежним образом; решать, что делать с обрывом, должен вызывающий.
   * Нужно там, где оборванный ответ опасен тихим «успехом» (разбор договора: починенный JSON теряет часть рисков).
   * undefined/false — ответ закончен моделью.
   */
  truncated?: boolean
  /**
   * true, если модель ОТКАЗАЛАСЬ отвечать (Anthropic stop_reason=refusal, OpenAI-совместимые finish_reason=content_filter),
   * а текст есть (частичный) или пуст. По образцу truncated: провайдер не падает, остальной код поле не читает.
   * Если текста нет вовсе, провайдер бросает ошибку с признаком refused (ai/refusal.ts). undefined/false — не отказ.
   */
  refused?: boolean
  /**
   * Вход урезан поставщиком: он прочитал заметно меньше токенов, чем в промпте (Ollama обрезает промпт до окна).
   * Оценка грубая (символы / 3,5), см. detectInputTruncation.
   */
  inputTruncated?: boolean
  /** true, если ответ сгенерирован mock-провайдером (реальные AI-ключи не настроены) */
  mock?: boolean
  /**
   * Нативные tool-calls, запрошенные моделью (OpenAI function-calling).
   * arguments уже распарсен из JSON-строки в объект. Пусто/undefined — модель
   * инструменты не вызывала (значит text — финальный ответ).
   */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  /**
   * «Сырые» tool_calls из ответа провайдера (для повторной отправки в историю
   * как assistant.tool_calls без пересборки).
   */
  rawToolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

export interface AIProvider {
  readonly name: string
  complete(messages: AIMessage[], options?: AICompletionOptions): Promise<AICompletionResult>
  /**
   * Стриминговая генерация: текст приходит по мере генерации через onDelta(chunk).
   * Возвращает полный результат (text+токены), как complete.
   *
   * Опционально: провайдеры без поддержки SSE его не реализуют. Вызывающий код
   * (CascadingProvider) грейсфул-фоллбэчит на complete + один onDelta(весь текст).
   */
  completeStream?(
    messages: AIMessage[],
    options: AICompletionOptions | undefined,
    onDelta: (chunk: string) => void,
  ): Promise<AICompletionResult>
}
