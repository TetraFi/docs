// Guide mode: a guide page can show its steps "In the app" or "With the API" (Mintlify <View>).
// Mintlify offers the views as a dropdown, which hides that the other mode exists. This shows both
// modes side by side as a two-button switch in the dropdown's place and drives the (hidden) dropdown.
// It also keeps the reader's choice from page to page, opens a page in the mode a link names
// (?mode=app or ?mode=api), and opens guides in the API view for readers who come from the API reference.
(function () {
  var KEY = 'tetrafi-guide-mode';
  var MODES = ['app', 'api'];
  var TITLES = { app: 'In the app', api: 'With the API' };
  var NATIVE = 'tf-mode-native';
  var SWITCH = 'tf-mode-switch';

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
  function triggers() {
    return Array.prototype.slice.call(document.querySelectorAll('#multi-view-dropdown button[aria-haspopup]'));
  }
  function trigger() {
    var buttons = triggers();
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

  // The switch: one per Mintlify dropdown (there is one in the header and one in the right rail; CSS
  // shows the one that fits the width). It copies the dropdown's classes so it sits where it sat.
  function sync() {
    var button = trigger();
    var current = button && modeOf(shown(button));
    var switches = document.querySelectorAll('.' + SWITCH);
    for (var i = 0; i < switches.length; i++) {
      var options = switches[i].querySelectorAll('button[data-mode]');
      for (var j = 0; j < options.length; j++) {
        options[j].setAttribute('aria-checked', String(options[j].getAttribute('data-mode') === current));
      }
    }
  }
  function build(container) {
    var control = document.createElement('div');
    control.className = container.className.replace(/\bmulti-view-dropdown\b/g, '').replace(new RegExp('\\b' + NATIVE + '\\b', 'g'), '') + ' ' + SWITCH;
    control.setAttribute('role', 'radiogroup');
    control.setAttribute('aria-label', 'Show this guide');
    MODES.forEach(function (mode) {
      var option = document.createElement('button');
      option.type = 'button';
      option.setAttribute('role', 'radio');
      option.setAttribute('data-mode', mode);
      option.textContent = TITLES[mode];
      option.addEventListener('click', function () {
        write(mode);
        apply(30);
      });
      control.appendChild(option);
    });
    return control;
  }
  function ensureSwitches() {
    var buttons = triggers();
    var ours = buttons.some(function (button) { return modeOf(shown(button)); });
    if (!ours) return false;
    buttons.forEach(function (button) {
      var container = button.closest('#multi-view-dropdown');
      if (!container) return;
      var next = container.nextElementSibling;
      if (!next || !next.classList.contains(SWITCH)) container.after(build(container));
      container.classList.add(NATIVE);
      if (!button.__tfObserved) {
        button.__tfObserved = true;
        new MutationObserver(sync).observe(button, { attributes: true, attributeFilter: ['aria-label'] });
      }
    });
    sync();
    return true;
  }

  function apply(triesLeft) {
    var asked = new URLSearchParams(window.location.search).get('mode');
    if (TITLES[asked]) write(asked);
    var button = trigger();
    if (!button || !ensureSwitches()) {
      if (triesLeft > 0) setTimeout(function () { apply(triesLeft - 1); }, 100);
      return;
    }
    var wanted = TITLES[read()];
    if (!wanted || shown(button) === wanted) return;
    press(button);
    choose(wanted, 20);
  }

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
