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

  // ─── Signal history ring buffer (60 points / ~60 sec) ────────────────

  const SIG_HISTORY_LEN = 60;
  const sigHistory = new Map();   // tag → [{ts, value}]

  function pushHistory(tag, value, ts) {
    if (typeof value !== 'number') return;
    let arr = sigHistory.get(tag);
    if (!arr) { arr = []; sigHistory.set(tag, arr); }
    arr.push({ ts, value });
    if (arr.length > SIG_HISTORY_LEN) arr.shift();
  }

  function renderSparkline(svg, tag) {
    const arr = sigHistory.get(tag);
    if (!arr || arr.length < 2) return;
    const w = parseFloat(svg.getAttribute('width')) || 80;
    const h = parseFloat(svg.getAttribute('height')) || 20;
    const vals = arr.map(p => p.value);
    let min = Math.min(...vals), max = Math.max(...vals);
    const range = max - min || 1;
    const pad = range * 0.1;
    min -= pad; max += pad;
    const span = max - min;
    const stepX = w / (SIG_HISTORY_LEN - 1);
    const startX = w - stepX * (arr.length - 1);
    const pts = arr.map((p, i) => `${(startX + stepX * i).toFixed(1)},${(h - ((p.value - min) / span) * h).toFixed(1)}`).join(' ');
    const last = arr[arr.length - 1];
    const lastY = h - ((last.value - min) / span) * h;
    const color = svg.dataset.color || '#7cf';
    svg.innerHTML = `
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round" />
      <circle cx="${w}" cy="${lastY.toFixed(1)}" r="1.6" fill="${color}" />
    `;
  }

  function updateSparklines(tag) {
    document.querySelectorAll(`svg[data-spark="${cssEscape(tag)}"]`).forEach((svg) => renderSparkline(svg, tag));
  }

  function updateBoundElements(tag, sv) {
    if (typeof sv.value === 'number') pushHistory(tag, sv.value, sv.timestamp || Date.now());
    document.querySelectorAll(`[data-signal="${cssEscape(tag)}"]`).forEach((el) => {
      const formatted = formatValue(sv.value, el);
      const suffix = el.dataset.suffix ?? '';
      const prev = el.textContent;
      el.textContent = formatted + suffix;
      el.classList.remove('stale');
      if (sv.quality !== 'good') el.classList.add('stale');
      if (prev !== el.textContent && !el.classList.contains('sig-flash')) {
        el.classList.add('sig-flash');
        setTimeout(() => el.classList.remove('sig-flash'), 350);
      }
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
    updateSparklines(tag);
  }

  /** Auto-attach sparklines to any element with `data-spark="<tag>"` placed late */
  function autoMountSparklines() {
    document.querySelectorAll('svg[data-spark]:empty').forEach((svg) => {
      const tag = svg.dataset.spark;
      if (sigHistory.has(tag)) renderSparkline(svg, tag);
    });
  }
  setInterval(autoMountSparklines, 2000);

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
    sampling: [],
    workorder: [],
  };
  function emit(name, data) {
    for (const fn of listeners[name] || []) {
      try { fn(data); } catch (e) { console.warn('[live] listener error', e); }
    }
  }

  // ─── Industrial status bar (sitewide bottom strip) ─────────────────

  const statusState = {
    oee: 87.3, activeAlarms: 0, critAlarms: 0,
    pinnSource: 'pinn', cyclesPerHour: 0,
    workorderId: '—', workorderQty: 0, workorderPlan: 1000,
    online: true, lastTickAt: Date.now(),
  };
  let cycleTimes = [];

  function renderStatusBar() {
    if (location.pathname.endsWith('login.html')) return;
    if (document.getElementById('prinx-status-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'prinx-status-bar';
    bar.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 9990;
      height: 28px; padding: 0 14px 0 60px;
      display: flex; align-items: center; gap: 18px;
      background: linear-gradient(180deg, #0d1620 0%, #060a10 100%);
      border-top: 1px solid #2a3440;
      font-family: var(--ff-data, monospace); font-size: 11px;
      color: #8a9aab; letter-spacing: .05em;
    `;
    bar.innerHTML = `
      <span><span style="color:#7cf">●</span> EDGE</span>
      <span id="sb-online" style="color:#4caf50">● 在线</span>
      <span style="opacity:.4">|</span>
      <span>OEE <b id="sb-oee" style="color:#7cf">--</b>%</span>
      <span>工单 <b id="sb-wo" style="color:#cfe">--</b> · <b id="sb-wo-pct">0%</b></span>
      <span style="opacity:.4">|</span>
      <span>告警 <b id="sb-alarm-crit" style="color:#888">0</b> 紧 / <b id="sb-alarm-active" style="color:#fb4">0</b> 活动</span>
      <span style="opacity:.4">|</span>
      <span>PINN <b id="sb-pinn" style="color:#4caf50">●正常</b></span>
      <span>cycles/h <b id="sb-cph" style="color:#cfe">0</b></span>
      <span style="margin-left:auto" id="sb-shift-time"></span>
    `;
    document.body.appendChild(bar);
    document.body.style.paddingBottom = '28px';
  }

  function updateStatusBar() {
    const $ = (id) => document.getElementById(id);
    if (!$('prinx-status-bar')) return;
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('sb-oee', statusState.oee.toFixed(1));
    set('sb-wo', statusState.workorderId);
    set('sb-wo-pct', (statusState.workorderQty / Math.max(1, statusState.workorderPlan) * 100).toFixed(1) + '%');
    set('sb-alarm-active', statusState.activeAlarms);
    const cc = $('sb-alarm-crit'); if (cc) {
      cc.textContent = statusState.critAlarms;
      cc.style.color = statusState.critAlarms > 0 ? '#ff5252' : '#888';
    }
    const pn = $('sb-pinn'); if (pn) {
      const ok = statusState.pinnSource === 'pinn';
      pn.textContent = ok ? '●正常' : '●降级';
      pn.style.color = ok ? '#4caf50' : '#fb4';
    }
    set('sb-cph', Math.round(statusState.cyclesPerHour));
    const on = $('sb-online'); if (on) {
      const stale = Date.now() - statusState.lastTickAt > 5000;
      statusState.online = !stale;
      on.textContent = statusState.online ? '● 在线' : '○ 离线';
      on.style.color = statusState.online ? '#4caf50' : '#fb4';
    }
    set('sb-shift-time', new Date().toLocaleString('zh-CN', { hour12: false }).slice(5));
  }
  setInterval(updateStatusBar, 1000);

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
        statusState.lastTickAt = Date.now();
        for (const sv of msg.data) {
          signalCache[sv.tag] = sv;
          updateBoundElements(sv.tag, sv);
        }
        break;
      case 'alarm_new':
      case 'alarm_update':
        updateAlarmStrip(msg.data);
        emit('alarm', msg.data);
        if (msg.type === 'alarm_new') {
          statusState.activeAlarms += 1;
          if (msg.data.tier <= 2) statusState.critAlarms += 1;
        }
        // Visual pulse only on truly new (not update)
        if (msg.type === 'alarm_new') {
          document.body.classList.remove('alarm-flash');
          // Force reflow to restart animation
          void document.body.offsetWidth;
          document.body.classList.add('alarm-flash');
          setTimeout(() => document.body.classList.remove('alarm-flash'), 900);
        }
        break;
      case 'alarm_cleared':
        statusState.activeAlarms = Math.max(0, statusState.activeAlarms - 1);
        break;
      case 'workorder_progress':
        document.querySelectorAll('[data-workorder-progress]').forEach((el) => {
          el.textContent = msg.data.produced_qty.toFixed(1);
        });
        statusState.workorderId = msg.data.id;
        statusState.workorderQty = msg.data.produced_qty;
        break;
      case 'estop':
        document.body.classList.add('estop-active');
        showBanner(`E-STOP: ${msg.data.reason}`, 'crit');
        emit('estop', msg.data);
        break;
      case 'pinn_status_change':
        statusState.pinnSource = msg.data.state;
        if (msg.data.state === 'mock_fallback') {
          showBanner(`⚠ PINN 已切换到 mock fallback：${msg.data.reason || '未知原因'}`, 'crit');
        } else {
          hideBanner();
        }
        emit('pinnStatus', msg.data);
        break;
      case 'cycle_complete':
        emit('cycle', msg.data);
        cycleTimes.push(Date.now());
        cycleTimes = cycleTimes.filter(t => Date.now() - t < 3600_000);
        const elapsed = Math.min(3600_000, Date.now() - (cycleTimes[0] || Date.now() - 1000));
        statusState.cyclesPerHour = cycleTimes.length * (3600_000 / Math.max(1000, elapsed));
        break;
      case 'control_cycle':
        emit('cycle', msg.data);
        break;
      case 'control_mode_changed':
        emit('mode', msg.data);
        break;
      case 'workorder_complete':
        showInfoToast(`工单完成: ${msg.data.id} · ${msg.data.plan_qty}m`, 'ok');
        break;
      case 'workorder_started':
        showInfoToast(`新工单启动: ${msg.data.id} · ${msg.data.size || ''}`, 'ok');
        break;
      case 'changeover_start':
        showChangeoverBanner(msg.data);
        break;
      case 'changeover_tick':
        updateChangeoverBanner(msg.data);
        break;
      case 'changeover_complete':
        hideChangeoverBanner();
        showInfoToast('配方切换完成 · SP 已稳定到新值', 'ok');
        break;
      case 'maintenance_start':
        showMaintenanceBanner(msg.data);
        break;
      case 'maintenance_tick':
        updateMaintenanceBanner(msg.data);
        break;
      case 'maintenance_end':
        hideMaintenanceBanner();
        break;
      case 'shift_handover':
        showHandoverModal(msg.data);
        break;
      case 'sampling_event':
        emit('sampling', msg.data);
        break;
      case 'scenario_start':
        showScenarioProgress(msg.data);
        break;
      case 'scenario_tick':
        updateScenarioProgress(msg.data);
        break;
      case 'scenario_end':
        hideScenarioProgress();
        break;
      default:
        break;
    }
  }

  // ─── v0.5.2 顶部横幅 / 模态 / 进度条 ────────────────────────────────

  function showInfoToast(text, level = 'ok') {
    const t = document.createElement('div');
    const colors = { ok: ['#1a3a2a','#8fc','#5a8'], warn: ['#3a2a1a','#fb4','#fb4'], crit: ['#3a1820','#f8a','#f8a'] };
    const [bg, fg, br] = colors[level] || colors.ok;
    t.textContent = text;
    t.style.cssText = `position:fixed;top:38px;left:50%;transform:translateX(-50%);z-index:10000;padding:10px 18px;background:${bg};color:${fg};border:1px solid ${br};font-family:var(--ff-cn,sans-serif);font-size:14px;letter-spacing:.05em;box-shadow:0 4px 14px rgba(0,0,0,.6);pointer-events:none;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  let bannerStack = [];
  function ensureBannerStack() {
    let host = document.getElementById('prinx-banner-stack');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'prinx-banner-stack';
    host.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:1001;display:flex;flex-direction:column;';
    document.body.appendChild(host);
    return host;
  }

  function makeBanner(id, color) {
    let b = document.getElementById(id);
    if (b) return b;
    b = document.createElement('div');
    b.id = id;
    b.style.cssText = `padding:6px 14px;font-family:var(--ff-data,monospace);font-size:13px;letter-spacing:.05em;text-align:center;background:${color.bg};color:${color.fg};border-bottom:1px solid ${color.br};`;
    ensureBannerStack().appendChild(b);
    return b;
  }
  function removeBanner(id) {
    const b = document.getElementById(id);
    if (b) b.remove();
  }

  let changeoverData = null;
  function showChangeoverBanner(data) {
    changeoverData = data;
    const b = makeBanner('prinx-banner-changeover', { bg: '#001a2a', fg: '#7cf', br: '#7cf' });
    b.innerHTML = `⟳ 配方切换中  ${data.from_recipe_id || ''} → <b>${data.to_recipe_id}</b>  ·  <span id="cob-pct">0</span>%  ·  剩 <span id="cob-sec">${data.duration_sec}</span>s  ·  ${data.transitions.length} 个 SP 缓动`;
  }
  function updateChangeoverBanner(data) {
    const p = document.getElementById('cob-pct'); const s = document.getElementById('cob-sec');
    if (p) p.textContent = data.progress_pct;
    if (s) s.textContent = Math.ceil(data.remaining_sec);
  }
  function hideChangeoverBanner() { removeBanner('prinx-banner-changeover'); changeoverData = null; }

  let maintTimer = null;
  function showMaintenanceBanner(data) {
    const b = makeBanner('prinx-banner-maint', { bg: '#3a2a08', fg: '#fb4', br: '#fb4' });
    document.body.classList.add('maintenance-active');
    const fmt = (s) => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
    b.innerHTML = `🔧 计划维护中  ·  <b>${data.reason}</b>  ·  还剩 <span id="mb-rem">${fmt(data.remaining_sec)}</span>  · 信号已暂停`;
  }
  function updateMaintenanceBanner(data) {
    const r = document.getElementById('mb-rem');
    if (r) r.textContent = `${Math.floor(data.remaining_sec/60)}:${String(Math.floor(data.remaining_sec%60)).padStart(2,'0')}`;
  }
  function hideMaintenanceBanner() {
    removeBanner('prinx-banner-maint');
    document.body.classList.remove('maintenance-active');
  }

  // 班次交接模态
  function showHandoverModal(data) {
    const old = document.getElementById('prinx-handover'); if (old) old.remove();
    const m = document.createElement('div');
    m.id = 'prinx-handover';
    m.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,8,15,.78);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
    const s = data.stats || {};
    m.innerHTML = `
      <div style="width:560px;max-width:92vw;background:#0b1620;border:1px solid #3a557a;font-family:var(--ff-cn,sans-serif);color:#cfe;padding:0;box-shadow:0 12px 40px rgba(0,0,0,.7);">
        <div style="padding:14px 20px;background:#001a2a;border-bottom:1px solid #3a557a;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:18px;letter-spacing:.1em;color:#7cf">班次交接  ·  ${data.from} → ${data.to}</span>
          <span id="ho-timer" style="font-family:var(--ff-data,monospace);font-size:12px;color:#888">30s</span>
        </div>
        <div style="padding:18px 22px;border-bottom:1px solid #1a2a3a;">
          <div style="font-size:13px;color:#7cf;letter-spacing:.1em;margin-bottom:8px">上班信息</div>
          <div style="display:grid;grid-template-columns:120px 1fr;gap:8px 16px;font-family:var(--ff-data,monospace);font-size:13px;">
            <span style="color:#789">交班人</span><span>${data.from_operator}（${data.from} 班）</span>
            <span style="color:#789">完成卷数</span><span>${s.rolls_completed || 0} 卷  ·  ${(s.produced_m || 0).toFixed(1)} m</span>
            <span style="color:#789">告警</span><span>Tier 1/2 <b style="color:#f88">${s.alarms_tier12 || 0}</b> 条  ·  Tier 3 <b style="color:#fb8">${s.alarms_tier3 || 0}</b> 条</span>
            <span style="color:#789">闭环 cycle</span><span>应用 <b style="color:#8fc">${s.cycles_applied || 0}</b>  ·  拒绝 <b style="color:#fb8">${s.cycles_rejected || 0}</b></span>
            <span style="color:#789">未结告警</span><span><b style="color:${s.unack_alarms ? '#f88' : '#8fc'}">${s.unack_alarms || 0}</b> 条待 ack</span>
          </div>
        </div>
        <div style="padding:18px 22px;background:#0a1a26;display:flex;align-items:center;gap:18px;">
          <div style="width:56px;height:56px;background:#1a3a5a;color:#7cf;display:grid;place-items:center;font-family:var(--ff-data,monospace);font-size:18px;letter-spacing:.05em;">${data.to_avatar || data.to}</div>
          <div style="flex:1;">
            <div style="font-size:14px">接班人 <b style="color:#cfe">${data.to_operator}</b>（${data.to} 班）</div>
            <div style="font-size:12px;color:#789;margin-top:2px">LV${data.to_level || 2}  ·  请确认接班</div>
          </div>
          <button id="ho-confirm" style="padding:10px 22px;background:#7cf;color:#001;border:0;font-family:var(--ff-cn);font-size:14px;font-weight:600;cursor:pointer;letter-spacing:.05em">✓ 我已确认接班</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    let left = 30;
    const tmr = setInterval(() => {
      left -= 1;
      const t = document.getElementById('ho-timer'); if (t) t.textContent = `${left}s 后自动关闭`;
      if (left <= 0) { clearInterval(tmr); m.remove(); }
    }, 1000);
    document.getElementById('ho-confirm').onclick = () => { clearInterval(tmr); m.remove(); };
  }

  // 剧本进度条
  function showScenarioProgress(data) {
    let bar = document.getElementById('prinx-scenario-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'prinx-scenario-bar';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:3px;z-index:1002;background:rgba(0,0,0,.4);';
      bar.innerHTML = '<div id="psb-fill" style="height:100%;width:0%;background:#7cf;transition:width .5s linear;box-shadow:0 0 8px #7cf;"></div><div id="psb-label" style="position:absolute;top:6px;right:14px;font-family:var(--ff-data,monospace);font-size:11px;color:#7cf;letter-spacing:.1em;">▶ 剧本播放中 · 0:00 / ' + Math.floor(data.total_sec/60) + ':' + String(data.total_sec%60).padStart(2,'0') + '</div>';
      document.body.appendChild(bar);
    }
    bar.dataset.total = data.total_sec;
  }
  function updateScenarioProgress(data) {
    const fill = document.getElementById('psb-fill');
    const lbl = document.getElementById('psb-label');
    const total = data.total_sec || parseInt(document.getElementById('prinx-scenario-bar')?.dataset.total || '290', 10);
    if (fill) fill.style.width = `${Math.min(100, (data.elapsed_sec / total) * 100)}%`;
    if (lbl) lbl.textContent = `▶ 剧本播放中 · ${Math.floor(data.elapsed_sec/60)}:${String(data.elapsed_sec%60).padStart(2,'0')} / ${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;
  }
  function hideScenarioProgress() {
    const bar = document.getElementById('prinx-scenario-bar');
    if (bar) bar.remove();
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
    onSampling(fn) { listeners.sampling.push(fn); },
    onWorkorder(fn) { listeners.workorder.push(fn); },
    listeners,  // expose for advanced use

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

  // ─── Inject sitewide UX polish CSS (transitions + alarm pulse) ──────

  function injectGlobalStyles() {
    if (document.getElementById('prinx-live-styles')) return;
    const s = document.createElement('style');
    s.id = 'prinx-live-styles';
    s.textContent = `
      /* signal value smooth transition (text color subtle pulse on update) */
      [data-signal] { transition: color 200ms ease, text-shadow 200ms ease; }
      [data-signal].sig-flash { color: var(--accent, #7cf) !important; text-shadow: 0 0 8px rgba(124, 207, 255, .4); }
      [data-signal].stale { color: #888 !important; opacity: .6; }
      /* alarm/state class binding */
      [data-signal-class].is-warn { color: #fb4 !important; }
      [data-signal-class].is-alarm { color: #f55 !important; text-shadow: 0 0 6px rgba(255,80,80,.4); }

      /* New-alarm screen flash: short red border pulse on body */
      @keyframes prinxAlarmPulse {
        0%   { box-shadow: inset 0 0 0 3px rgba(255,80,80,.0); }
        20%  { box-shadow: inset 0 0 0 3px rgba(255,80,80,.6); }
        100% { box-shadow: inset 0 0 0 3px rgba(255,80,80,.0); }
      }
      body.alarm-flash { animation: prinxAlarmPulse 800ms ease-out; }

      /* E-STOP overlay */
      body.estop-active::before {
        content: 'E-STOP ACTIVE · 急停已触发';
        position: fixed; inset: 0; z-index: 9998;
        background: rgba(80, 0, 0, .55); color: #fff;
        font-family: var(--ff-data, monospace); font-size: 28px;
        letter-spacing: .2em; text-transform: uppercase;
        display: grid; place-items: center;
        backdrop-filter: blur(2px);
        pointer-events: none;
      }

      /* Pulse style for ack button */
      .ack-btn { padding: 2px 8px; cursor: pointer;
        font-family: var(--ff-data, monospace); font-size: 11px;
        background: transparent; color: #fb4; border: 1px solid #fb4;
        margin-left: 8px; letter-spacing: .05em; }
      .ack-btn:hover { background: #fb4; color: #001; }

      /* Mobile responsive baseline (all pages) */
      @media (max-width: 900px) {
        .topbar, .top-strip { flex-wrap: wrap; height: auto !important; padding: 8px 12px !important; }
        .sidenav { display: none !important; }
        .canvas, main { padding: 8px !important; }
        .topbar-meta, .top-strip-right { gap: 8px !important; font-size: 11px !important; }
        .recipe-grid, .ctrl-canvas, .alarm-grid, .train-canvas { grid-template-columns: 1fr !important; }
        .extruder-row { grid-template-columns: 1fr 1fr !important; }
        .signals-strip { grid-template-columns: 1fr 1fr !important; }
      }
    `;
    document.head.appendChild(s);
  }

  // ─── Demo tour (sitewide guide浮球) ────────────────────────────────────

  const TOUR = [
    { path: 'pages/overview.html',    name: '主画面',       hint: '看 4 挤出机 + 5 模头温区实时数据' },
    { path: 'pages/control.html',     name: '闭环控制',     hint: 'PINN 推荐 + 7 道安全闸 + 实时 cycle 流' },
    { path: 'pages/alarm.html',       name: '报警管理',     hint: '告警分级、ack 流、AI 预警' },
    { path: 'pages/recipe.html',      name: '配方管理',     hint: 'LV4 审批 → 应用到 PLC' },
    { path: 'pages/training.html',    name: 'PINN 训练',    hint: '训练任务 + 影子部署 + 模型注册' },
    { path: 'pages/trend.html',       name: '趋势',         hint: '历史数据查看' },
    { path: 'pages/temperature.html', name: '温控系统',     hint: '5 段模头 + 12 区温度' },
    { path: 'pages/process.html',     name: '工艺',         hint: 'SPC + Cpk 在线分析' },
    { path: 'pages/mes.html',         name: 'MES 工单',     hint: '订单追溯 + 班组' },
    { path: 'pages/maintenance.html', name: '维护',         hint: '设备状态' },
    { path: 'pages/report.html',      name: '报表',         hint: '日报/周报/月报' },
  ];

  function pathFromLogin(p) {
    return location.pathname.includes('/pages/') ? p.replace(/^pages\//, '') : p;
  }

  function renderTourBall() {
    if (location.pathname.endsWith('login.html')) return;
    if (document.getElementById('prinx-tour-ball')) return;

    const ball = document.createElement('button');
    ball.id = 'prinx-tour-ball';
    ball.type = 'button';
    ball.title = '演示导览';
    ball.innerHTML = '◆';
    ball.style.cssText = `
      position: fixed; bottom: 6px; left: 8px; z-index: 9999;
      width: 38px; height: 38px; border-radius: 50%;
      background: rgba(20,40,60,.95); color: #7cf;
      border: 1px solid #3a557a; font-family: var(--ff-data, monospace);
      font-size: 18px; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.5);
    `;
    document.body.appendChild(ball);

    const panel = document.createElement('div');
    panel.id = 'prinx-tour-panel';
    panel.style.cssText = `
      position: fixed; bottom: 50px; left: 8px; z-index: 9999;
      width: 290px; max-height: 70vh; overflow-y: auto;
      padding: 10px 0 8px; display: none;
      font-family: var(--ff-cn, sans-serif); font-size: 12px;
      background: rgba(15,25,40,.97); color: #cfe;
      border: 1px solid #3a557a; box-shadow: 0 6px 20px rgba(0,0,0,.55);
    `;

    const cur = location.pathname.split('/').pop();
    const items = TOUR.map((t, i) => {
      const isCur = cur === t.path.split('/').pop();
      return `<a href="${pathFromLogin(t.path)}" style="display:block;padding:7px 14px;text-decoration:none;color:${isCur ? '#001014' : '#cfe'};background:${isCur ? '#7cf' : 'transparent'};border-left:2px solid ${isCur ? '#7cf' : 'transparent'}">
        <div style="font-size:13px;font-weight:500">${i + 1}. ${t.name}${isCur ? ' · 当前页' : ''}</div>
        <div style="font-size:11px;opacity:.75;margin-top:1px">${t.hint}</div>
      </a>`;
    }).join('');

    panel.innerHTML = `
      <div style="padding:6px 14px 10px;color:#7cf;letter-spacing:.15em;text-transform:uppercase;font-family:var(--ff-data,monospace);font-size:11px;border-bottom:1px solid #3a557a">演示导览 · TOUR</div>
      ${items}
      <div style="padding:6px 14px;font-size:10px;color:#678;border-top:1px solid #3a557a;line-height:1.5">右下 DEMO 按钮可触发场景演示<br>顶栏退出可重新进登录页</div>
    `;
    document.body.appendChild(panel);

    ball.addEventListener('click', () => {
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      ball.style.background = open ? 'rgba(20,40,60,.95)' : '#7cf';
      ball.style.color = open ? '#7cf' : '#001014';
    });

    // Auto-pop on first visit per session (only on overview)
    const POPPED = 'prinx.tour_popped';
    if (!sessionStorage.getItem(POPPED) && location.pathname.includes('overview.html')) {
      setTimeout(() => {
        ball.click();
        sessionStorage.setItem(POPPED, '1');
        // Auto-close after 6s
        setTimeout(() => { if (panel.style.display === 'block') ball.click(); }, 6000);
      }, 1500);
    }
  }

  // ─── Auto-start ─────────────────────────────────────────────────────────

  function start() {
    injectGlobalStyles();
    if (location.pathname.endsWith('login.html')) return;
    connect();
    window.PRINX.refresh().catch(() => {});
    window.PRINX.renderUserBadge();
    renderTourBall();
    renderStatusBar();
    if (window.PRINX?.api) {
      window.PRINX.api.get('/api/alarms').then((arr) => {
        if (Array.isArray(arr)) {
          statusState.activeAlarms = arr.length;
          statusState.critAlarms = arr.filter(a => a.tier <= 2 && a.state !== 'cleared').length;
          updateStatusBar();
        }
      }).catch(() => {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
