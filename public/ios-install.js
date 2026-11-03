// Aviso de instalación para iPhone/iPad Safari.
// iOS no tiene botón de "Instalar" como Chrome Android: la app se agrega con
// Compartir → "Agregar a pantalla de inicio". Este aviso solo aparece en un
// dispositivo iOS cuando la app corre en el navegador (no instalada todavía).
(function () {
  try {
    var ua = navigator.userAgent || '';
    var esIOS = /iPhone|iPad|iPod/i.test(ua);
    var yaInstalada = navigator.standalone === true
      || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    var yaVisto = localStorage.getItem('iosInstallHint.dismissed') === '1';
    if (!esIOS || yaInstalada || yaVisto) return;

    var bar = document.createElement('div');
    bar.id = 'iosInstallHint';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Cómo instalar la app en iPhone');
    bar.innerHTML = ''
      + '<button class="ios-hint-x" type="button" aria-label="Cerrar">✕</button>'
      + '<strong>Instalá procrastin-out en tu iPhone</strong>'
      + '<ol>'
      + '<li>Tocá el botón <span class="ios-hint-share">Compartir</span> <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v13"/><path d="M8 7l4-4 4 4"/><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/></svg> abajo de la barra de Safari.</li>'
      + '<li>Elegí <strong>“Agregar a pantalla de inicio”</strong>.</li>'
      + '<li>Tocá <strong>“Agregar”</strong> y listo: la app queda como ícono en tu pantalla.</li>'
      + '</ol>'
      + '<button class="ios-hint-ok" type="button">Ya la instalé</button>';

    var style = document.createElement('style');
    style.textContent = ''
      + '#iosInstallHint{position:fixed;left:12px;right:12px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:10000;'
      + 'background:rgba(13,37,28,.94);border:1px solid rgba(255,255,255,.14);border-radius:16px;color:#fff;'
      + 'font:13px/1.5 Manrope,system-ui,sans-serif;padding:14px 16px;box-shadow:0 18px 46px rgba(0,0,0,.5);'
      + 'backdrop-filter:blur(14px);} '
      + '#iosInstallHint::before{content:"";position:absolute;inset:0 0 auto 0;height:4px;border-radius:16px 16px 0 0;'
      + 'background:linear-gradient(90deg,#2E9D68,#E67E22,#1e9e57);} '
      + '#iosInstallHint strong{display:block;font-size:14px;margin:4px 0 8px;} '
      + '#iosInstallHint ol{margin:0 0 10px;padding-left:20px;} '
      + '#iosInstallHint li{margin:3px 0;} #iosInstallHint b{color:#4CC587;} '
      + '#iosInstallHint .ios-hint-share{color:#4CC587;font-weight:700;} '
      + '#iosInstallHint .ios-hint-ok{background:linear-gradient(135deg,#2E9D68,#E67E22);color:#fff;border:1px solid rgba(255,255,255,.22);'
      + 'border-radius:10px;padding:8px 12px;font-weight:800;font-size:13px;width:auto;cursor:pointer;} '
      + '#iosInstallHint .ios-hint-x{position:absolute;top:10px;right:10px;background:none;border:none;color:#9DB8AA;'
      + 'font-size:14px;cursor:pointer;padding:4px 8px;} '
      + '@media (min-width:720px){#iosInstallHint{left:auto;right:18px;bottom:18px;width:320px;}}';
    document.head.appendChild(style);
    document.body.appendChild(bar);

    function cerrar(forEver) {
      if (forEver) { try { localStorage.setItem('iosInstallHint.dismissed', '1'); } catch (e) {} }
      bar.remove();
    }
    bar.querySelector('.ios-hint-x').addEventListener('click', function () { cerrar(false); });
    bar.querySelector('.ios-hint-ok').addEventListener('click', function () { cerrar(true); });
  } catch (e) { /* nunca romper la página por el aviso */ }
})();
