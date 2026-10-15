/* IMAYX shared effects loader — one <script src="/assets/fx.js" defer></script> per page */
(function () {
  var d = document, h = d.documentElement;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var link = d.createElement('link');
  link.rel = 'stylesheet'; link.href = '/assets/fx.css';
  var started = false;
  function start() {
    if (started) return; started = true;
    h.classList.add('fx');
    var au = d.createElement('div');
    au.className = 'aurora-fx'; au.setAttribute('aria-hidden', 'true');
    au.innerHTML = '<b></b><b></b><b></b>';
    d.body.insertBefore(au, d.body.firstChild);
    if (!reduce) reveal();
    // cursor spotlight on cards
    d.addEventListener('pointermove', function (e) {
      var c = e.target.closest && e.target.closest('.card');
      if (!c) return;
      var r = c.getBoundingClientRect();
      c.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      c.style.setProperty('--my', (e.clientY - r.top) + 'px');
    }, { passive: true });
  }
  link.onload = start; link.onerror = function () { };
  d.head.appendChild(link);
  setTimeout(function () { if (!started && link.sheet) start(); }, 1500);

  function reveal() {
    var sel = '.hero .wrap > *, .hero > *, main > .pill, .sec > *, .card, .showcase, .stat div, .tl > div, h2, .btns';
    var seen = [], els = [];
    [].forEach.call(d.querySelectorAll(sel), function (el) {
      if (el.closest('nav, footer, header') || seen.indexOf(el) > -1) return;
      if (!el.getClientRects().length) return; // hidden (e.g. other-language block): leave untouched
      // skip an element if an ancestor is already being revealed
      for (var p = el.parentElement; p; p = p.parentElement) if (seen.indexOf(p) > -1) return;
      seen.push(el); els.push(el);
    });
    var counts = new Map();
    els.forEach(function (el) {
      var n = counts.get(el.parentElement) || 0; counts.set(el.parentElement, n + 1);
      el.style.setProperty('--d', Math.min(n * 0.08, 0.5) + 's');
      el.classList.add('rv');
    });
    function show(el) {
      el.classList.add('in');
      // once finished, hand the element back to its normal hover/transition rules
      setTimeout(function () { el.classList.remove('rv', 'in'); el.style.removeProperty('--d'); }, 1500);
    }
    if (!('IntersectionObserver' in window)) { els.forEach(show); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { io.unobserve(en.target); show(en.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    els.forEach(function (el) { io.observe(el); });
  }
})();
