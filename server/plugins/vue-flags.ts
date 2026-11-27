/**
 * vue-router в серверной сборке читает флаг __VUE_OPTIONS_API__, который Vite подставляет только в браузерный код.
 * В Node его никто не задаёт — страница падала с ReferenceError. Задаём до первой отрисовки.
 * Имена собраны из частей: иначе сборщик сам подменяет `__VUE_…__` на значения и присваивание теряется.
 */
const g = globalThis as Record<string, unknown>
const flags: Record<string, boolean> = {
  OPTIONS_API: true,
  PROD_DEVTOOLS: false,
  PROD_HYDRATION_MISMATCH_DETAILS: false,
}
for (const [name, value] of Object.entries(flags)) {
  const key = '__' + 'VUE_' + name + '__'
  if (g[key] === undefined) g[key] = value
}

export default defineNitroPlugin(() => {})
