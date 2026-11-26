import { defineConfig } from 'vitest/config'

// Тесты чистых модулей гоняются без Nuxt: tsconfig с project references (.nuxt/…) трансформеру не нужен.
export default defineConfig({
  oxc: { tsconfig: false },
  test: { include: ['tests/**/*.test.ts'] },
})
