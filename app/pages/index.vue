<script setup lang="ts">
import ChatPanel from '~/components/ChatPanel.vue'
import GuideTour from '~/components/GuideTour.vue'
import { TOUR_CHAT } from '~/utils/tour'

const shopName = useRuntimeConfig().public.shopName
const chat = ref<InstanceType<typeof ChatPanel> | null>(null)
const tour = ref<InstanceType<typeof GuideTour> | null>(null)
</script>

<template>
  <div class="chat-page">
    <header class="topbar">
      <div class="topbar-inner chat-inner">
        <div class="brand-group">
          <div class="brand-mark" aria-hidden="true">ДС</div>
          <span class="brand-name">{{ shopName }}</span>
        </div>
        <div class="topbar-right">
          <button v-if="chat?.messages.length" class="btn ghost sm" :disabled="chat?.busy" @click="chat?.restart()">
            Новый диалог
          </button>
          <button class="btn ghost sm hide-narrow" @click="tour?.start()">Как это устроено</button>
          <NuxtLink to="/shop" class="btn ghost sm">Витрина</NuxtLink>
          <NuxtLink to="/manager" class="btn ghost sm">Панель менеджера</NuxtLink>
        </div>
      </div>
    </header>

    <div class="chat-host">
      <ChatPanel ref="chat" />
    </div>
    <GuideTour ref="tour" id="chat" auto :steps="TOUR_CHAT" :next="{ label: 'Дальше: витрина', to: '/shop?tour=1' }" />
  </div>
</template>

<style scoped>
.chat-page {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.chat-inner {
  max-width: 780px;
  margin: 0 auto;
}

.chat-host {
  height: calc(100dvh - 48px);
}
</style>
