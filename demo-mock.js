/**
 * PRINX HMI — Demo Mock Layer
 *
 * 当后端不可达时（静态部署在 CF Pages 等），由此文件接管：
 *  1. 拦截 fetch /api/* —— 返回本地静态种子数据 + 模拟动态状态
 *  2. 拦截 WebSocket 构造 —— 不真连，而是用本地定时器派发同协议事件
 *  3. 浏览器内 PlcSimulator —— 1Hz 演化所有 82 个信号
 *  4. 周期性触发：报警、闭环 cycle、PINN 状态翻转、E-STOP 演示
 *
 * live.js 在收到首个 fetch /api/signals 失败 (network error / 404 / 5xx)
 * 时，自动 import 本文件接管，URL 不变。
 *
 * 用法（无需手动调用）：
 *   <script src="../live.js"></script>
 *   <script src="../demo-mock.js"></script>
 */

(function () {
  'use strict';
  if (window.__PRINX_DEMO_INSTALLED__) return;

  // Activation: default ON. Skip only when explicit `?demo=0` (for VPS-backed
  // deploys to disable). This is intentionally permissive — wherever this
  // script is loaded, demo runs unless the URL says otherwise. Resilient to
  // future hostname/domain/subpath changes.
  const params = new URLSearchParams(location.search);
  const skip = params.get('demo') === '0';
  if (skip) {
    console.log('[PRINX demo] ?demo=0 — disabled by query param');
    return;
  }
  window.__PRINX_DEMO_INSTALLED__ = true;

  // ─── Device model (mirrors backend/src/data/device-6-sidewall.ts) ─────

  const SIGNALS = [];
  function add(tag, label, unit, kind, range, segment, alarm) {
    SIGNALS.push({ tag, label, unit, kind, range, segment, alarm });
  }

  // Extruder speeds
  for (const [id, name, seg] of [
    ['90', '90 挤出机', 'extruder-90'],
    ['T', '上挤出机', 'extruder-top'],
    ['M', '中挤出机', 'extruder-mid'],
    ['B', '下挤出机', 'extruder-btm'],
  ]) {
    add(`EXT-${id}.SPEED`, `${name}转速`, 'RPM', 'pv', [0, 10], seg, { deviation: 5 });
    add(`EXT-${id}.SPEED.SP`, `${name}转速设定`, 'RPM', 'sp', [0, 10], seg);
  }
  // Die head temps
  for (const [id, label] of [['DIE-T', '上模'], ['DIE-TM', '上中模'], ['DIE-M', '中模'], ['DIE-BM', '下中模'], ['DIE-B', '下模']]) {
    add(`TT-${id}.PV`, `${label}温度`, '°C', 'pv', [50, 100], 'die-head', { deviation: 1.5 });
    add(`TT-${id}.SP`, `${label}温度设定`, '°C', 'sp', [50, 100], 'die-head');
  }
  // Extruder zones
  for (const [id, name, seg] of [['150T', '上挤出机', 'extruder-top'], ['150M', '中挤出机', 'extruder-mid'], ['150B', '下挤出机', 'extruder-btm'], ['90', '90 挤出机', 'extruder-90']]) {
    for (const [z, zname] of [['Z1', '螺杆段'], ['Z2', '塑化段'], ['Z3', '挤出段']]) {
      add(`TT-${id}-${z}.PV`, `${name}${zname}温度`, '°C', 'pv', [40, 100], seg, { deviation: 2 });
      add(`TT-${id}-${z}.SP`, `${name}${zname}设定`, '°C', 'sp', [40, 100], seg);
    }
  }
  // Melt pressures
  for (const [id, name, seg] of [['150T', '上挤出机', 'extruder-top'], ['150M', '中挤出机', 'extruder-mid'], ['150B', '下挤出机', 'extruder-btm'], ['90', '90 挤出机', 'extruder-90']]) {
    add(`PT-${id}.PV`, `${name}熔体压力`, 'MPA', 'pv', [0, 30], seg, { high: 25, high_high: 28 });
  }
  // Motor currents
  for (const [id, name, seg] of [['150T', '上挤出机', 'extruder-top'], ['150M', '中挤出机', 'extruder-mid'], ['150B', '下挤出机', 'extruder-btm'], ['90', '90 挤出机', 'extruder-90']]) {
    add(`MOT-${id}.CURRENT`, `${name}主电机电流`, 'A', 'pv', [0, 200], seg, { high: 160, high_high: 180 });
  }
  // Floaters
  for (let i = 1; i <= 9; i += 1) {
    add(`FLT-${i}.POS`, `浮动辊 ${i} 位置`, 'MM', 'pv', [0, 100], 'floater', { high: 90, low: 10 });
    add(`FLT-${i}.PRESSURE`, `浮动辊 ${i} 压力`, 'MPA', 'pv', [0, 3], 'floater', { high: 2.5 });
  }
  // Downstream
  add('TAKEUP.SPEED', '接取速度', 'M/MIN', 'pv', [0, 20], 'reel');
  add('TAKEUP.SPEED.SP', '接取速度设定', 'M/MIN', 'sp', [0, 20], 'reel');
  add('REEL.LENGTH', '卷取长度', 'M', 'pv', [0, 5000], 'reel');
  add('SHRINK.PV', '收缩率', '%', 'pv', [0, 10], 'reel', { high: 5, low: 3 });
  add('SCL-FRONT.PV', '前连续秤', 'KG/M', 'pv', [0, 2], 'cooling', { deviation: 2 });
  add('SCL-FRONT.SP', '前连续秤标准', 'KG/M', 'sp', [0, 2], 'cooling');
  add('SCL-REAR.PV', '后连续秤', 'KG/M', 'pv', [0, 2], 'cooling', { deviation: 2 });
  add('SCL-REAR.SP', '后连续秤标准', 'KG/M', 'sp', [0, 2], 'cooling');
  add('WIDTH-REAR.PV', '后测宽', 'MM', 'pv', [0, 200], 'width-meter', { deviation: 3 });
  add('WIDTH-REAR.SP', '后测宽标准', 'MM', 'sp', [0, 200], 'width-meter');
  // Aliases (referenced by overview)
  add('EXT-90.PRESSURE', '90 挤出机压力', 'MPA', 'pv', [0, 30], 'extruder-90');
  add('EXT-T.PRESSURE', '上挤出机压力', 'MPA', 'pv', [0, 30], 'extruder-top');
  add('EXT-M.PRESSURE', '中挤出机压力', 'MPA', 'pv', [0, 30], 'extruder-mid');
  add('EXT-B.PRESSURE', '下挤出机压力', 'MPA', 'pv', [0, 30], 'extruder-btm');
  add('EXT-90.MELT_TEMP', '90 挤出机胶温', '°C', 'pv', [40, 120], 'extruder-90');
  add('EXT-T.MELT_TEMP', '上挤出机胶温', '°C', 'pv', [40, 120], 'extruder-top');
  add('EXT-M.MELT_TEMP', '中挤出机胶温', '°C', 'pv', [40, 120], 'extruder-mid');
  add('EXT-B.MELT_TEMP', '下挤出机胶温', '°C', 'pv', [40, 120], 'extruder-btm');
  add('TENSION.PV', '张力', 'MPA', 'pv', [0, 5], 'floater');

  const SEGMENTS = [
    { id: 'extruder-90', name: '90 挤出机', role: '胎侧专用', signals: [] },
    { id: 'extruder-top', name: '上挤出机', signals: [] },
    { id: 'extruder-mid', name: '中挤出机', signals: [] },
    { id: 'extruder-btm', name: '下挤出机', signals: [] },
    { id: 'die-head', name: '复合模头', role: '5 段温区', signals: [] },
    { id: 'cooling', name: '冷却 + 称重', signals: [] },
    { id: 'width-meter', name: '后测宽', signals: [] },
    { id: 'floater', name: '浮动辊系统', role: '9 辊', signals: [] },
    { id: 'reel', name: '卷取', signals: [] },
  ];
  for (const s of SEGMENTS) s.signals = SIGNALS.filter((sig) => sig.segment === s.id).map((sig) => sig.tag);

  const DEVICE = {
    id: '6-sidewall-line',
    name: '6# 胎侧四复合挤出生产线',
    vendor: '浦林成山 + CCFC',
    type: 'extrusion-quadruple-line',
    segments: SEGMENTS,
    signals: SIGNALS,
  };

  // ─── Steady-state seed values ─────────────────────────────────────────

  const SETPOINTS = {
    'EXT-90.SPEED': 7.6, 'EXT-T.SPEED': 5.1, 'EXT-M.SPEED': 5.1, 'EXT-B.SPEED': 4.2,
    'EXT-90.SPEED.SP': 7.6, 'EXT-T.SPEED.SP': 5.1, 'EXT-M.SPEED.SP': 5.1, 'EXT-B.SPEED.SP': 4.2,
    'TT-DIE-T.PV': 75.0, 'TT-DIE-TM.PV': 75.0, 'TT-DIE-M.PV': 75.0, 'TT-DIE-BM.PV': 75.0, 'TT-DIE-B.PV': 75.0,
    'TT-DIE-T.SP': 75.0, 'TT-DIE-TM.SP': 75.0, 'TT-DIE-M.SP': 75.0, 'TT-DIE-BM.SP': 75.0, 'TT-DIE-B.SP': 75.0,
    'PT-150T.PV': 18.6, 'PT-150M.PV': 18.2, 'PT-150B.PV': 17.4, 'PT-90.PV': 20.1,
    'EXT-T.PRESSURE': 18.6, 'EXT-M.PRESSURE': 18.2, 'EXT-B.PRESSURE': 17.4, 'EXT-90.PRESSURE': 20.1,
    'EXT-T.MELT_TEMP': 70, 'EXT-M.MELT_TEMP': 70, 'EXT-B.MELT_TEMP': 73, 'EXT-90.MELT_TEMP': 85,
    'MOT-150T.CURRENT': 95, 'MOT-150M.CURRENT': 92, 'MOT-150B.CURRENT': 78, 'MOT-90.CURRENT': 110,
    'TAKEUP.SPEED': 5.0, 'TAKEUP.SPEED.SP': 5.0, 'REEL.LENGTH': 75.0,
    'SHRINK.PV': 4.0, 'SCL-FRONT.PV': 0.750, 'SCL-FRONT.SP': 0.750,
    'SCL-REAR.PV': 0.748, 'SCL-REAR.SP': 0.750, 'WIDTH-REAR.PV': 165.0, 'WIDTH-REAR.SP': 165.0,
    'TENSION.PV': 1.2,
  };
  for (let i = 1; i <= 9; i += 1) {
    SETPOINTS[`FLT-${i}.POS`] = 50.0;
    SETPOINTS[`FLT-${i}.PRESSURE`] = [0.30, 0.10, 1.00, 0.30, 1.00, 2.00, 1.20, 0.80, 0.90][i - 1];
  }
  // Extruder zone temps default
  for (const id of ['150T', '150M', '150B', '90']) {
    for (const [z, base] of [['Z1', 60], ['Z2', 65], ['Z3', 70]]) SETPOINTS[`TT-${id}-${z}.PV`] = base;
    for (const [z, base] of [['Z1', 60], ['Z2', 65], ['Z3', 70]]) SETPOINTS[`TT-${id}-${z}.SP`] = base;
  }
  SETPOINTS['TT-90-Z1.PV'] = 75; SETPOINTS['TT-90-Z2.PV'] = 80; SETPOINTS['TT-90-Z3.PV'] = 85;
  SETPOINTS['TT-90-Z1.SP'] = 75; SETPOINTS['TT-90-Z2.SP'] = 80; SETPOINTS['TT-90-Z3.SP'] = 85;

  // ─── State ────────────────────────────────────────────────────────────

  const state = {};
  let estopActive = false;
  let pinnSource = 'pinn';
  let mode = 'manual';
  let cycleCount = 0;
  let appliedCount = 0;
  let rejectedCount = 0;
  let workorderQty = 75.0;

  // Initialize state
  function noise(r, frac = 0.005) {
    return (Math.random() - 0.5) * 2 * r * frac;
  }
  for (const sig of SIGNALS) {
    const sp = SETPOINTS[sig.tag] ?? (sig.range ? (sig.range[0] + sig.range[1]) / 2 : 0);
    state[sig.tag] = {
      tag: sig.tag,
      value: sig.unit === 'bool' ? false : sp + noise(sig.range?.[1] ?? 1, 0.001),
      quality: 'good',
      timestamp: Date.now(),
    };
  }

  function currentSnapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  // Recipes & workorders
  const RECIPES = [
    {
      id: 'PS1226-S62-v2.4', spec: 'PS1226', name: '半钢胎侧 22"', variant: 'S6/2',
      die_pre: 'S0275', die_plate: '06S06', version: '2.4', status: 'in_use',
      approver: '王厂长', approved_at: '2026-04-25T09:30:00Z',
      parameters: {
        'EXT-90.SPEED.SP': 7.6, 'EXT-T.SPEED.SP': 5.1, 'EXT-M.SPEED.SP': 5.1, 'EXT-B.SPEED.SP': 4.2,
        'TAKEUP.SPEED.SP': 5.0, 'SCL-FRONT.SP': 0.750, 'SCL-REAR.SP': 0.750, 'WIDTH-REAR.SP': 165.0,
      },
      tcu_zones: { 'TT-DIE-T.SP': 75.0, 'TT-DIE-TM.SP': 75.0, 'TT-DIE-M.SP': 75.0, 'TT-DIE-BM.SP': 75.0, 'TT-DIE-B.SP': 75.0 },
      change_log: [{ from_version: '2.3', to_version: '2.4', date: '2026-04-27', operator: '王建国', changes: ['上挤出机速度: 5.0 → 5.1 RPM'] }],
    },
    {
      id: 'PS1108-S54-v3.1', spec: 'PS1108', name: '半钢胎侧 19"', variant: 'S5/4',
      die_pre: 'S0118', die_plate: '06S03', version: '3.1', status: 'approved',
      approver: '王厂长', approved_at: '2026-04-20T10:00:00Z',
      parameters: { 'EXT-T.SPEED.SP': 4.5, 'TAKEUP.SPEED.SP': 4.5, 'SCL-FRONT.SP': 0.612, 'WIDTH-REAR.SP': 142.0 },
      tcu_zones: { 'TT-DIE-T.SP': 72.0, 'TT-DIE-TM.SP': 72.0, 'TT-DIE-M.SP': 72.0 },
      change_log: [],
    },
  ];
  const WORKORDERS = [
    { id: 'PS1226-2604-B12', spec: 'PS1226', size: '22" 半钢胎侧', recipe: { id: 'PS1226-S62-v2.4', version: '2.4' },
      die_pre: 'S0275', die_plate: '06S06', shift: 'B', date: new Date().toISOString().slice(0, 10),
      plan_qty: 1000, produced_qty: 75.0, start_at: new Date(Date.now() - 1800_000).toISOString(), status: 'running', operator: '李振华' },
    { id: 'PS1108-2604-B13', spec: 'PS1108', size: '19" 半钢胎侧', recipe: { id: 'PS1108-S54-v3.1', version: '3.1' },
      die_pre: 'S0118', die_plate: '06S03', shift: 'B', date: new Date().toISOString().slice(0, 10),
      plan_qty: 800, produced_qty: 0, status: 'pending' },
  ];
  let alarmsActive = [];
  let alarmsHistory = [];
  let alarmSeq = 0;
  function makeAlarm(tag, tier, type, message, source) {
    alarmSeq += 1;
    const now = Date.now();
    return {
      id: `alarm-demo-${alarmSeq}`, tag, tier, type, message, source,
      state: 'unack', occurred_at: now, count: 1, last_occurred_at: now,
    };
  }
  // Seed some active alarms
  alarmsActive.push(makeAlarm('TT-150B-Z3', 2, 'process', '下挤出机胶温低于设定 −1.2 °C · 实测 73.8 / 设定 75.0', 'EXT-150-B'));
  alarmsActive.push(makeAlarm('SCL-REAR', 3, 'process', '后连续秤称重偏差 −0.27% 持续 4 分钟 · 0.748 / 标准 0.750 KG/M', 'SCALE-R'));

  const recentCycles = [];
  const trainingJobs = [
    { id: 'job-demo-001', kind: 'quality', state: 'completed', operator: '王建国',
      created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
      epochs_completed: 200, epochs_total: 200, evaluation_json: '{"rmse":0.32}', model_version_id: 'quality-2026.04.28-v2' },
    { id: 'job-demo-002', kind: 'quality', state: 'failed', operator: '王建国', error: 'OOM',
      created_at: new Date(Date.now() - 5 * 86400000).toISOString(),
      epochs_completed: 47, epochs_total: 300 },
    { id: 'job-demo-003', kind: 'anomaly', state: 'completed', operator: '李振华',
      created_at: new Date(Date.now() - 7 * 86400000).toISOString(),
      epochs_completed: 100, epochs_total: 100 },
  ];
  const trainingModels = [
    { id: 'quality-2026.04.28-v2', kind: 'quality', version: 'v2', status: 'in_use', deployed_at: new Date(Date.now() - 2 * 86400000).toISOString() },
    { id: 'quality-2026.04.30-v3', kind: 'quality', version: 'v3', status: 'shadow', deployed_at: new Date(Date.now() - 6 * 3600_000).toISOString() },
    { id: 'anomaly-2026.04.23-v1', kind: 'anomaly', version: 'v1', status: 'in_use', deployed_at: new Date(Date.now() - 7 * 86400000).toISOString() },
  ];

  // ─── Physical coupling — derive PV targets from upstream signals ─────
  //
  // 真实工业逻辑：
  //   PT-* (压力)  ← f(EXT-*.SPEED, TT-DIE-*.PV)：速度↑、模头温度↓ → 压力↑
  //   MOT-*.CURRENT ← f(PT-*.PV)：压力↑ → 电流↑
  //   TT-DIE-*.PV  ← TT-DIE-*.SP 一阶滞后 (热惯性)
  //   EXT-*.SPEED  ← EXT-*.SPEED.SP 一阶滞后 (RPM 响应较快)
  //   SCL-*.PV     ← SCL-*.SP 加挤出速度比例噪声
  //   REEL.LENGTH  ← TAKEUP.SPEED 累积积分

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /** 基于上游信号 + setpoint 推导每个 PV 的瞬时目标，返回 {tag: target} */
  function deriveTargets() {
    const t = {};
    // 1. SP 直接驱动同名 PV (SP→PV 一阶滞后追随)
    //    EXT-T.SPEED.SP → EXT-T.SPEED ; TT-DIE-T.SP → TT-DIE-T.PV
    for (const sig of SIGNALS) {
      if (sig.kind !== 'sp') continue;
      let pvTag;
      if (sig.tag.endsWith('.SPEED.SP')) pvTag = sig.tag.replace(/\.SP$/, '');
      else if (sig.tag.endsWith('.SP')) pvTag = sig.tag.replace(/\.SP$/, '.PV');
      else continue;
      if (state[pvTag]) t[pvTag] = SETPOINTS[sig.tag] ?? state[pvTag].value;
    }
    // 2. 模头温度按 SP 跟随（已含在 1）
    // 3. 挤出机熔体压力 = f(speed, die_temp_avg)
    const dieAvg = ['TT-DIE-T.PV','TT-DIE-TM.PV','TT-DIE-M.PV','TT-DIE-BM.PV','TT-DIE-B.PV']
      .map(k => state[k]?.value ?? 75).reduce((a,b)=>a+b,0) / 5;
    const tempFactor = 1 + (75 - dieAvg) * 0.012;  // temp ↓ → 压力 ↑
    for (const [extId, baseP] of [['T', 18.6], ['M', 18.2], ['B', 17.4], ['90', 20.1]]) {
      const speed = state[`EXT-${extId}.SPEED`]?.value ?? 5;
      const speedRef = SETPOINTS[`EXT-${extId}.SPEED.SP`] ?? 5;
      const speedFactor = 1 + (speed - speedRef) * 0.06;
      const ptTag = `PT-${extId === '90' ? '90' : '150' + extId}.PV`;
      const aliasTag = `EXT-${extId}.PRESSURE`;
      const target = baseP * tempFactor * speedFactor;
      if (state[ptTag]) t[ptTag] = target;
      if (state[aliasTag]) t[aliasTag] = target;
    }
    // 4. 主电机电流 = base + 4.5 * pressure
    for (const extId of ['150T', '150M', '150B', '90']) {
      const p = state[`PT-${extId}.PV`]?.value ?? 18;
      if (state[`MOT-${extId}.CURRENT`]) t[`MOT-${extId}.CURRENT`] = 30 + p * 4.5;
    }
    // 5. 挤出机熔体温度 = die_avg + 12 + 0.6 * (speed - 5)
    for (const extId of ['T','M','B','90']) {
      const speed = state[`EXT-${extId}.SPEED`]?.value ?? 5;
      const baseRef = extId === '90' ? 85 : extId === 'B' ? 73 : 70;
      const tag = `EXT-${extId}.MELT_TEMP`;
      if (state[tag]) t[tag] = baseRef + (speed - (extId === '90' ? 7.6 : extId === 'B' ? 4.2 : 5.1)) * 1.5;
    }
    // 6. 挤出机区域温度 SP→PV 跟随（已含在 1）
    // 7. 称重 / 测宽 — 跟设定 + 速度小扰动
    const speedAvg = ['EXT-T.SPEED','EXT-M.SPEED','EXT-B.SPEED','EXT-90.SPEED']
      .map(k => state[k]?.value ?? 5).reduce((a,b)=>a+b,0) / 4;
    const speedDev = (speedAvg - 5.5) * 0.002;
    if (state['SCL-FRONT.PV']) t['SCL-FRONT.PV'] = (SETPOINTS['SCL-FRONT.SP'] ?? 0.75) + speedDev;
    if (state['SCL-REAR.PV'])  t['SCL-REAR.PV']  = (SETPOINTS['SCL-REAR.SP']  ?? 0.75) + speedDev * 0.9;
    if (state['WIDTH-REAR.PV']) {
      const takeup = state['TAKEUP.SPEED']?.value ?? 5;
      t['WIDTH-REAR.PV'] = (SETPOINTS['WIDTH-REAR.SP'] ?? 165) + (5 - takeup) * 0.6;
    }
    // 8. 浮动辊位置 跟 SP；压力按位置略微偏置
    for (let i = 1; i <= 9; i += 1) {
      if (state[`FLT-${i}.POS`]) t[`FLT-${i}.POS`] = SETPOINTS[`FLT-${i}.POS`] ?? 50;
    }
    // 9. 张力 ≈ 浮动辊平均压力
    const fltAvg = Array.from({length:9},(_,i)=>state[`FLT-${i+1}.PRESSURE`]?.value ?? 1).reduce((a,b)=>a+b,0)/9;
    if (state['TENSION.PV']) t['TENSION.PV'] = fltAvg;
    return t;
  }

  // ─── Tick (1 Hz simulation) ───────────────────────────────────────────

  function tick() {
    if (estopActive) return;
    const now = Date.now();
    const changed = [];
    const targets = deriveTargets();

    for (const sig of SIGNALS) {
      if (sig.unit === 'bool' || sig.kind === 'sp') continue;
      const range = sig.range ?? [0, 1];
      const span = range[1] - range[0];
      const cur = state[sig.tag].value;
      const target = targets[sig.tag] ?? SETPOINTS[sig.tag] ?? cur;

      // Time constant by signal type — temperatures lag, pressures fast, weights slow
      let tau = 0.06;  // default 6% per tick
      if (sig.unit === '°C') tau = 0.03;        // thermal mass
      else if (sig.unit === 'MPA' && sig.tag.startsWith('PT-')) tau = 0.15;
      else if (sig.unit === 'A') tau = 0.2;
      else if (sig.unit === 'KG/M') tau = 0.05;
      else if (sig.unit === 'MM' && sig.tag.startsWith('FLT')) tau = 0.08;

      const drift = (target - cur) * tau;
      // Limit single-tick change to 0.4% of span (smooth visual)
      const maxStep = span * 0.004;
      const stepped = clamp(drift, -maxStep, maxStep);
      const noiseAmp = sig.unit === '°C' ? 0.0012 : sig.unit === 'MPA' ? 0.0018 : 0.0015;
      const next = cur + stepped + noise(span, noiseAmp);
      const clamped = clamp(next, range[0], range[1]);

      if (Math.abs(clamped - cur) > span * 0.0001) {
        const sv = { tag: sig.tag, value: clamped, quality: 'good', timestamp: now };
        state[sig.tag] = sv;
        changed.push(sv);
      }
    }

    // Workorder progress driven by actual TAKEUP speed
    const takeup = state['TAKEUP.SPEED']?.value ?? 5;
    workorderQty += takeup / 60;
    state['REEL.LENGTH'] = { tag: 'REEL.LENGTH', value: workorderQty, quality: 'good', timestamp: now };
    WORKORDERS[0].produced_qty = Math.round(workorderQty * 10) / 10;

    // Threshold-driven alarms (auto-raise / auto-clear)
    evaluateAlarms(now);

    // Broadcast signal_delta (cap to keep WS payload small)
    if (changed.length) wsBroadcast({ type: 'signal_delta', data: changed.slice(0, 40), ts: now });
    if (Math.floor(now / 500) % 2 === 0) {
      wsBroadcast({ type: 'workorder_progress', data: { id: WORKORDERS[0].id, produced_qty: WORKORDERS[0].produced_qty } });
    }
  }
  setInterval(tick, 1000);

  // ─── Threshold-driven alarm engine ───────────────────────────────────

  const ALARM_DESC = {
    'TT-DIE-T.PV': { hi: '上模温度过高 +', lo: '上模温度过低 ', unit: '°C', sp: 'TT-DIE-T.SP' },
    'TT-DIE-TM.PV': { hi: '上中模温度过高 +', lo: '上中模温度过低 ', unit: '°C', sp: 'TT-DIE-TM.SP' },
    'TT-DIE-M.PV': { hi: '中模温度过高 +', lo: '中模温度过低 ', unit: '°C', sp: 'TT-DIE-M.SP' },
    'TT-DIE-BM.PV': { hi: '下中模温度过高 +', lo: '下中模温度过低 ', unit: '°C', sp: 'TT-DIE-BM.SP' },
    'TT-DIE-B.PV': { hi: '下模温度过高 +', lo: '下模温度过低 ', unit: '°C', sp: 'TT-DIE-B.SP' },
    'PT-150T.PV': { hi: '上挤出机熔体压力高 ', lo: '上挤出机压力低 ', unit: 'MPa', limit: { hi: 25, hh: 28 } },
    'PT-150M.PV': { hi: '中挤出机压力高 ', lo: '中挤出机压力低 ', unit: 'MPa', limit: { hi: 25, hh: 28 } },
    'PT-150B.PV': { hi: '下挤出机压力高 ', lo: '下挤出机压力低 ', unit: 'MPa', limit: { hi: 25, hh: 28 } },
    'PT-90.PV': { hi: '90挤出机压力高 ', lo: '90挤出机压力低 ', unit: 'MPa', limit: { hi: 25, hh: 28 } },
    'WIDTH-REAR.PV': { hi: '后测宽偏宽 +', lo: '后测宽偏窄 ', unit: 'MM', sp: 'WIDTH-REAR.SP', tol: 3 },
    'SCL-FRONT.PV': { hi: '前秤偏重 ', lo: '前秤偏轻 ', unit: 'KG/M', sp: 'SCL-FRONT.SP', tol: 0.015 },
    'SCL-REAR.PV': { hi: '后秤偏重 ', lo: '后秤偏轻 ', unit: 'KG/M', sp: 'SCL-REAR.SP', tol: 0.015 },
  };

  function evaluateAlarms(now) {
    for (const [tag, desc] of Object.entries(ALARM_DESC)) {
      const sv = state[tag]; if (!sv) continue;
      const v = sv.value;
      let breach = null;  // { tier, msg }
      if (desc.limit) {
        if (v > desc.limit.hh) breach = { tier: 1, msg: `${desc.hi}${v.toFixed(1)} ${desc.unit} 超 Tier 1 (${desc.limit.hh})` };
        else if (v > desc.limit.hi) breach = { tier: 2, msg: `${desc.hi}${v.toFixed(1)} ${desc.unit} 超 ${desc.limit.hi}` };
      } else if (desc.sp) {
        const sp = SETPOINTS[desc.sp] ?? v;
        const dev = v - sp;
        const tol = desc.tol || 1.5;
        if (Math.abs(dev) > tol * 1.8) {
          breach = { tier: 2, msg: dev > 0 ? `${desc.hi}${dev.toFixed(2)} ${desc.unit}` : `${desc.lo}${dev.toFixed(2)} ${desc.unit}` };
        } else if (Math.abs(dev) > tol) {
          breach = { tier: 3, msg: dev > 0 ? `${desc.hi}${dev.toFixed(2)} ${desc.unit}` : `${desc.lo}${dev.toFixed(2)} ${desc.unit}` };
        }
      }

      const existing = alarmsActive.find((a) => a.tag === tag);
      if (breach) {
        if (existing && existing.tier === breach.tier && existing.message.startsWith(breach.msg.slice(0, 6))) {
          // same alarm continuing — bump count occasionally
          if ((now - existing.last_occurred_at) > 30_000) {
            existing.count += 1; existing.last_occurred_at = now;
            wsBroadcast({ type: 'alarm_update', data: existing });
          }
        } else if (!existing) {
          const a = makeAlarm(tag, breach.tier, 'process', breach.msg, tag.split('.')[0]);
          alarmsActive.push(a); alarmsHistory.push(a);
          wsBroadcast({ type: 'alarm_new', data: a });
        }
      } else if (existing && existing.state !== 'cleared' && (now - existing.last_occurred_at) > 8_000) {
        // signal recovered for 8s → auto-clear
        existing.state = 'cleared'; existing.cleared_at = now;
        const idx = alarmsActive.indexOf(existing);
        if (idx >= 0) alarmsActive.splice(idx, 1);
        wsBroadcast({ type: 'alarm_cleared', data: { id: existing.id } });
      }
    }
  }

  // Disabled — replaced by threshold engine above
  setInterval(() => {
    if (false && Math.random() < 0.4) {
      const seedTags = ['TT-150B-Z3', 'PT-150T', 'FLT-06.PRESSURE', 'WIDTH-REAR.PV', 'SCL-REAR'];
      const tier = Math.random() < 0.3 ? 2 : 3;
      const tag = seedTags[Math.floor(Math.random() * seedTags.length)];
      const existing = alarmsActive.find((a) => a.tag === tag);
      if (existing) {
        existing.count += 1;
        existing.last_occurred_at = Date.now();
        wsBroadcast({ type: 'alarm_update', data: existing });
      } else {
        const a = makeAlarm(tag, tier, 'process', `${tag} 偏差告警 · 演示`, tag.split('.')[0]);
        alarmsActive.push(a);
        wsBroadcast({ type: 'alarm_new', data: a });
      }
    }
  }, 25000);

  // PINN status flip every ~90s (demo banner)
  setInterval(() => {
    pinnSource = pinnSource === 'pinn' ? 'mock_fallback' : 'pinn';
    wsBroadcast({
      type: 'pinn_status_change',
      data: {
        state: pinnSource,
        reason: pinnSource === 'mock_fallback' ? 'demo: PINN 服务不可达' : 'demo: PINN 已恢复',
        recent_errors: [],
      },
    });
  }, 90000);

  // Closed-loop cycle event every ~12s
  setInterval(() => {
    cycleCount += 1;
    const passed = pinnSource === 'pinn' && Math.random() > 0.2;
    if (passed) appliedCount += 1; else rejectedCount += 1;
    const cycle = {
      id: `cycle-demo-${cycleCount}`,
      timestamp: Date.now(),
      source: 'pinn',
      trigger: mode === 'auto_tune' ? 'auto_tune_cycle' : 'operator_apply',
      initiated_by: mode === 'auto_tune' ? 'auto_tune' : '李振华',
      pinn_confidence: 0.75 + Math.random() * 0.2,
      pinn_model_version: 'quality-2026.04.28-v2',
      pinn_source: pinnSource,
      proposals: [
        {
          tag: 'TT-DIE-T.SP', label: '上模温度设定', unit: '°C',
          current: 75.0, proposed: 75.0 + (Math.random() - 0.5) * 0.6,
          delta: 0.3, delta_pct: 0.4,
          gates: passed
            ? [
                { gate: 'source', passed: true }, { gate: 'alarm', passed: true },
                { gate: 'mode', passed: true }, { gate: 'shadow', passed: true },
                { gate: 'range', passed: true }, { gate: 'deviation', passed: true },
                { gate: 'rate', passed: true },
              ]
            : [
                { gate: 'source', passed: false, reason: 'mock_fallback in auto_tune' },
              ],
          applied: passed,
          decision: passed ? 'applied' : 'rejected',
          rejection_reason: passed ? undefined : 'PINN in mock_fallback',
        },
      ],
      overall_status: passed ? 'applied' : 'rejected',
      applied_count: passed ? 1 : 0,
      rejected_count: passed ? 0 : 1,
    };
    recentCycles.unshift(cycle);
    if (recentCycles.length > 50) recentCycles.pop();
    wsBroadcast({ type: 'cycle_complete', data: {
      cycle_id: cycle.id, mode, source: cycle.pinn_source,
      model_version: cycle.pinn_model_version,
      applied_count: cycle.applied_count, rejected_count: cycle.rejected_count,
      latency_ms: 80 + Math.random() * 200,
    } });
    wsBroadcast({ type: 'control_cycle', data: cycle });
  }, 12000);

  // ─── WebSocket interceptor ───────────────────────────────────────────

  const wsClients = new Set();
  function wsBroadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of wsClients) {
      if (ws.readyState !== 1) continue;
      try {
        const ev = new MessageEvent('message', { data });
        if (typeof ws.onmessage === 'function') ws.onmessage(ev);
        ws.dispatchEvent?.(ev);
      } catch (e) { /* ignore */ }
    }
  }

  class FakeWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;        // CONNECTING
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      setTimeout(() => {
        this.readyState = 1;       // OPEN
        const ev = new Event('open');
        this.onopen?.(ev);
        this.dispatchEvent(ev);
        // Send full snapshot on connect (mirrors backend)
        const snap = currentSnapshot();
        const msg = new MessageEvent('message', { data: JSON.stringify({ type: 'signals', data: snap, ts: Date.now() }) });
        this.onmessage?.(msg);
        this.dispatchEvent(msg);
        wsClients.add(this);
        // Send current PINN status if degraded
        if (pinnSource === 'mock_fallback') {
          const m = new MessageEvent('message', { data: JSON.stringify({ type: 'pinn_status_change', data: { state: 'mock_fallback', reason: 'demo on connect', recent_errors: [] } }) });
          this.onmessage?.(m);
          this.dispatchEvent(m);
        }
      }, 50);
    }
    send(_data) { /* demo: no-op */ }
    close(code) {
      this.readyState = 3;
      wsClients.delete(this);
      const ev = new CloseEvent('close', { code: code ?? 1000 });
      this.onclose?.(ev);
      this.dispatchEvent(ev);
    }
  }
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  window.WebSocket = FakeWebSocket;

  // ─── REST interceptor ────────────────────────────────────────────────

  const realFetch = window.fetch.bind(window);
  function jsonResponse(data, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  async function handleApi(method, path, body) {
    // Auth (always succeed)
    if (method === 'POST' && path === '/api/auth/login') {
      return jsonResponse({
        access_token: 'demo-access-token', refresh_token: 'demo-refresh-token',
        expires_in: 1800, refresh_expires_in: 604800,
        user: { id: 'demo', name: body?.username || 'Demo', level: 4, shift: 'A' },
      });
    }
    if (method === 'POST' && path === '/api/auth/refresh') {
      return jsonResponse({
        access_token: 'demo-access-token-refreshed', refresh_token: 'demo-refresh-token',
        expires_in: 1800, refresh_expires_in: 604800,
        user: { id: 'demo', name: 'Demo', level: 4, shift: 'A' },
      });
    }
    if (method === 'POST' && path === '/api/auth/logout') return jsonResponse({ ok: true });

    // Health
    if (method === 'GET' && path === '/health') return jsonResponse({ ok: true, version: '0.5.0-demo', env: 'demo', simulator_running: !estopActive, pinn_source: pinnSource, active_alarms: alarmsActive.length, db: false });

    // Device & signals
    if (method === 'GET' && path === '/api/device') return jsonResponse(DEVICE);
    if (method === 'GET' && path === '/api/signals') return jsonResponse(currentSnapshot());
    const sigMatch = path.match(/^\/api\/signals\/(.+)$/);
    if (method === 'GET' && sigMatch) {
      const sv = state[decodeURIComponent(sigMatch[1])];
      return sv ? jsonResponse(sv) : jsonResponse({ error: { code: 'NOT_FOUND', message: 'signal not found' } }, 404);
    }

    // Recipes
    if (method === 'GET' && path.startsWith('/api/recipes')) {
      if (path === '/api/recipes' || path.startsWith('/api/recipes?')) {
        const url = new URL('http://x' + path);
        let list = RECIPES.slice();
        const spec = url.searchParams.get('spec');
        const status = url.searchParams.get('status');
        if (spec) list = list.filter((r) => r.spec === spec);
        if (status) list = list.filter((r) => r.status === status);
        return jsonResponse(list);
      }
      if (path === '/api/recipes/in-use') {
        const r = RECIPES.find((x) => x.status === 'in_use');
        return r ? jsonResponse(r) : jsonResponse({ error: 'not found' }, 404);
      }
      const m = path.match(/^\/api\/recipes\/([^/]+)$/);
      if (m) {
        const r = RECIPES.find((x) => x.id === m[1]);
        return r ? jsonResponse(r) : jsonResponse({ error: 'not found' }, 404);
      }
    }
    if (method === 'POST') {
      let m = path.match(/^\/api\/recipes\/([^/]+)\/clone$/);
      if (m) {
        const base = RECIPES.find((x) => x.id === m[1]);
        if (!base) return jsonResponse({ error: 'not found' }, 404);
        const v = parseFloat(base.version) + 0.1;
        const draft = { ...base, id: base.id.replace(/v[\d.]+$/, `v${v.toFixed(1)}`), version: v.toFixed(1), status: 'draft' };
        RECIPES.unshift(draft);
        return jsonResponse(draft);
      }
      m = path.match(/^\/api\/recipes\/([^/]+)\/approve$/);
      if (m) {
        const r = RECIPES.find((x) => x.id === m[1]);
        if (!r) return jsonResponse({ error: 'not found' }, 404);
        r.status = 'approved'; r.approver = body?.approver || 'demo';
        r.approved_at = new Date().toISOString();
        return jsonResponse(r);
      }
      m = path.match(/^\/api\/recipes\/([^/]+)\/apply$/);
      if (m) {
        const r = RECIPES.find((x) => x.id === m[1]);
        if (!r) return jsonResponse({ error: 'not found' }, 404);
        for (const other of RECIPES) if (other.status === 'in_use' && other.id !== r.id) other.status = 'archived';
        r.status = 'in_use';
        return jsonResponse({ ...r, applied: Object.keys(r.parameters), rejected: [] });
      }
    }

    // Workorders
    if (method === 'GET' && path.startsWith('/api/workorders')) {
      if (path === '/api/workorders/current' || path.match(/^\/api\/workorders\/current/)) return jsonResponse(WORKORDERS[0]);
      if (path === '/api/workorders' || path.startsWith('/api/workorders?')) return jsonResponse(WORKORDERS);
    }
    if (method === 'POST' && path === '/api/workorders/start-next') {
      const next = WORKORDERS.find((w) => w.status === 'pending');
      if (next) { next.status = 'running'; next.start_at = new Date().toISOString(); }
      return jsonResponse(next || { error: 'no pending workorder' }, next ? 200 : 400);
    }

    // Alarms
    if (method === 'GET' && path === '/api/alarms') return jsonResponse(alarmsActive);
    if (method === 'GET' && path.startsWith('/api/alarms/history')) return jsonResponse(alarmsHistory.slice(-50));
    if (method === 'GET' && path === '/api/alarms/stats') {
      const byTier = { 1: 0, 2: 0, 3: 0, 4: 0 };
      for (const a of alarmsActive) byTier[a.tier] = (byTier[a.tier] || 0) + 1;
      return jsonResponse({ active_total: alarmsActive.length, history_total: alarmsHistory.length, by_tier: byTier });
    }
    if (method === 'POST') {
      const m = path.match(/^\/api\/alarms\/([^/]+)\/ack$/);
      if (m) {
        const a = alarmsActive.find((x) => x.id === m[1]);
        if (a) { a.state = 'ack'; a.acknowledged_at = Date.now(); a.acknowledged_by = body?.operator || 'demo'; }
        wsBroadcast({ type: 'alarm_update', data: a });
        return jsonResponse({ ok: true });
      }
      if (path === '/api/alarms/ack-all') {
        let n = 0;
        for (const a of alarmsActive) if (a.state === 'unack') { a.state = 'ack'; a.acknowledged_at = Date.now(); a.acknowledged_by = body?.operator; n += 1; }
        return jsonResponse({ acknowledged: n });
      }
    }

    // Audit
    if (method === 'GET' && path.startsWith('/api/audit')) return jsonResponse([]);

    // Control
    if (method === 'GET' && path === '/api/control/config') {
      return jsonResponse({
        mode, cycle_interval_sec: 300,
        gates: { deviation_pct_max: 5, rate_limit_sec: 600, require_lv3_for_auto_tune: true, auto_fallback_on_alarm: true, abort_on_estop: true },
        last_cycle_at: recentCycles[0]?.timestamp,
      });
    }
    if (method === 'GET' && path === '/api/control/stats') {
      const byGate = { source: 0, alarm: 0, mode: 0, shadow: 0, range: 0, deviation: 0, rate: 0 };
      for (const c of recentCycles) for (const p of c.proposals) for (const g of p.gates) if (!g.passed) byGate[g.gate] = (byGate[g.gate] || 0) + 1;
      return jsonResponse({ applied_total: appliedCount, rejected_total: rejectedCount, by_gate: byGate });
    }
    if (method === 'GET' && path.startsWith('/api/control/cycles')) {
      if (path.includes('/last')) return jsonResponse(recentCycles[0] || { error: 'no cycles' }, recentCycles[0] ? 200 : 404);
      const url = new URL('http://x' + path);
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      return jsonResponse(recentCycles.slice(0, limit));
    }
    if (method === 'POST') {
      if (path === '/api/control/auto-tune/enable') {
        if (pinnSource === 'mock_fallback') return jsonResponse({ error: { message: 'cannot enable auto_tune while PINN is in mock_fallback' } }, 400);
        mode = 'auto_tune';
        wsBroadcast({ type: 'control_mode_changed', data: { mode, by: body?.user_name || 'demo' } });
        return jsonResponse({ mode, gates: { deviation_pct_max: 5, rate_limit_sec: 600, require_lv3_for_auto_tune: true, auto_fallback_on_alarm: true, abort_on_estop: true } });
      }
      if (path === '/api/control/auto-tune/disable') {
        mode = body?.reason?.includes('manual') ? 'manual' : 'advisory';
        wsBroadcast({ type: 'control_mode_changed', data: { mode, by: body?.user_name || 'demo', reason: body?.reason } });
        return jsonResponse({ mode, gates: { deviation_pct_max: 5, rate_limit_sec: 600, require_lv3_for_auto_tune: true, auto_fallback_on_alarm: true, abort_on_estop: true } });
      }
      if (path === '/api/control/advisory/apply') {
        const props = body?.proposed_setpoints || {};
        for (const [tag, v] of Object.entries(props)) SETPOINTS[tag] = v;
        return jsonResponse({ id: 'cycle-advisory', overall_status: 'applied', applied_count: Object.keys(props).length, rejected_count: 0, proposals: [] });
      }
      if (path === '/api/control/estop') {
        estopActive = true;
        wsBroadcast({ type: 'estop', data: { reason: body?.reason || 'demo' } });
        return jsonResponse({ ok: true });
      }
      if (path === '/api/control/estop-reset') {
        estopActive = false;
        return jsonResponse({ ok: true });
      }
    }

    // PINN
    if (method === 'GET' && path === '/api/pinn/health') return jsonResponse({ healthy: pinnSource === 'pinn', breaker: pinnSource === 'pinn' ? 'closed' : 'open', models: trainingModels.filter((m) => m.status === 'in_use') });
    if (method === 'GET' && path === '/api/pinn/prediction/latest') return jsonResponse({ prediction: { thickness_mean: 3.42, width_mean: 165.0, weight_per_meter: 0.750, predicted_cpk: 1.42 }, confidence: 0.85, source: pinnSource, model_version: 'quality-2026.04.28-v2' });
    if (method === 'GET' && path === '/api/pinn/anomaly/latest') return jsonResponse({ score: 0.12, anomaly_score: 0.12, leading_features: [], source: pinnSource });

    // Training
    if (method === 'GET' && path === '/api/training/jobs') return jsonResponse(trainingJobs);
    if (method === 'GET' && path === '/api/training/models') return jsonResponse(trainingModels);
    if (method === 'GET' && path === '/api/training/datasets') return jsonResponse([]);
    if (method === 'POST' && path === '/api/training/jobs') {
      const job = {
        id: `job-demo-${Date.now()}`, kind: body?.kind || 'quality', state: 'running',
        operator: body?.operator || 'demo', created_at: new Date().toISOString(),
        epochs_completed: 0, epochs_total: body?.epochs || 100,
      };
      trainingJobs.unshift(job);
      // Simulate progress
      let n = 0;
      const t = setInterval(() => {
        n += 5;
        job.epochs_completed = n;
        if (n >= job.epochs_total) {
          job.state = 'completed';
          clearInterval(t);
        }
      }, 800);
      return jsonResponse(job);
    }
    if (method === 'POST' && path === '/api/training/datasets') {
      return jsonResponse({ id: `ds-demo-${Date.now()}`, ...body });
    }
    const dpm = path.match(/^\/api\/training\/models\/([^/]+)\/deploy$/);
    if (method === 'POST' && dpm) {
      const m = trainingModels.find((x) => x.id === dpm[1]);
      if (!m) return jsonResponse({ error: 'not found' }, 404);
      if (body?.mode === 'in_use') {
        for (const o of trainingModels) if (o.kind === m.kind && o.status === 'in_use') o.status = 'archived';
        m.status = 'in_use'; m.deployed_at = new Date().toISOString();
      } else {
        m.status = 'shadow';
      }
      return jsonResponse(m);
    }

    // Metrics & misc
    if (method === 'GET' && path === '/metrics') return new Response('# demo metrics not available', { status: 200 });
    if (method === 'GET' && (path === '/livez' || path === '/readyz')) return jsonResponse({ ok: true });

    // Safe fallback: never 404 a /api/* request (would spam console + break loaders).
    // GET → empty array, POST → ok, others → empty object.
    if (method === 'GET') {
      console.debug('[PRINX demo] fallback empty array for', path);
      return jsonResponse([]);
    }
    if (method === 'POST') {
      console.debug('[PRINX demo] fallback ok for', method, path);
      return jsonResponse({ ok: true, mocked: true });
    }
    return jsonResponse({ ok: true, mocked: true });
  }

  window.fetch = function (input, init = {}) {
    let url, method, body;
    if (typeof input === 'string') {
      url = input; method = (init.method || 'GET').toUpperCase();
      try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    } else if (input instanceof Request) {
      url = input.url; method = input.method;
      try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    } else {
      return realFetch(input, init);
    }
    // Handle absolute or relative
    let path = url;
    try {
      const u = new URL(url, location.href);
      if (u.origin === location.origin) path = u.pathname + (u.search || '');
    } catch { /* ignore */ }
    if (!path.startsWith('/api/') && path !== '/health' && path !== '/livez' && path !== '/readyz' && path !== '/metrics') {
      return realFetch(input, init);
    }
    return handleApi(method, path, body);
  };

  // ─── Demo control panel + watermark ──────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    const watermark = document.createElement('button');
    watermark.id = 'prinx-demo-watermark';
    watermark.type = 'button';
    watermark.title = '点击展开演示控制';
    watermark.innerHTML = '<span style="color:#7cf;font-weight:600">DEMO</span> · 模拟器 ▴';
    watermark.style.cssText = `
      position: fixed; bottom: 6px; right: 8px; z-index: 9999;
      padding: 5px 10px; font-family: var(--ff-data, monospace);
      font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
      background: rgba(20, 35, 55, .92); color: #88c0e0;
      border: 1px solid #3a557a; cursor: pointer;
    `;
    document.body.appendChild(watermark);

    const panel = document.createElement('div');
    panel.id = 'prinx-demo-panel';
    panel.style.cssText = `
      position: fixed; bottom: 36px; right: 8px; z-index: 9999;
      width: 240px; padding: 12px; display: none;
      font-family: var(--ff-data, monospace); font-size: 11px;
      background: rgba(15, 25, 40, .96); color: #cfe;
      border: 1px solid #3a557a; box-shadow: 0 6px 20px rgba(0,0,0,.5);
    `;
    panel.innerHTML = `
      <div style="margin-bottom:6px;color:#7cf;letter-spacing:.15em;text-transform:uppercase">演示控制</div>
      <div style="margin-bottom:8px;color:#9ab;line-height:1.4">所有数据由浏览器模拟生成。</div>

      <div style="font-size:10px;color:#678;letter-spacing:.1em;text-transform:uppercase;margin:8px 0 4px">场景预设</div>
      <button data-act="scn-normal" style="width:100%;margin:2px 0;padding:6px;background:#1a3a2a;color:#8fc;border:1px solid #5a8;font-family:inherit;font-size:11px;cursor:pointer">★ 正常生产 (默认)</button>
      <button data-act="scn-overload" style="width:100%;margin:2px 0;padding:6px;background:#3a2a1a;color:#fb4;border:1px solid #fb4;font-family:inherit;font-size:11px;cursor:pointer">↑ 满负荷生产 (压力↑)</button>
      <button data-act="scn-drift" style="width:100%;margin:2px 0;padding:6px;background:#3a2010;color:#fb8;border:1px solid #fb8;font-family:inherit;font-size:11px;cursor:pointer">~ 工艺漂移 (温度异常)</button>
      <button data-act="scn-flood" style="width:100%;margin:2px 0;padding:6px;background:#3a1820;color:#f8a;border:1px solid #f8a;font-family:inherit;font-size:11px;cursor:pointer">⚠ 告警雪崩 (5 条)</button>
      <button data-act="scn-pinn-fail" style="width:100%;margin:2px 0;padding:6px;background:#2a1a3a;color:#caf;border:1px solid #caf;font-family:inherit;font-size:11px;cursor:pointer">✗ PINN 故障 (Gate 7)</button>

      <div style="font-size:10px;color:#678;letter-spacing:.1em;text-transform:uppercase;margin:10px 0 4px">单点动作</div>
      <button data-act="alarm" style="width:100%;margin:2px 0;padding:5px;background:transparent;color:#fb4;border:1px solid #564;font-family:inherit;font-size:11px;cursor:pointer">⚠ 触发新告警</button>
      <button data-act="pinn-flip" style="width:100%;margin:2px 0;padding:5px;background:transparent;color:#caf;border:1px solid #564;font-family:inherit;font-size:11px;cursor:pointer">↻ 切换 PINN 状态</button>
      <button data-act="estop" style="width:100%;margin:2px 0;padding:5px;background:transparent;color:#f88;border:1px solid #564;font-family:inherit;font-size:11px;cursor:pointer">■ 触发 E-STOP</button>
      <button data-act="reset" style="width:100%;margin:2px 0;padding:5px;background:transparent;color:#9cf;border:1px solid #564;font-family:inherit;font-size:11px;cursor:pointer">⟳ 重置全部 (刷新)</button>

      <div style="margin-top:10px;font-size:10px;color:#678;line-height:1.5;border-top:1px solid #3a557a;padding-top:6px">
        URL 加 <code style="background:#234;padding:1px 4px">?demo=0</code> 关闭模拟器
      </div>
    `;
    document.body.appendChild(panel);

    watermark.addEventListener('click', () => {
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      watermark.innerHTML = open ? '<span style="color:#7cf;font-weight:600">DEMO</span> · 模拟器 ▴' : '<span style="color:#7cf;font-weight:600">DEMO</span> · 模拟器 ▾';
    });

    function pulseToast(text, level) {
      const t = document.createElement('div');
      const colors = { ok: ['#1a3a2a', '#8fc', '#5a8'], warn: ['#3a2a1a', '#fb4', '#fb4'], crit: ['#3a1820', '#f8a', '#f8a'] };
      const [bg, fg, br] = colors[level] || colors.ok;
      t.textContent = text;
      t.style.cssText = `
        position: fixed; top: 38px; left: 50%; transform: translateX(-50%); z-index: 10000;
        padding: 10px 18px; background: ${bg}; color: ${fg}; border: 1px solid ${br};
        font-family: var(--ff-cn, sans-serif); font-size: 14px; letter-spacing: .05em;
        box-shadow: 0 4px 14px rgba(0,0,0,.6); pointer-events: none;
      `;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3500);
    }

    panel.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement) || !t.dataset.act) return;
      switch (t.dataset.act) {
        case 'alarm': {
          const tag = ['TT-150B-Z3', 'PT-150T', 'FLT-06.PRESSURE', 'WIDTH-REAR.PV'][Math.floor(Math.random() * 4)];
          const a = makeAlarm(tag, 1 + Math.floor(Math.random() * 3), 'process', `${tag} 演示告警 (手动触发)`, tag.split('.')[0]);
          alarmsActive.push(a);
          wsBroadcast({ type: 'alarm_new', data: a });
          pulseToast('新告警已触发: ' + tag, 'warn');
          break;
        }
        case 'pinn-flip':
          pinnSource = pinnSource === 'pinn' ? 'mock_fallback' : 'pinn';
          wsBroadcast({ type: 'pinn_status_change', data: { state: pinnSource, reason: '手动触发', recent_errors: [] } });
          pulseToast(pinnSource === 'pinn' ? 'PINN 已恢复' : 'PINN → mock_fallback', pinnSource === 'pinn' ? 'ok' : 'warn');
          break;
        case 'estop':
          estopActive = true;
          wsBroadcast({ type: 'estop', data: { reason: '演示手动触发' } });
          pulseToast('E-STOP 已触发', 'crit');
          break;
        case 'reset':
          alarmsActive.length = 0; recentCycles.length = 0;
          workorderQty = 75.0; estopActive = false; pinnSource = 'pinn';
          location.reload();
          break;

        // ─── Scenario presets ─────────────────────────────────────────
        case 'scn-normal': {
          alarmsActive.length = 0;
          if (pinnSource !== 'pinn') {
            pinnSource = 'pinn';
            wsBroadcast({ type: 'pinn_status_change', data: { state: 'pinn', reason: '场景: 正常生产' } });
          }
          if (estopActive) { estopActive = false; }
          // Restore upstream SP to baselines (PVs auto-track)
          SETPOINTS['EXT-90.SPEED.SP']=7.6; SETPOINTS['EXT-T.SPEED.SP']=5.1;
          SETPOINTS['EXT-M.SPEED.SP']=5.1; SETPOINTS['EXT-B.SPEED.SP']=4.2;
          SETPOINTS['TAKEUP.SPEED.SP']=5.0;
          ['TT-DIE-T.SP','TT-DIE-TM.SP','TT-DIE-M.SP','TT-DIE-BM.SP','TT-DIE-B.SP'].forEach(t => SETPOINTS[t]=75.0);
          SETPOINTS['SCL-FRONT.SP']=0.750; SETPOINTS['SCL-REAR.SP']=0.750;
          SETPOINTS['WIDTH-REAR.SP']=165.0;
          for (let i = 1; i <= 9; i += 1) SETPOINTS[`FLT-${i}.PRESSURE`] = [0.30, 0.10, 1.00, 0.30, 1.00, 2.00, 1.20, 0.80, 0.90][i - 1];
          pulseToast('场景: 正常生产 已恢复', 'ok');
          break;
        }
        case 'scn-overload': {
          // Drive UP via SPs — pressures derive from speed/temp coupling
          SETPOINTS['EXT-90.SPEED.SP'] = 9.2;     // +21%
          SETPOINTS['EXT-T.SPEED.SP']  = 6.3;
          SETPOINTS['EXT-M.SPEED.SP']  = 6.3;
          SETPOINTS['EXT-B.SPEED.SP']  = 5.2;
          SETPOINTS['TAKEUP.SPEED.SP'] = 6.0;
          // floater pressures up
          for (let i = 1; i <= 9; i += 1) SETPOINTS[`FLT-${i}.PRESSURE`] = Math.min(2.7, ([0.30,0.10,1.00,0.30,1.00,2.00,1.20,0.80,0.90][i-1]) * 1.5);
          pulseToast('场景: 满负荷生产 — 4 挤出机速度 +20% → 压力/电流将随动上升', 'warn');
          break;
        }
        case 'scn-drift': {
          // Asymmetric die temps via SP — PVs track with thermal lag
          SETPOINTS['TT-DIE-T.SP']  = 79.0;
          SETPOINTS['TT-DIE-TM.SP'] = 76.5;
          SETPOINTS['TT-DIE-M.SP']  = 75.0;
          SETPOINTS['TT-DIE-BM.SP'] = 72.5;
          SETPOINTS['TT-DIE-B.SP']  = 70.0;
          pulseToast('场景: 工艺漂移 — 模头 5 温区 SP 失对称，PV 缓慢追随，闸 2 告警将自动触发', 'warn');
          break;
        }
        case 'scn-flood': {
          const seeds = [
            ['TT-150B-Z3', 2, '下挤出机Z3 温度低于设定 −1.5°C'],
            ['PT-150T', 1, '上挤出机熔体压力 28.5 MPa 超 Tier 1'],
            ['FLT-06.PRESSURE', 3, '浮动辊6 压力轻微偏高'],
            ['WIDTH-REAR.PV', 2, '后测宽偏差超 ±3mm'],
            ['SCL-REAR', 3, '后秤称重 −0.4% 持续 5 分钟'],
          ];
          for (const [tag, tier, msg] of seeds) {
            const a = makeAlarm(tag, tier, 'process', msg, tag.split('.')[0]);
            alarmsActive.push(a);
            wsBroadcast({ type: 'alarm_new', data: a });
          }
          pulseToast('场景: 告警雪崩 — 5 条新告警', 'crit');
          break;
        }
        case 'scn-pinn-fail': {
          if (pinnSource === 'pinn') {
            pinnSource = 'mock_fallback';
            wsBroadcast({ type: 'pinn_status_change', data: { state: 'mock_fallback', reason: '场景: PINN 服务故障', recent_errors: ['fetch failed', 'timeout 2000ms', 'circuit open'] } });
          }
          pulseToast('场景: PINN 故障 — 闭环 Gate 7 将阻止 auto_tune', 'crit');
          break;
        }
      }
    });
  });

  console.log('[PRINX demo] mock layer installed — fetch + WebSocket intercepted');
})();
