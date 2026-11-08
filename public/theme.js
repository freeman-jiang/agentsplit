// The theme preference, kept in this browser under 'theme' as in the current
// app: 'light', 'dark', or 'system' (the default). This file applies it before
// the first paint and gives the app window.agentsplitTheme (src/client/theme.ts).
// It is a file, not an inline script, so the CSP needs no 'unsafe-inline'.
;(function () {
  var KEY = 'theme'
  var media = window.matchMedia('(prefers-color-scheme: dark)')
  // The page background of each theme (styles.css), for the browser and status bar.
  var BACKGROUND = { light: '#ffffff', dark: '#141414' }
  function read() {
    var value = null
    try {
      value = localStorage.getItem(KEY)
    } catch (e) {}
    return value === 'light' || value === 'dark' ? value : 'system'
  }
  function apply() {
    var theme = read()
    var dark = theme === 'dark' || (theme === 'system' && media.matches)
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    // index.html has one theme-color per colour scheme. A chosen theme sets both,
    // so the bar matches the page whatever the system scheme is.
    var metas = document.querySelectorAll('meta[name="theme-color"]')
    for (var i = 0; i < metas.length; i++) {
      var forScheme = metas[i].media.indexOf('dark') >= 0 ? 'dark' : 'light'
      metas[i].content = BACKGROUND[theme === 'system' ? forScheme : theme]
    }
  }
  apply()
  media.addEventListener('change', apply)
  window.addEventListener('storage', function (event) {
    if (event.key === KEY) apply()
  })
  window.agentsplitTheme = {
    read: read,
    save: function (theme) {
      localStorage.setItem(KEY, theme)
      apply()
    },
  }
})()
