// Nuxt 4 + Nitro: веб-чат клиента, панель менеджера и API агента в одном процессе.
export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  devtools: { enabled: false },
  app: {
    head: {
      htmlAttrs: { lang: 'ru' },
      title: 'Агент поддержки — консультация, КП, счёт',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap' },
      ],
    },
  },
  css: ['~/assets/ui.css'],
  nitro: {
    // Шрифты для PDF счёта/КП кладём в серверные ассеты (useStorage('assets:fonts')).
    serverAssets: [{ baseName: 'fonts', dir: './assets/fonts' }],
    experimental: { tasks: true },
    scheduledTasks: {
      // Опрос входящей почты (IMAP), если настроен.
      '*/1 * * * *': ['mail:poll'],
      // Каталог из фида магазина раз в сутки: 01:00 UTC = 04:00 МСК, когда обращений меньше всего.
      '0 1 * * *': ['feed:refresh'],
    },
  },
  runtimeConfig: {
    databaseUrl: '',
    // Модель агента — только открытые веса; выбор в server/agent/llm.ts по NUXT_LLM_PROVIDER / NUXT_OLLAMA_MODEL
    // (по умолчанию Ollama, qwen3.5:9b). Шлюз — NUXT_LLM_BASE_URL + NUXT_LLM_API_KEY + NUXT_LLM_MODEL.
    // Эмбеддинги: OpenAI-совместимый /embeddings (Ollama локально по умолчанию — ПДн не уходят наружу).
    embedBaseUrl: 'http://localhost:11434/v1',
    embedApiKey: '',
    embedModel: 'bge-m3',
    embedDim: 1024,
    // Почта
    smtpHost: '', smtpPort: 465, smtpUser: '', smtpPass: '', smtpFrom: '',
    imapHost: '', imapPort: 993, imapUser: '', imapPass: '',
    // Продавец на документах — вымышленное «ООО Демо», реальные реквизиты в репозиторий не кладём.
    sellerName: 'ООО «Демо Софт»',
    sellerInn: '7700000000',
    sellerKpp: '770001001',
    sellerAddress: '123456, г. Москва, ул. Примерная, д. 1',
    sellerBank: 'АО «Демо-Банк»',
    sellerBik: '044500000',
    sellerAccount: '40702810000000000000',
    sellerCorrAccount: '30101810000000000000',
    vatPercent: 22,
    // Пустой токен = панель менеджера закрыта (fail-closed). Задать NUXT_MANAGER_TOKEN.
    managerToken: '',
    // Товарный фид магазина (YML, можно .gz), обновление раз в сутки. Пусто = не обновлять.
    feedUrl: '',
    // Распознавание речи — своя модель (OpenAI-совместимый /v1/audio/transcriptions). Пусто = диктовка выключена.
    asrUrl: '',
    // Канал Telegram: пустой токен = канал выключен. Секрет вебхука обязателен, адрес API — свой прокси или официальный.
    telegramBotToken: '',
    telegramWebhookSecret: '',
    telegramApiUrl: 'https://api.telegram.org',
    public: {
      shopName: 'Демо Софт — магазин лицензий',
      // Виджет сбора замечаний для внутренней проверки стенда. Пусто = выключен.
      // Включается в браузере ссылкой с ?feedback=1, выключается ?feedback=0.
      feedbackScript: '',
      feedbackProject: '',
      // Кнопка диктовки в чате; включать вместе с NUXT_ASR_URL
      voiceInput: false,
    },
  },
})
