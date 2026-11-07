// The offline page's retry button. A file, so the CSP needs no inline script.
document.getElementById('retry').addEventListener('click', function () {
  location.reload()
})
