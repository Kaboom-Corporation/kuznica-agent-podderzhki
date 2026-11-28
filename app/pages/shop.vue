<script setup lang="ts">
import ChatPanel, { type ChatPage } from '~/components/ChatPanel.vue'

// Родитель витрины: чат живёт здесь и не пересоздаётся при переходе между списком и карточкой —
// диалог, прокрутка и набранный текст сохраняются. Дочерняя страница сообщает, что открыто.
const shopName = useRuntimeConfig().public.shopName
const page = useState<ChatPage | null>('shop-page', () => null)
const sheetOpen = useState('shop-chat-open', () => false)
const chat = ref<InstanceType<typeof ChatPanel> | null>(null)

const starters = computed(() => page.value
  ? ['Сколько будет стоить на 10 рабочих мест?', 'Есть ли российский аналог?', 'Подготовьте КП на эту позицию']
  : ['Нужен антивирус на 30 компьютеров', 'Чем заменить Microsoft Office?', 'Что есть из реестра отечественного ПО для бухгалтерии?'])

const route = useRoute()
watch(() => route.fullPath, () => { sheetOpen.value = false })
</script>

<template>
  <div class="shop">
    <header class="topbar">
      <div class="topbar-inner">
        <NuxtLink to="/shop" class="brand-group">
          <div class="brand-mark" aria-hidden="true">ДС</div>
          <span class="brand-name">{{ shopName }}</span>
        </NuxtLink>
        <div class="topbar-right">
          <NuxtLink to="/" class="btn ghost sm">Чат</NuxtLink>
          <NuxtLink to="/manager" class="btn ghost sm">Панель менеджера</NuxtLink>
        </div>
      </div>
    </header>

    <div class="shop-grid">
      <main class="shop-main">
        <NuxtPage />
      </main>

      <aside class="shop-chat" :class="{ open: sheetOpen }" aria-label="Консультант">
        <div class="sheet-head">
          <span class="status"><span class="status-dot ok" aria-hidden="true" />Консультант</span>
          <span class="sheet-tools">
            <button v-if="chat?.messages.length" class="btn ghost sm" :disabled="chat?.busy" @click="chat?.restart()">Новый диалог</button>
            <button class="btn ghost sm sheet-close" aria-label="Свернуть чат" @click="sheetOpen = false">Свернуть</button>
          </span>
        </div>
        <div class="shop-chat-body">
          <ChatPanel
            ref="chat"
            dock
            :page="page"
            :starters="starters"
            title="Консультант"
            intro="Спросите про цену на ваше число мест, наличие, сроки или аналоги — отвечу по каталогу и соберу черновик КП."
          />
        </div>
      </aside>
    </div>

    <button v-if="!sheetOpen" class="btn primary chat-fab" @click="sheetOpen = true">
      Спросить консультанта
    </button>
    <div v-if="sheetOpen" class="sheet-backdrop" aria-hidden="true" @click="sheetOpen = false" />
  </div>
</template>

<style scoped>
.shop {
  min-height: 100dvh;
  background: var(--bg-chrome);
}

.brand-group {
  text-decoration: none;
  color: inherit;
}

.shop-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 400px;
}

.shop-main {
  min-width: 0;
  padding: 24px 28px 64px;
}

.shop-chat {
  position: sticky;
  top: 48px;
  height: calc(100dvh - 48px);
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--line);
  background: var(--bg);
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 42px;
  padding: 0 10px 0 16px;
  border-bottom: 1px solid var(--line-soft);
  flex: none;
}

.sheet-tools {
  display: flex;
  gap: 4px;
}

.sheet-close {
  display: none;
}

.shop-chat-body {
  flex: 1;
  min-height: 0;
}

.chat-fab,
.sheet-backdrop {
  display: none;
}

@media (max-width: 960px) {
  .shop-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .shop-main {
    padding: 18px 16px 96px;
  }

  /* на телефоне чат — нижний лист поверх витрины */
  .shop-chat {
    position: fixed;
    inset: auto 0 0 0;
    top: auto;
    height: min(86dvh, 720px);
    border-left: 0;
    border-radius: 14px 14px 0 0;
    box-shadow: 0 -8px 32px rgba(17, 18, 20, 0.16);
    z-index: 40;
    transform: translateY(105%);
    visibility: hidden;
    transition: transform 280ms var(--ease), visibility 0s linear 280ms;
  }

  .shop-chat.open {
    transform: none;
    visibility: visible;
    transition: transform 280ms var(--ease);
  }

  .sheet-close {
    display: inline-flex;
  }

  .chat-fab {
    display: inline-flex;
    position: fixed;
    right: 16px;
    bottom: calc(16px + env(safe-area-inset-bottom));
    height: 40px;
    padding: 0 16px;
    border-radius: 20px;
    z-index: 30;
  }

  .sheet-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(17, 18, 20, 0.28);
    z-index: 35;
  }
}
</style>
