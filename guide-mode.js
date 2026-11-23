// Guide mode: a guide page can show its steps "In the app" or "With the API" (Mintlify <View>).
// This keeps the reader's choice from page to page and opens a page in the mode a link names
// (?mode=app or ?mode=api). A reader who comes from the API reference is a developer: guides open
// in the API view for them.
(function () {
  var KEY = 'tetrafi-guide-mode';
  var TITLES = { app: 'In the app', api: 'With the API' };

  function read() {
    try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function write(mode) {
    try { window.localStorage.setItem(KEY, mode); } catch (e) { /* private window: per page only */ }
  }
  function modeOf(title) {
    for (var mode in TITLES) if (TITLES[mode] === title) return mode;
    return null;
  }
  function trigger() {
    var buttons = document.querySelectorAll('#multi-view-dropdown button[aria-haspopup]');
    for (var i = 0; i < buttons.length; i++) if (buttons[i].offsetParent !== null) return buttons[i];
    return buttons[0] || null;
  }
  function shown(button) {
    return (button.getAttribute('aria-label') || '').replace(/^Switch view:\s*/, '');
  }
  function press(element) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
      var Event = type.indexOf('pointer') === 0 && window.PointerEvent ? window.PointerEvent : window.MouseEvent;
      element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, button: 0 }));
    });
  }
  function choose(title, triesLeft) {
    var items = document.querySelectorAll('[role^="menuitem"]');
    for (var i = 0; i < items.length; i++) {
      if (items[i].textContent.trim() === title) { press(items[i]); return; }
    }
    if (triesLeft > 0) setTimeout(function () { choose(title, triesLeft - 1); }, 50);
  }
  function apply(triesLeft) {
    var asked = new URLSearchParams(window.location.search).get('mode');
    if (TITLES[asked]) write(asked);
    var wanted = TITLES[read()];
    if (!wanted) return;
    var button = trigger();
    if (!button) {
      if (triesLeft > 0) setTimeout(function () { apply(triesLeft - 1); }, 100);
      return;
    }
    if (shown(button) === wanted) return;
    press(button);
    choose(wanted, 20);
  }
  // Remember the mode the reader picks in the dropdown.
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest || !target.closest('[role^="menuitem"], #multi-view-dropdown')) return;
    setTimeout(function () {
      var button = trigger();
      var mode = button && modeOf(shown(button));
      if (mode) write(mode);
    }, 300);
  }, true);

  var REFERENCE = /^\/api-reference(\/|$)/;
  var lastPath = window.location.pathname;
  try {
    var from = new URL(document.referrer);
    if (from.host === window.location.host && REFERENCE.test(from.pathname)) write('api');
  } catch (e) { /* no referrer */ }

  apply(30);
  window.addEventListener('mintlify:navigate', function (event) {
    if (REFERENCE.test(lastPath)) write('api');
    lastPath = (event.detail && event.detail.path) || window.location.pathname;
    apply(30);
  });
})();
