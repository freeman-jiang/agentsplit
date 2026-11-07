// Applies the saved theme before the first paint. It is a file, not an inline
// script, so the CSP needs no 'unsafe-inline'. Values: 'light', 'dark', or
// 'system' (the default), stored under 'theme' as in the current app.
;(function () {
  var media = window.matchMedia('(prefers-color-scheme: dark)')
  function apply() {
    var theme = null
    try {
      theme = localStorage.getItem('theme')
    } catch (e) {}
    var dark = theme === 'dark' || (theme !== 'light' && media.matches)
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }
  apply()
  media.addEventListener('change', apply)
  window.addEventListener('storage', function (event) {
    if (event.key === 'theme') apply()
  })
})()
