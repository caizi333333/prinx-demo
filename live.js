/**
 * PRINX HMI Live Data Wiring — v0.5 client
 *
 * 功能：
 *   - JWT auth：localStorage 存 access/refresh，自动刷新；401 跳登录
 *   - WebSocket（带 ?token=）+ 自动重连
 *   - 实时绑定：data-signal / data-signal-class / data-workorder-progress
 *   - PINN 状态横幅：监听 pinn_status_change，mock_fallback 时插入红色提示条
 *   - 闭环 cycle stream：cycle_complete 事件 → window.PRINX.onCycle(handler)
 *   - 控制模式变化：control_mode_changed → window.PRINX.onModeChange(handler)
 *   - REST helper：PRINX.api.get/post/postJson 自带 token；401 → 自动 refresh，再失败跳登录
 *   - 报警条：alarm-strip-feed 自动滚动 5 条；ack 按钮内置
 *
 * HTML 用法：
 *   <span data-signal="REEL.LENGTH" data-precision="1">75.0</span>
 *   <span data-signal-class="EXT-T.SPEED" data-range="3,10">5.1</span>
 *   <span data-workorder-progress>75.0</span>
 *
 *   <script src="../live.js"></script>
 */

(function () {
  'use strict';

  // ─── Config ────────────────────────────────────────────────────────────

  const TOKEN_KEY = 'prinx.access';
  const REFRESH_KEY = 'prinx.refresh';
  const USER_KEY = 'prinx.user';
  const RECONNECT_DELAY = 2000;
  const MAX_BACKOFF = 30000;

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = location.host || 'localhost:8765';
    const tok = getAccessToken();
    return tok ? `${proto}//${host}/ws?token=${encodeURIComponent(tok)}` : `${proto}//${host}/ws`;
  }

  // ─── Token storage ─────────────────────────────────────────────────────

  function getAccessToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function getRefreshToken() { return localStorage.getItem(REFRESH_KEY) || ''; }
  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  }
  function setTokens(t) {
    if (t.access_token) localStorage.setItem(TOKEN_KEY, t.access_token);
    if (t.refresh_token) localStorage.setItem(REFRESH_KEY, t.refresh_token);
    if (t.user) localStorage.setItem(USER_KEY, JSON.stringify(t.user));
  }
  function clearTokens() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function loginPath() {
    // pages/*.html → ../login.html ；index.html / 其他根 → login.html
    const path = location.pathname;
    return path.includes('/pages/') ? '../login.html' : 'login.html';
  }

  function redirectToLogin() {
    if (location.pathname.endsWith('login.html')) return;
    sessionStorage.setItem('prinx.return_to', location.pathname + location.search);
    location.href = loginPath();
  }

  // ─── REST API ───────────────────────────────────────────────────────────

  async function refreshAccessToken() {
    const r = getRefreshToken();
    if (!r) return false;
    try {
      const resp = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: r }),
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      setTokens(data);
      return true;
    } catch { return false; }
  }

  async function apiFetch(path, init = {}) {
    const headers = new Headers(init.headers || {});
    const tok = getAccessToken();
    if (tok) headers.set('Authorization', `Bearer ${tok}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let resp = await fetch(path, { ...init, headers });
    if (resp.status === 401) {
      // try refresh once
      if (await refreshAccessToken()) {
        headers.set('Authorization', `Bearer ${getAccessToken()}`);
        resp = await fetch(path, { ...init, headers });
        if (resp.status === 401) {
          clearTokens();
          redirectToLogin();
          throw new Error('unauthorized');
        }
      } else {
        clearTokens();
        redirectToLogin();
        throw new Error('unauthorized');
      }
    }
    return resp;
  }

  async function apiJson(path, init) {
    const r = await apiFetch(path, init);
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${text || r.statusText}`);
    }
    if (r.status === 204) return null;
    return r.json();
  }

  // ─── DOM update ────────────────────────────────────────────────────────

  function formatValue(value, el) {
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value !== 'number') return String(value);
    const precision = parseInt(el.dataset.precision ?? '', 10);
    if (!isNaN(precision)) return value.toFixed(precision);
    if (Math.abs(value) >= 100) return value.toFixed(1);
    if (Math.abs(value) >= 1) return value.toFixed(2);
    return value.toFixed(3);
  }

  function updateBoundElements(tag, sv) {
    document.querySelectorAll(`[data-signal="${cssEscape(tag)}"]`).forEach((el) => {
      const formatted = formatValue(sv.value, el);
      const suffix = el.dataset.suffix ?? '';
      el.textContent = formatted + suffix;
      el.classList.remove('stale');
      if (sv.quality !== 'good') el.classList.add('stale');
    });
    document.querySelectorAll(`[data-signal-class="${cssEscape(tag)}"]`).forEach((el) => {
      const v = sv.value;
      const range = el.dataset.range?.split(',').map(Number);
      el.classList.remove('is-warn', 'is-alarm');
      if (Array.isArray(range) && range.length === 2 && typeof v === 'number') {
        const span = range[1] - range[0];
        const warnMargin = span * 0.1;
        if (v < range[0] || v > range[1]) el.classList.add('is-alarm');
        else if (v < range[0] + warnMargin || v > range[1] - warnMargin) el.classList.add('is-warn');
      }
    });
  }

  function cssEscape(s) {
    return String(s).replace(/(["'\\])/g, '\\$1');
  }

  function updateAlarmStrip(alarm) {
    const feed = document.querySelector('.alarm-strip-feed');
    if (!feed) return;
    const tierClass = ['lvl-c', 'lvl-h', 'lvl-m', 'lvl-l'][alarm.tier - 1] ?? 'lvl-l';
    const ts = new Date(alarm.last_occurred_at).toTimeString().slice(0, 8);
    feed.innerHTML = `
      <span class="ts">${ts}</span>
      <span class="lvl ${tierClass}"></span>
      <span>${escape(alarm.message)}</span>
      ${alarm.count > 1 ? `<span class="agg">×${alarm.count}</span>` : ''}
      <button class="ack-btn" data-ack="${alarm.id}">ACK</button>
    `;
  }

  function escape(s) {
    const div = document.createElement('div');
    div.textContent = String(s);
    return div.innerHTML;
  }

  // ─── PINN status banner ────────────────────────────────────────────────

  function getOrCreateBanner() {
    let b = document.getElementById('prinx-pinn-banner');
    if (b) return b;
    b = document.createElement('div');
    b.id = 'prinx-pinn-banner';
    b.style.cssText = `
      position:fixed; top:0; left:0; right:0; z-index:1000;
      padding:6px 12px; font-family:var(--ff-data, monospace);
      font-size:12px; letter-spacing:.05em; text-align:center;
      background:#5a1a1a; color:#ffe7e7; border-bottom:1px solid #ff5252;
      display:none; pointer-events:none;
    `;
    document.body.appendChild(b);
    return b;
  }
  function showBanner(text, level) {
    const b = getOrCreateBanner();
    b.textContent = text;
    b.style.background = level === 'warn' ? '#5a4d1a' : '#5a1a1a';
    b.style.color = level === 'warn' ? '#fff7e0' : '#ffe7e7';
    b.style.borderBottom = `1px solid ${level === 'warn' ? '#ffb84d' : '#ff5252'}`;
    b.style.display = 'block';
    document.body.style.paddingTop = '28px';
  }
  function hideBanner() {
    const b = document.getElementById('prinx-pinn-banner');
    if (b) { b.style.display = 'none'; document.body.style.paddingTop = ''; }
  }

  // ─── Event listeners (user-attachable) ─────────────────────────────────

  const listeners = {
    cycle: [],
    mode: [],
    pinnStatus: [],
    alarm: [],
    estop: [],
  };
  function emit(name, data) {
    for (const fn of listeners[name] || []) {
      try { fn(data); } catch (e) { console.warn('[live] listener error', e); }
    }
  }

  // ─── WebSocket ──────────────────────────────────────────────────────────

  let ws = null;
  let reconnectAttempt = 0;
  let signalCache = {};

  function connect() {
    const url = wsUrl();
    console.log('[live] connecting to', url);
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.warn('[live] connect failed, retrying...', e);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('[live] connected');
      reconnectAttempt = 0;
      document.body.classList.add('live-connected');
      // Refresh on reconnect (PRINX.refresh fires REST GET /api/signals)
      window.PRINX?.refresh?.().catch(() => {});
    };

    ws.onmessage = (evt) => {
      try { handleMessage(JSON.parse(evt.data)); }
      catch (e) { console.warn('[live] parse error', e); }
    };

    ws.onclose = (evt) => {
      console.log('[live] disconnected code=' + evt.code);
      document.body.classList.remove('live-connected');
      if (evt.code === 1008 || evt.code === 4401) {
        // unauthorized — try to refresh and reconnect
        refreshAccessToken().then((ok) => {
          if (!ok) { clearTokens(); redirectToLogin(); }
          else scheduleReconnect();
        });
      } else {
        scheduleReconnect();
      }
    };

    ws.onerror = (e) => console.warn('[live] error', e);
  }

  function scheduleReconnect() {
    reconnectAttempt += 1;
    const delay = Math.min(RECONNECT_DELAY * Math.pow(1.5, reconnectAttempt), MAX_BACKOFF);
    setTimeout(connect, delay);
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'signals':
        for (const [tag, sv] of Object.entries(msg.data)) {
          signalCache[tag] = sv;
          updateBoundElements(tag, sv);
        }
        break;
      case 'signal_delta':
        for (const sv of msg.data) {
          signalCache[sv.tag] = sv;
          updateBoundElements(sv.tag, sv);
        }
        break;
      case 'alarm_new':
      case 'alarm_update':
        updateAlarmStrip(msg.data);
        emit('alarm', msg.data);
        break;
      case 'alarm_cleared':
        break;
      case 'workorder_progress':
        document.querySelectorAll('[data-workorder-progress]').forEach((el) => {
          el.textContent = msg.data.produced_qty.toFixed(1);
        });
        break;
      case 'estop':
        document.body.classList.add('estop-active');
        showBanner(`E-STOP: ${msg.data.reason}`, 'crit');
        emit('estop', msg.data);
        break;
      case 'pinn_status_change':
        if (msg.data.state === 'mock_fallback') {
          showBanner(`⚠ PINN 已切换到 mock fallback：${msg.data.reason || '未知原因'}`, 'crit');
        } else {
          hideBanner();
        }
        emit('pinnStatus', msg.data);
        break;
      case 'cycle_complete':
        emit('cycle', msg.data);
        break;
      case 'control_cycle':
        emit('cycle', msg.data);
        break;
      case 'control_mode_changed':
        emit('mode', msg.data);
        break;
      default:
        break;
    }
  }

  // ─── ACK button delegation ─────────────────────────────────────────────

  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.dataset.ack) {
      e.preventDefault();
      try {
        const op = getUser()?.name || 'unknown';
        await apiJson(`/api/alarms/${t.dataset.ack}/ack`, { method: 'POST', body: JSON.stringify({ operator: op }) });
        t.textContent = 'ACK ✓';
        t.disabled = true;
      } catch (err) { console.warn('ack failed', err); }
    }
  });

  // ─── Public API ─────────────────────────────────────────────────────────

  window.PRINX = {
    user: getUser,
    isAuthenticated: () => !!getAccessToken(),
    logout() {
      const r = getRefreshToken();
      if (r) fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: r }),
      }).catch(() => {});
      clearTokens();
      location.href = loginPath();
    },
    getSignal(tag) { return signalCache[tag]; },
    getAllSignals() { return { ...signalCache }; },

    api: {
      get: (path) => apiJson(path),
      post: (path, body) => apiJson(path, { method: 'POST', body: JSON.stringify(body || {}) }),
      delete: (path) => apiFetch(path, { method: 'DELETE' }),
      raw: apiFetch,
    },

    async refresh() {
      try {
        const data = await apiJson('/api/signals');
        for (const [tag, sv] of Object.entries(data)) {
          signalCache[tag] = sv;
          updateBoundElements(tag, sv);
        }
      } catch (e) { console.warn('[live] refresh failed', e); }
    },

    async control(action, body = {}) {
      return apiJson(`/api/control/${action}`, { method: 'POST', body: JSON.stringify(body) });
    },

    async ackAlarm(id, operator) {
      return apiJson(`/api/alarms/${id}/ack`, { method: 'POST', body: JSON.stringify({ operator }) });
    },

    onCycle(fn) { listeners.cycle.push(fn); },
    onModeChange(fn) { listeners.mode.push(fn); },
    onPinnStatus(fn) { listeners.pinnStatus.push(fn); },
    onAlarm(fn) { listeners.alarm.push(fn); },
    onEStop(fn) { listeners.estop.push(fn); },

    /** Render user badge into selector (e.g. .top-strip-right) */
    renderUserBadge(selector = '.top-strip-right') {
      const root = document.querySelector(selector);
      if (!root) return;
      const u = getUser();
      const wrap = document.createElement('span');
      wrap.className = 'corner-mark';
      wrap.style.cursor = 'pointer';
      if (u) {
        wrap.innerHTML = `<span style="color:var(--accent,#7cf)">●</span> ${escape(u.name)} · LV${u.level} · 退出`;
        wrap.onclick = () => window.PRINX.logout();
      } else {
        wrap.innerHTML = `<span style="color:#888">○</span> 未登录`;
        wrap.onclick = () => redirectToLogin();
      }
      root.appendChild(wrap);
    },

    /** Optional ws gate: skip auto-connect for login.html */
    autoConnect: true,
  };

  // ─── Auto-start ─────────────────────────────────────────────────────────

  function start() {
    // Don't auto-connect on login page
    if (location.pathname.endsWith('login.html')) return;
    connect();
    window.PRINX.refresh().catch(() => {});
    window.PRINX.renderUserBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
