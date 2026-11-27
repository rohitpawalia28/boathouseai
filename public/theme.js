// Light / dark theme. Runs before the page paints so there is no flash.
// A choice made with the toggle button is remembered on this device; until then we follow the phone/PC setting.
(function () {
  var KEY = 'bh-theme', root = document.documentElement, mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function saved() { try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch (e) { return null; } }
  function apply(t) {
    root.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'dark' ? '#06181d' : '#0a2f36');
  }
  function current() { return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
  apply(saved() || (mq && mq.matches ? 'dark' : 'light'));
  if (mq && mq.addEventListener) mq.addEventListener('change', function (e) { if (!saved()) apply(e.matches ? 'dark' : 'light'); });
  window.BHTheme = {
    get: current,
    toggle: function () {
      var t = current() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, t); } catch (e) {}
      apply(t); return t;
    }
  };
})();
