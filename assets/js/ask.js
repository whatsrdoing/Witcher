/* Admin-only data assistant -- a real, billed call to Anthropic per
 * question (see set_llm.py / assistant.py). Lives as its own floating
 * widget rather than a card inside the admin panel, so it's reachable
 * from any screen, not just #/admin -- gated by ParasAdmin.isAdmin(),
 * same check the admin panel itself already relies on, so a non-admin
 * account never even gets the widget added to the layout.
 *
 * Its own small file for the same reason as feedback.js/twofactor.js:
 * a couple of dedicated endpoints (__admin/ask/status, __admin/ask,
 * __admin/ask/usage) that app.js does not need to know about beyond
 * wiring one script tag in. */
(function (w, d) {
  'use strict';

  var $ = function (s, r) { return (r || d).querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { ok: r.ok, status: r.status, body: j };
      });
    });
  }

  var enabled = false;
  var open = false;
  var statusChecked = false;

  // Model choice sticks like Claude.ai's own picker: pick Sonnet, it
  // stays Sonnet on every question -- across panel opens, across page
  // reloads -- until deliberately switched back. Per-browser (localStorage),
  // not server state: it's a per-question override, never touches the
  // server's configured default (see llm.py's messages_create `model` arg).
  var MODEL_LABELS = { 'claude-opus-5': 'Opus 5', 'claude-sonnet-5': 'Sonnet 5' };
  var DEFAULT_MODEL = 'claude-opus-5';
  var currentModel = DEFAULT_MODEL;
  try {
    var stored = localStorage.getItem('parasAskModel');
    if (stored && MODEL_LABELS[stored]) currentModel = stored;
  } catch (e) { /* private browsing etc -- just use the default */ }

  function setModel(id) {
    if (!MODEL_LABELS[id]) return;
    currentModel = id;
    $('#askModelLabel').textContent = MODEL_LABELS[id];
    $$('.ask-model-opt').forEach(function (opt) {
      opt.classList.toggle('active', opt.dataset.model === id);
    });
    try { localStorage.setItem('parasAskModel', id); } catch (e) { /* ignore */ }
  }

  function $$(s, r) { return Array.prototype.slice.call((r || d).querySelectorAll(s)); }

  function closeModelMenu() {
    $('#askModelPicker').classList.remove('open');
    $('#askModelBtn').setAttribute('aria-expanded', 'false');
  }

  function toggleModelMenu(e) {
    if (e) e.stopPropagation();
    var picker = $('#askModelPicker');
    var willOpen = !picker.classList.contains('open');
    picker.classList.toggle('open', willOpen);
    $('#askModelBtn').setAttribute('aria-expanded', String(willOpen));
  }

  function fmtTokens(n) {
    n = n || 0;
    return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
  }

  function fmtCost(x) {
    x = x || 0;
    if (x === 0) return '$0';
    return x < 0.01 ? '<$0.01' : '$' + x.toFixed(2);
  }

  function refreshUsageBar() {
    fetch('__admin/ask/usage', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var el = $('#askUsageText');
        if (!el) return;
        if (!j) { el.textContent = '—'; return; }
        el.textContent = 'Today ' + fmtTokens(j.today.tokens) + ' tok (~' + fmtCost(j.today.cost) +
          ') · This month ' + fmtTokens(j.month.tokens) + ' tok (~' + fmtCost(j.month.cost) + ')';
      })
      .catch(function () { /* leave whatever was last shown */ });
  }

  function checkStatus() {
    return fetch('__admin/ask/status', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { enabled: false }; })
      .then(function (j) {
        statusChecked = true;
        enabled = !!(j && j.enabled);
        $('#askDot').classList.toggle('on', enabled);
        $('#askStatusLine').textContent = enabled ? 'Ready' : 'Not set up';
        $('#askOff').style.display = enabled ? 'none' : '';
        $('#askBody').style.display = enabled ? '' : 'none';
        if (enabled) refreshUsageBar();
        return enabled;
      })
      .catch(function () {
        statusChecked = true;
        enabled = false;
        $('#askDot').classList.remove('on');
        $('#askStatusLine').textContent = 'Unavailable';
        $('#askOff').style.display = '';
        $('#askBody').style.display = 'none';
        return false;
      });
  }

  function openPanel() {
    if (open) return;
    open = true;
    var widget = $('#askWidget');
    widget.classList.add('open');
    $('#askFab').setAttribute('aria-expanded', 'true');
    $('#askPanel').setAttribute('aria-hidden', 'false');
    if (!statusChecked) checkStatus();
    setTimeout(function () { var i = $('#askInput'); if (i && enabled) i.focus(); }, 260);
  }

  function closePanel() {
    if (!open) return;
    open = false;
    closeModelMenu();
    $('#askWidget').classList.remove('open');
    $('#askFab').setAttribute('aria-expanded', 'false');
    $('#askPanel').setAttribute('aria-hidden', 'true');
  }

  function togglePanel() {
    if (open) closePanel(); else openPanel();
  }

  function askTurn(question) {
    var log = $('#askLog');
    var empty = $('#askEmpty');
    if (empty) empty.style.display = 'none';
    var id = 'ask-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    var turn = d.createElement('div');
    turn.className = 'ask-turn';
    turn.innerHTML =
      '<div class="ask-bubble ask-bubble-q">' + esc(question) + '</div>' +
      '<div class="ask-bubble ask-bubble-a pending" id="' + id + '">' +
        '<span class="ask-typing"><span></span><span></span><span></span></span>' +
      '</div>' +
      '<div class="ask-usage-note" id="' + id + '-usage" style="display:none"></div>';
    log.appendChild(turn);
    log.scrollTop = log.scrollHeight;
    return id;
  }

  function sendAsk(e) {
    if (e) e.preventDefault();
    if (!enabled) return;
    var input = $('#askInput');
    var question = input.value.trim();
    if (!question) return;
    var btn = $('#askSend');
    input.value = '';
    btn.disabled = true;
    var answerId = askTurn(question);
    api('__admin/ask', { method: 'POST', body: JSON.stringify({ question: question, model: currentModel }) })
      .then(function (r) {
        btn.disabled = false;
        var el = $('#' + answerId);
        var usageEl = $('#' + answerId + '-usage');
        if (!el) return;
        el.classList.remove('pending');
        if (!r.ok || !r.body.ok) {
          el.classList.add('err');
          el.textContent = (r.body && r.body.error) || 'Could not reach the assistant.';
        } else {
          el.textContent = r.body.answer;
        }
        var usage = r.body && r.body.usage;
        if (usageEl && usage && (usage.inputTokens || usage.outputTokens)) {
          var label = MODEL_LABELS[usage.model] || usage.model || '';
          usageEl.textContent = (label ? label + ' · ' : '') +
            fmtTokens(usage.inputTokens + usage.outputTokens) + ' tokens · ~' + fmtCost(usage.cost);
          usageEl.style.display = '';
          refreshUsageBar();
        }
        $('#askLog').scrollTop = $('#askLog').scrollHeight;
      });
  }

  // Same shape as ParasTwoFactor.refreshStatus()/ParasChangelog.refreshDot():
  // app.js's own boot() (see app.js's start(), gated behind ParasGate.guard)
  // calls this once sign-in has actually succeeded. Checking isAdmin() any
  // earlier than that would just hit __session before there is one to read,
  // caching a false negative for the rest of the page's life.
  function reveal() {
    (w.ParasAdmin ? w.ParasAdmin.isAdmin() : Promise.resolve(false)).then(function (isAdmin) {
      if (!isAdmin) return;
      $('#askWidget').style.display = '';
      setModel(currentModel);
      checkStatus();
    });
  }

  function wire() {
    var widget = $('#askWidget');
    if (!widget) return;
    $('#askFab').addEventListener('click', togglePanel);
    $('#askClose').addEventListener('click', closePanel);
    var form = $('#askInputForm');
    if (form) form.addEventListener('submit', sendAsk);
    $('#askModelBtn').addEventListener('click', toggleModelMenu);
    $$('.ask-model-opt').forEach(function (opt) {
      opt.addEventListener('click', function () {
        setModel(opt.dataset.model);
        closeModelMenu();
      });
    });
    d.addEventListener('click', function (e) {
      var picker = $('#askModelPicker');
      if (picker.classList.contains('open') && !picker.contains(e.target)) closeModelMenu();
    });
    d.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if ($('#askModelPicker').classList.contains('open')) { closeModelMenu(); return; }
      if (open) closePanel();
    });
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', wire);
  else wire();

  w.ParasAsk = { reveal: reveal };
})(window, document);
