/*
 * Виджет консультанта для сайта магазина. Подключение — одна строка перед </body>:
 *
 *   <script src="https://<адрес стенда>/widget.js" async></script>
 *
 * Кнопка в углу открывает чат стенда во фрейме (/embed). Консультант получает адрес и название
 * открытой страницы: карточку товара сервер узнаёт по адресу (server/agent/page.ts), на остальных
 * страницах название — подсказка, о каком продукте вопрос. Query и hash адреса не передаём:
 * там бывают рекламные метки и личные данные. Стили изолированы shadow DOM; фрейм создаётся
 * только по нажатию — до этого виджет не делает ни одного запроса.
 */
(function () {
  'use strict'
  if (window.__kuznicaWidget) { window.__kuznicaWidget.open(); return }

  var script = document.currentScript || Array.prototype.slice.call(document.scripts).reverse()
    .find(function (s) { return /\/widget\.js(?:[?#]|$)/.test(s.src) })
  if (!script || !script.src) return
  var HOST = new URL(script.src, location.href).origin

  function clean(s) {
    return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  }

  // Название товара из разметки schema.org (Product.name) — точнее заголовка вкладки с «купить в интернет-магазине»
  function productName() {
    var nodes = document.querySelectorAll('script[type="application/ld+json"]')
    for (var i = 0; i < nodes.length; i++) {
      var d
      try { d = JSON.parse(nodes[i].textContent || '') } catch (e) { continue }
      var list = [].concat(d && d['@graph'] ? d['@graph'] : d)
      for (var j = 0; j < list.length; j++) {
        var x = list[j]
        var t = x && x['@type']
        if ((t === 'Product' || (Array.isArray(t) && t.indexOf('Product') >= 0)) && typeof x.name === 'string') return clean(x.name)
      }
    }
    return ''
  }

  function pageContext() {
    var h1 = document.querySelector('h1')
    var og = document.querySelector('meta[property="og:title"]')
    var title = productName() || clean(h1 && h1.textContent) || clean(og && og.content) || clean(document.title)
    return { url: location.origin + location.pathname, title: title }
  }

  var host = document.createElement('div')
  host.setAttribute('data-kuznica-widget', '')
  var root = host.attachShadow({ mode: 'open' })
  root.innerHTML = [
    '<style>',
    ':host{all:initial}',
    '.fab{position:fixed;right:20px;bottom:calc(20px + env(safe-area-inset-bottom));z-index:2147483000;display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 18px 0 14px;border:0;border-radius:22px;background:#5e6ad2;color:#fff;font:500 14px/1 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 6px 20px rgba(17,18,20,.22);cursor:pointer}',
    '.fab:hover{background:#4e5ac0}',
    '.fab:focus-visible{outline:2px solid #5e6ad2;outline-offset:3px}',
    '.fab svg{width:18px;height:18px;flex:none}',
    '.panel{position:fixed;right:20px;bottom:calc(76px + env(safe-area-inset-bottom));z-index:2147483000;width:400px;height:calc(100vh - 104px);height:min(680px,calc(100dvh - 104px));border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 12px 40px rgba(17,18,20,.24),0 0 0 1px rgba(17,18,20,.08)}',
    '.panel[hidden]{display:none}',
    'iframe{display:block;width:100%;height:100%;border:0;color-scheme:light}',
    '@media (max-width:520px){.panel{left:0;right:0;bottom:0;width:auto;height:min(86dvh,720px);border-radius:14px 14px 0 0}.fab.open{display:none}}',
    '</style>',
    '<button class="fab" type="button" aria-expanded="false" aria-controls="kz-panel">',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 4V5.5Z"/></svg>',
    '<span>Спросить консультанта</span>',
    '</button>',
    '<div class="panel" id="kz-panel" role="dialog" aria-label="Консультант" hidden></div>',
  ].join('')
  var fab = root.querySelector('.fab')
  var panel = root.querySelector('.panel')

  var frame = null
  var sentKey = ''
  var timer = 0

  function keyOf(p) { return p.url + '\n' + p.title }

  function sendPage() {
    if (!frame || !frame.contentWindow) return
    var p = pageContext()
    if (keyOf(p) === sentKey) return
    sentKey = keyOf(p)
    frame.contentWindow.postMessage({ type: 'kuznica:page', url: p.url, title: p.title }, HOST)
  }

  function open() {
    if (!frame) {
      var p = pageContext()
      sentKey = keyOf(p)
      frame = document.createElement('iframe')
      frame.title = 'Консультант'
      frame.setAttribute('allow', 'microphone')
      frame.src = HOST + '/embed?' + new URLSearchParams({ url: p.url, title: p.title }).toString()
      panel.appendChild(frame)
    } else {
      sendPage()
    }
    panel.hidden = false
    fab.classList.add('open')
    fab.setAttribute('aria-expanded', 'true')
    // Сайт может менять страницу без перезагрузки: пока чат открыт, раз в секунду сверяем адрес и название
    clearInterval(timer)
    timer = setInterval(sendPage, 1000)
  }

  function close() {
    panel.hidden = true
    fab.classList.remove('open')
    fab.setAttribute('aria-expanded', 'false')
    clearInterval(timer)
    fab.focus()
  }

  fab.addEventListener('click', function () { panel.hidden ? open() : close() })
  window.addEventListener('message', function (e) {
    if (e.origin !== HOST || !frame || e.source !== frame.contentWindow) return
    if (e.data && e.data.type === 'kuznica:close') close()
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden) close()
  })

  function mount() { document.body.appendChild(host) }
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount)

  window.__kuznicaWidget = { open: open, close: close }
})()
