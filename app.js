'use strict';
/* ===== 数据模型 =====
 village: {id,name,road,roundTrip(分钟),parcels(日均件量),session('early'|'late'),busTime('HH:MM')}
 courier: {id:0..2,name,leave}
 plan:    {id,name,assign:{villageId:courierId},baseline:null|snapshot}
 全局: villages, couriers(方案内独立请假), windowMin(每班可用分钟)
 早晚班是两个硬隔离的分池：分配、统计、均衡都按池独立进行。
*/

const STORAGE_KEY = 'kuaidi-fenpian-v1';
const COURIER_COLORS = ['#2563eb', '#059669', '#d97706'];
const ROADS = ['柏油', '水泥', '砂石', '泥泞', '山路'];

const SAMPLE_VILLAGES = [
  ['东河村', '柏油', 35, 120, 'early', '07:20'],
  ['西坡村', '水泥', 45, 95, 'early', '07:40'],
  ['南岭村', '砂石', 60, 70, 'early', '07:50'],
  ['北沟村', '泥泞', 75, 55, 'early', '08:10'],
  ['柳树湾', '柏油', 30, 140, 'early', '07:30'],
  ['石桥镇', '水泥', 40, 110, 'early', '08:00'],
  ['马家坳', '山路', 90, 45, 'early', '08:30'],
  ['双溪村', '砂石', 55, 80, 'late', '13:10'],
  ['红土岭', '泥泞', 70, 50, 'late', '13:30'],
  ['青竹坝', '柏油', 25, 130, 'late', '12:50'],
  ['金鸡坡', '山路', 85, 40, 'late', '13:50'],
  ['太平店', '水泥', 50, 85, 'late', '12:40'],
];

function uid() { return Math.random().toString(36).slice(2, 9); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function timeToMin(t) { if (!t) return 0; const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function minToTime(m) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }

function sampleState() {
  return {
    villages: SAMPLE_VILLAGES.map(([name, road, roundTrip, parcels, session, busTime]) =>
      ({ id: uid(), name, road, roundTrip, parcels, session, busTime })),
    couriers: [
      { id: 0, name: '甲', leave: false },
      { id: 1, name: '乙', leave: false },
      { id: 2, name: '丙', leave: false },
    ],
    plans: [newPlan('方案一')],
    activePlan: 0,
    windowMin: 240,
    winStart: '08:00',
    winEnd: '12:00',
  };
}

function newPlan(name, assign) {
  return { id: uid(), name, assign: assign || {}, baseline: null, log: [] };
}

/* ===== 纯算法 ===== */

// 按班次取村
function villagesBySession(state, session) {
  return state.villages.filter(v => v.session === session);
}

// 派件耗时：每单按 2.5 分钟折算，单村封顶 30 分钟
function parcelMinutes(v) { return Math.min(30, Math.round(v.parcels * 2.5 / 10) * 10); }
// 负荷 = 往返时长 + 派件耗时（分钟）
function workOf(v) { return v.roundTrip + parcelMinutes(v); }

// 某快递员在某班的负荷
function courierLoad(villages, assign, cid) {
  let duration = 0, parcels = 0, count = 0, work = 0;
  for (const v of villages) {
    if (assign[v.id] === cid) { duration += v.roundTrip; parcels += v.parcels; count++; work += workOf(v); }
  }
  return { duration, parcels, count, work };
}

// 全部负荷表
function allLoads(villages, assign, cids) {
  return cids.map(cid => ({ cid, ...courierLoad(villages, assign, cid) }));
}

/*
  均衡核心：
  - activeIds: 可接活的快递员（请假者排除）
  - fixed: Set<villageId>，稳片模式下不动的村
  - mode: 'stabilize' 尽量少动（先固定旧片，只动游离/超时相关村，爬山代价含 churn）
          'full'      全自动，所有村都可重分，只追求均衡
*/
function balancePool(villages, assignIn, activeIds, fixed, mode) {
  const assign = { ...assignIn };
  if (activeIds.length === 0) return { assign, moved: [], overtime: false };

  // 1) full 模式：全部村摘下重分；stabilize 模式：保留原主，只摘“无主/分给请假者”的村
  const movable = villages.slice();
  const toFill = [];
  if (mode === 'full') {
    for (const v of villages) delete assign[v.id];
    toFill.push(...villages);
  } else {
    for (const v of villages) {
      if (!activeIds.includes(assign[v.id])) { delete assign[v.id]; toFill.push(v); }
    }
  }

  // 2) 贪心初始化：可动村按时长降序，分给当前总时长最少的人
  const loads = {};
  for (const cid of activeIds) loads[cid] = courierLoad(villages, assign, cid);
  const getLoad = cid => loads[cid] || { duration: 0, parcels: 0, count: 0 };

  const ordered = [...toFill].sort((a, b) => workOf(b) - workOf(a));
  const originOf = {};
  for (const v of movable) originOf[v.id] = assignIn[v.id];
  for (const v of ordered) {
    let best = activeIds[0];
    for (const cid of activeIds) {
      if (getLoad(cid).work < getLoad(best).work) best = cid;
    }
    assign[v.id] = best;
    loads[best] = courierLoad(villages, assign, best);
  }

  // 3) 爬山：允许单人摘挂 + 两人交换，目标缩小时长极差
  // 稳片模式每个村换主有 20 分钟“搬迁代价”：只有改善足够大才动熟片
  const churnPenalty = mode === 'stabilize' ? 20 : 0;
  function score() {
    const ds = activeIds.map(cid => getLoad(cid).work);
    let churn = mode === 'stabilize'
      ? villages.reduce((n, v) => n + (assign[v.id] !== originOf[v.id] ? 1 : 0), 0)
      : 0;
    const parcels = activeIds.map(cid => getLoad(cid).parcels);
    return (Math.max(...ds) - Math.min(...ds))
      + 0.25 * (Math.max(...parcels) - Math.min(...parcels))
      + churnPenalty * churn;
  }
  let bestScore = score();
  for (let iter = 0; iter < 400; iter++) {
    let improved = false;
    // 摘挂
    for (const v of movable) {
      const from = assign[v.id];
      for (const to of activeIds) {
        if (to === from) continue;
        assign[v.id] = to;
        loads[from] = courierLoad(villages, assign, from);
        loads[to] = courierLoad(villages, assign, to);
        const s = score();
        if (s + 1e-9 < bestScore) { bestScore = s; improved = true; break; }
        assign[v.id] = from;
        loads[to] = courierLoad(villages, assign, to);
        loads[from] = courierLoad(villages, assign, from);
      }
      if (improved) break;
    }
    if (improved) continue;
    // 交换（仅 full 模式，stabilize 模式交换也计入 churn，一般不划算，统一允许）
    for (const va of movable) {
      for (const vb of movable) {
        if (va.id >= vb.id) continue;
        const a = assign[va.id], b = assign[vb.id];
        if (a === b) continue;
        assign[va.id] = b; assign[vb.id] = a;
        loads[a] = courierLoad(villages, assign, a);
        loads[b] = courierLoad(villages, assign, b);
        const s = score();
        if (s + 1e-9 < bestScore) { bestScore = s; improved = true; break; }
        assign[va.id] = a; assign[vb.id] = b;
        loads[b] = courierLoad(villages, assign, b);
        loads[a] = courierLoad(villages, assign, a);
      }
      if (improved) break;
    }
    if (!improved) break;
  }

  const moved = [];
  for (const v of villages) {
    if (assign[v.id] !== assignIn[v.id]) {
      moved.push({ villageId: v.id, from: assignIn[v.id], to: assign[v.id] });
    }
  }
  const maxDur = Math.max(...activeIds.map(cid => getLoad(cid).duration));
  return { assign, moved, overtime: maxDur > stateWindowMin(villages) };
}

// 算法需要时间窗口，通过模块变量传入（浏览器与 Node 都能测）
let __windowMin = 240;
function stateWindowMin() { return __windowMin; }

/* ===== 方案级操作 ===== */

function activeCouriers(state, plan) {
  return state.couriers.filter(c => !c.leave).map(c => c.id);
}

/*
 重新分片（两个池子各跑一次）
 mode: 'stabilize' | 'full'
 reason: 'manual'|'auto'|'bus'|'window'|'leave'
 返回新的 assign 与变动明细（按班次分组）
*/
function rebalance(state, plan, mode, reason) {
  const active = activeCouriers(state, plan);
  const oldAssign = clone(plan.assign);
  const assign = clone(plan.assign);
  const changes = [];

  for (const session of ['early', 'late']) {
    const vs = villagesBySession(state, session);
    const fixed = new Set();
    if (mode === 'stabilize') {
      for (const v of vs) {
        const owner = assign[v.id];
        if (owner !== undefined && active.includes(owner)) fixed.add(v.id);
      }
    }
    const res = balancePool(vs, assign, active, fixed, mode);
    for (const [vid, cid] of Object.entries(res.assign)) {
      if (cid !== undefined) assign[vid] = cid; else delete assign[vid];
    }
    for (const m of res.moved) changes.push({ ...m, session });
  }
  // 清理已删除村子的残留键
  const vids = new Set(state.villages.map(v => v.id));
  for (const k of Object.keys(assign)) if (!vids.has(k)) delete assign[k];

  return { assign: oldAssign, nextAssign: assign, changes, oldAssignSnap: oldAssign, active };
}

/* 基线快照：记录每人物量，用于"谁变重"对比 */
function takeBaseline(state, plan) {
  const snap = { assign: clone(plan.assign), loads: {}, time: labelTime() };
  for (const c of state.couriers) {
    const e = courierLoad(villagesBySession(state, 'early'), plan.assign, c.id);
    const l = courierLoad(villagesBySession(state, 'late'), plan.assign, c.id);
    snap.loads[c.id] = { early: e, late: l, duration: e.duration + l.duration, parcels: e.parcels + l.parcels };
  }
  plan.baseline = snap;
  return snap;
}

function currentLoads(state, plan) {
  const out = {};
  for (const c of state.couriers) {
    const e = courierLoad(villagesBySession(state, 'early'), plan.assign, c.id);
    const l = courierLoad(villagesBySession(state, 'late'), plan.assign, c.id);
    out[c.id] = { early: e, late: l, duration: e.duration + l.duration, parcels: e.parcels + l.parcels };
  }
  return out;
}

function diffVsBaseline(state, plan) {
  if (!plan.baseline) return null;
  const now = currentLoads(state, plan);
  const out = {};
  for (const c of state.couriers) {
    const b = plan.baseline.loads[c.id], n = now[c.id];
    out[c.id] = { dDur: n.duration - b.duration, dParcels: n.parcels - b.parcels };
  }
  return out;
}

function fairnessOf(state, assign) {
  const cids = state.couriers.map(c => c.id);
  const rows = [];
  for (const session of ['early', 'late']) {
    const vs = villagesBySession(state, session);
    const ls = allLoads(vs, assign, cids);
    const durs = ls.map(x => x.duration);
    const pas = ls.map(x => x.parcels);
    rows.push({ session, durRange: Math.max(...durs) - Math.min(...durs),
      parRange: Math.max(...pas) - Math.min(...pas),
      maxDur: Math.max(...durs), maxPar: Math.max(...pas) });
  }
  return rows;
}

function labelTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const REASON_TEXT = {
  manual: '手动分村', auto: '全自动均衡', bus: '班车时间变动后重划',
  window: '时间窗口变化，稳片重划', leave: '请假拆片', revert: '请假归位还原'
};

/* 统计变动：以基线或上一次记录为参照，输出每个人时长增减 */
function summarizeChanges(state, oldAssign, newAssign, changes) {
  const cids = state.couriers.map(c => c.id);
  const delta = {};
  for (const cid of cids) delta[cid] = { dur: 0, par: 0, in: [], out: [] };
  const vmap = Object.fromEntries(state.villages.map(v => [v.id, v]));
  for (const ch of changes) {
    const v = vmap[ch.villageId];
    if (!v) continue;
    if (ch.to !== undefined) { delta[ch.to].dur += v.roundTrip; delta[ch.to].par += v.parcels; delta[ch.to].in.push(v); }
    if (ch.from !== undefined) { delta[ch.from].dur -= v.roundTrip; delta[ch.from].par -= v.parcels; delta[ch.from].out.push(v); }
  }
  return delta;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SAMPLE_VILLAGES, sampleState, newPlan, uid, timeToMin, minToTime,
    villagesBySession, courierLoad, allLoads, balancePool, rebalance,
    takeBaseline, currentLoads, diffVsBaseline, fairnessOf, summarizeChanges,
    setWindowMin(w) { __windowMin = w; }
  };
}

/* ================= UI ================= */
if (typeof document !== 'undefined') {
let state = loadState();
let busNotice = null;     // {items:[{name,oldTime,newTime,sessionChanged}]}
let undoStack = [];

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const cname = cid => state.couriers[cid] ? state.couriers[cid].name : '未分';

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.villages && s.plans && s.plans.length) { __windowMin = s.windowMin || 240; return s; }
    }
  } catch (e) {}
  const s = sampleState();
  __windowMin = s.windowMin;
  // 示例方案先给一个“旧划法”：全部压给甲、乙，丙只拿一点，方便演示变重对比
  return s;
}
function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function plan() { return state.plans[state.activePlan]; }
function snapshotUndo() {
  undoStack.push(JSON.stringify({ assign: clone(plan().assign) }));
  if (undoStack.length > 40) undoStack.shift();
}

/* ---------- 变动应用与记录 ---------- */
function applyRebalance(mode, reason) {
  snapshotUndo();
  const p = plan();
  const r = rebalance(state, p, mode, reason);
  p.assign = r.nextAssign;
  p.log.unshift({ reason, changes: clone(r.changes),
    delta: summarizeChanges(state, r.oldAssignSnap, r.nextAssign, r.changes), time: labelTime() });
  if (p.log.length > 30) p.log.pop();
  render(); save();
}

function manualAssign(vid, cid) {
  const p = plan();
  const v = state.villages.find(x => x.id === vid);
  const c = state.couriers[cid];
  if (!v || c.leave) return;
  snapshotUndo();
  const from = p.assign[vid];
  if (from === cid) delete p.assign[vid];
  else p.assign[vid] = cid;
  const to = from === cid ? undefined : cid;
  const delta = summarizeChanges(state, from === undefined ? {} : { [vid]: from }, p.assign,
    [{ villageId: vid, from, to, session: v.session }]);
  p.log.unshift({ reason: 'manual', changes: [{ villageId: vid, from, to, session: v.session }], delta, time: labelTime() });
  if (p.log.length > 30) p.log.pop();
  render(); save();
}

/* ---------- 渲染 ---------- */
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

function render() {
  renderPlanTabs();
  renderPools();
  renderRegistry();
  renderCouriers();
  renderLog();
  renderWindowInputs();
  renderBanner();
}

function renderPlanTabs() {
  const el = $('#planTabs');
  el.innerHTML = state.plans.map((p, i) =>
    `<div class="plan-tab ${i === state.activePlan ? 'active' : ''}" data-i="${i}">
      ${esc(p.name)}${p.baseline ? '<span class="base" title="已存基线">●基</span>' : ''}
      ${state.plans.length > 1 ? '<span class="delplan" data-del="' + i + '" title="删除方案"> ✕</span>' : ''}
    </div>`).join('');
}

function poolHtml(container, session, label) {
  const p = plan();
  const vs = villagesBySession(state, session);
  const unassigned = vs.filter(v => p.assign[v.id] === undefined).length;
  const cards = vs.map(v => {
    const cid = p.assign[v.id];
    const picked = cid !== undefined;
    const btns = state.couriers.map(c =>
      `<button data-c="${c.id}" data-v="${v.id}"
        class="${picked && cid === c.id ? 'picked' : ''} ${c.leave ? 'off' : ''}"
        style="${picked && cid === c.id ? '' : 'color:' + COURIER_COLORS[c.id]}"
        ${c.leave && !(picked && cid === c.id) ? 'title="请假中"' : ''}>${esc(c.name)}${picked && cid === c.id ? ' ✓' : ''}</button>`
    ).join('');
    return `<div class="vcard ${picked ? '' : 'unassigned'}" data-v="${v.id}">
      <div class="row1">
        <span class="name">${esc(v.name)}</span>
        <span class="road road-${v.road}">${v.road}</span>
      </div>
      <div class="meta">
        <span>🚐 ${esc(v.busTime)}</span>
        <span>往返 ${v.roundTrip} 分</span>
        <span>${v.parcels} 件/日</span>
      </div>
      <div class="assignbtns">${btns}</div>
    </div>`;
  }).join('');
  container.className = 'pool ' + session;
  container.innerHTML = `<div class="pool-head">
      <span class="dot"></span><h3>${label}</h3>
      <span class="stat">共 ${vs.length} 村</span>
      ${unassigned ? `<span class="unassigned">⚠ ${unassigned} 个村未分</span>` : '<span class="stat">已全部分完</span>'}
    </div><div class="vcards">${cards}</div>`;
}
function renderPools() {
  poolHtml($('#poolEarly'), 'early', '早班车村（上午派）');
  poolHtml($('#poolLate'), 'late', '晚班车村（下午派）');
}

function renderRegistry() {
  const tb = $('#registryTable tbody');
  tb.innerHTML = state.villages.map(v => `
    <tr data-v="${v.id}">
      <td><input class="name-input" data-f="name" value="${esc(v.name)}"></td>
      <td><select data-f="road">
        ${ROADS.map(r => `<option ${r === v.road ? 'selected' : ''}>${r}</option>`).join('')}
      </select></td>
      <td><input type="number" min="1" data-f="roundTrip" value="${v.roundTrip}"></td>
      <td><input type="number" min="0" data-f="parcels" value="${v.parcels}"></td>
      <td><select data-f="session">
        <option value="early" ${v.session === 'early' ? 'selected' : ''}>早班车</option>
        <option value="late" ${v.session === 'late' ? 'selected' : ''}>晚班车</option>
      </select></td>
      <td><input type="time" data-f="busTime" step="60" value="${esc(v.busTime)}"></td>
      <td><button class="del" title="删除">删除</button></td>
    </tr>`).join('');
}

function fmtLoad(load) { return `${load.duration} 分 · ${load.parcels} 件`; }
function renderCouriers() {
  const p = plan();
  const wrap = $('#courierCards');
  const diff = diffVsBaseline(state, p);
  wrap.innerHTML = state.couriers.map(c => {
    const e = courierLoad(villagesBySession(state, 'early'), p.assign, c.id);
    const l = courierLoad(villagesBySession(state, 'late'), p.assign, c.id);
    const ev = villagesBySession(state, 'early').filter(v => p.assign[v.id] === c.id);
    const lv = villagesBySession(state, 'late').filter(v => p.assign[v.id] === c.id);
    const d = diff ? diff[c.id] : null;
    const heavier = d && d.dDur > 0;
    const lighter = d && d.dDur < 0;
    const diffTag = d ? `<span class="vs"> 较基线 <span class="${heavier ? 'up' : lighter ? 'down' : ''}">
        ${d.dDur > 0 ? '+' : ''}${d.dDur}分 / ${d.dParcels > 0 ? '+' : ''}${d.dParcels}件</span></span>` : '';
    return `<div class="ccard ${c.leave ? 'away' : ''}" data-c="${c.id}" style="border-top-color:${COURIER_COLORS[c.id]}">
      <div class="top">
        <div class="nm"><input data-f="cname" data-c="${c.id}" value="${esc(c.name)}">${diffTag}</div>
        <button class="leave-btn ${c.leave ? 'on' : ''}" data-leave="${c.id}">${c.leave ? '请假中（点归位）' : '请假'}</button>
      </div>
      ${shiftBlock('early', '早班', e, ev, c)}
      ${shiftBlock('late', '晚班', l, lv, c)}
    </div>`;
  }).join('');
}

function shiftBlock(session, title, load, list, courier) {
  const over = load.duration > state.windowMin;
  const pct = Math.min(100, Math.round(load.duration / state.windowMin * 100));
  const tags = list.map(v => `<span>${esc(v.name)}(${v.roundTrip}分)${courier.leave ? '<b data-back="' + v.id + '" title="还原">↩</b>' : ''}</span>`).join('')
    || '<span style="color:#9aa4b2">—</span>';
  return `<div class="shift ${session}">
    <h4><span>${title}</span>${over ? `<span class="overtag">超窗口 ${load.duration - state.windowMin} 分</span>` : ''}</h4>
    <div class="bar"><i class="${over ? 'over' : ''}" style="width:${pct}%"></i></div>
    <div class="totals">
      <b class="${over ? 'heavier' : ''}">${fmtLoad(load)}</b>
      <span style="color:#8b95a3">窗口 ${state.windowMin} 分</span>
    </div>
    <div class="vtags">${tags}</div>
  </div>`;
}

function renderLog() {
  const el = $('#changeLog');
  const p = plan();
  if (!p.log.length) { el.innerHTML = '<li class="d">还没有变动。分村、重划或请假后，谁的活变重会显示在这里。</li>'; return; }
  const vmap = Object.fromEntries(state.villages.map(v => [v.id, v]));
  el.innerHTML = p.log.slice(0, 12).map(log => {
    const moves = log.changes.map(ch => {
      const v = vmap[ch.villageId];
      const tag = ch.session === 'early' ? '早' : '晚';
      if (ch.from === undefined && ch.to !== undefined)
        return `<span class="mv">${esc(v ? v.name : '?')}[${tag}] → ${esc(cname(ch.to))}</span>`;
      if (ch.to === undefined)
        return `<span class="mv">${esc(v ? v.name : '?')}[${tag}] ${esc(cname(ch.from))} 名下取消</span>`;
      return `<span class="mv">${esc(v ? v.name : '?')}[${tag}] ${esc(cname(ch.from))}→${esc(cname(ch.to))}</span>`;
    }).join('；');
    const w = Object.entries(log.delta || {}).filter(([, d]) => d.dur !== 0)
      .map(([cid, d]) => `<span class="${d.dur > 0 ? 'heavier' : 'lighter'}">${esc(cname(+cid))} ${d.dur > 0 ? '+' : ''}${d.dur}分</span>`)
      .join('，');
    return `<li>
      <div class="why ${log.reason}">${REASON_TEXT[log.reason] || log.reason} · ${log.time}</div>
      ${moves ? `<div>${moves}</div>` : '<div class="d">无村调动</div>'}
      ${w ? `<div style="margin-top:3px">${w}</div>` : ''}
    </li>`;
  }).join('');
}

function renderWindowInputs() {
  $('#winStart').value = state.winStart;
  $('#winEnd').value = state.winEnd;
  $('#winMinutes').textContent = `每班可派 ${state.windowMin} 分钟`;
}

function renderBanner() {
  const el = $('#busBanner');
  const p = plan();
  const cids = state.couriers.map(c => c.id);
  const overs = [];
  for (const session of ['early', 'late']) {
    for (const c of state.couriers) {
      if (c.leave) continue;
      const ld = courierLoad(villagesBySession(state, session), p.assign, c.id);
      if (ld.duration > state.windowMin) overs.push(`${c.name}${session === 'early' ? '早' : '晚'}班超 ${ld.duration - state.windowMin} 分`);
    }
  }
  if (busNotice) {
    const changed = busNotice.items.filter(i => !i.sessionChanged);
    const moved = busNotice.items.filter(i => i.sessionChanged);
    el.classList.remove('hidden', 'bad');
    el.innerHTML =
      (changed.length ? `🕐 班车时间变了：${changed.map(i => `${i.name} ${i.oldTime}→${i.newTime}`).join('；')}
        。原先的片可能不再均衡，熟片区尽量不动、只补差额：
        <button id="bannerRepart" style="margin-left:8px;border:1px solid #c99a2e;background:#fff;border-radius:6px;padding:2px 10px;cursor:pointer">稳片重划</button>` : '') +
      (moved.length ? `<br>⚠ ${moved.map(i => `${i.name}(${i.oldTime}→${i.newTime})`).join('；')}
        跨了早晚班，已从原片区摘下待重新分（早晚班不能混分）。
        <button id="bannerAssign" style="margin-left:8px;border:1px solid #c99a2e;background:#fff;border-radius:6px;padding:2px 10px;cursor:pointer">把待分村分掉</button>
        <button id="bannerClose" style="margin-left:6px;border:none;background:none;color:#92600a;cursor:pointer">知道了 ✕</button>` : '');
    return;
  }
  if (state.couriers.every(c => c.leave)) {
    el.classList.remove('hidden'); el.classList.add('bad');
    el.textContent = '三名快递员都在请假，没有可派件的人；至少让一人归位后再分片。';
    return;
  }
  if (overs.length) {
    el.classList.remove('hidden'); el.classList.add('bad');
    el.innerHTML = `⏰ 有人装不下：${overs.join('、')}。可调大时间窗口，或点【稳片重划】。`;
  } else {
    el.classList.add('hidden'); el.classList.remove('bad');
    el.textContent = '';
  }
}

/* ---------- 方案并排比 ---------- */
function openCompare() {
  const rows = state.plans.map(pl => {
    const f = fairnessOf(state, pl.assign);
    const now = currentLoads(state, pl);
    const cells = state.couriers.map(c => {
      const n = now[c.id];
      const overE = n.early.duration > state.windowMin, overL = n.late.duration > state.windowMin;
      return `<td>${c.leave ? '<span style="color:#dc2626">请假中</span><br>' : ''}
        早 ${n.early.duration}分/${n.early.parcels}件${overE ? ' ⚠' : ''}<br>
        晚 ${n.late.duration}分/${n.late.parcels}件${overL ? ' ⚠' : ''}<br>
        <b>合计 ${n.duration}分/${n.parcels}件</b></td>`;
    }).join('');
    const totalRange = Math.max(...state.couriers.map(c => now[c.id].duration))
      - Math.min(...state.couriers.filter(c => !c.leave).map(c => now[c.id].duration));
    return `<tr class="${state.plans[state.activePlan] === pl ? 'hl' : ''}">
      <td>${esc(pl.name)}${pl.baseline ? ' ●基' : ''}</td>${cells}
      <td>早极差 ${f[0].durRange}分/${f[0].parRange}件<br>晚极差 ${f[1].durRange}分/${f[1].parRange}件
        <br><span class="${totalRange > 60 ? 'unfair' : 'fair'}">合计时长极差 ${totalRange} 分</span></td>
    </tr>`;
  }).join('');
  $('#compareTable').innerHTML = `<div class="cmp-wrap"><table class="cmp">
    <thead><tr><th>划法</th>${state.couriers.map(c => `<th>${esc(c.name)}</th>`).join('')}<th>公平性指标</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="hint" style="margin-top:8px">●基＝已存对比基线；极差越小越均衡；⚠＝超过每班 ${state.windowMin} 分钟窗口。系统只摆数据，不判公平。</p>
  </div>`;
  $('#compareOverlay').classList.remove('hidden');
}

/* ---------- 班车/登记编辑 ---------- */
function updateVillageField(vid, field, value) {
  const v = state.villages.find(x => x.id === vid);
  if (!v) return;
  const p = plan();
  const old = { session: v.session, busTime: v.busTime };

  if (field === 'roundTrip' || field === 'parcels') value = Math.max(field === 'parcels' ? 0 : 1, parseInt(value) || 0);
  if (field === 'name') value = value.trim() || v.name;

  const ownerChanged = ['roundTrip', 'parcels'].includes(field);
  if (ownerChanged) { /* 数字变化只影响统计，不需要快照，可撤销意义不大 */ }
  v[field] = value;

  if (field === 'session' && old.session !== value) {
    // 跨班次：早晚班硬隔离，必须摘出原片
    snapshotUndo();
    const from = p.assign[vid];
    delete p.assign[vid];
    busNotice = { items: [{ name: v.name, oldTime: v.busTime, newTime: v.busTime, sessionChanged: true }] };
    p.log.unshift({ reason: 'bus', changes: [{ villageId: vid, from, to: undefined, session: old.session }],
      delta: summarizeChanges(state, { [vid]: from }, p.assign, [{ villageId: vid, from, to: undefined }]),
      time: labelTime() });
  }
  if (field === 'busTime' && old.busTime !== value) {
    busNotice = { items: [{ name: v.name, oldTime: old.busTime, newTime: value, sessionChanged: false }] };
  }
  render(); save();
}

function addVillage() {
  const v = { id: uid(), name: `新村${state.villages.length + 1}`, road: '水泥',
    roundTrip: 45, parcels: 60, session: 'early', busTime: '08:00' };
  state.villages.push(v);
  busNotice = { items: [{ name: v.name, oldTime: '—', newTime: v.busTime, sessionChanged: false }] };
  render(); save();
}
function deleteVillage(vid) {
  if (!confirm('删除这个村子？其分片也会从所有方案中移除。')) return;
  state.villages = state.villages.filter(v => v.id !== vid);
  for (const pl of state.plans) delete pl.assign[vid];
  busNotice = null;
  render(); save();
}

/* ---------- 请假 ---------- */
function toggleLeave(cid) {
  const c = state.couriers[cid];
  if (!c.leave && state.couriers.filter(x => !x.leave).length <= 1) {
    alert('至少要留一个人在岗，不能三个人同时请假。');
    return;
  }
  c.leave = !c.leave;
  const p = plan();
  if (c.leave) {
    // 他的片拆给别人：稳片模式把他的村全部置为可动
    const held = state.villages.filter(v => p.assign[v.id] === cid);
    if (held.length) {
      p.leaveSnap = p.leaveSnap || {};
      p.leaveSnap[cid] = JSON.stringify({ assign: clone(p.assign) });
      const r = rebalance(state, p, 'stabilize', 'leave');
      p.assign = r.nextAssign;
      p.log.unshift({ reason: 'leave', changes: clone(r.changes),
        delta: summarizeChanges(state, r.oldAssignSnap, r.nextAssign, r.changes), time: labelTime() });
      if (p.log.length > 30) p.log.pop();
    }
  } else {
    // 归位：还原到该人请假前的分法
    const last = p.leaveSnap && p.leaveSnap[cid];
    if (p.leaveSnap) delete p.leaveSnap[cid];
    if (last) {
      const prev = JSON.parse(last);
      const oldA = clone(p.assign);
      p.assign = prev.assign;
      const changes = [];
      for (const v of state.villages) {
        if (oldA[v.id] !== p.assign[v.id]) changes.push({ villageId: v.id, from: oldA[v.id], to: p.assign[v.id], session: v.session });
      }
      p.log.unshift({ reason: 'revert', changes, delta: summarizeChanges(state, oldA, p.assign, changes), time: labelTime() });
    }
  }
  render(); save();
}

/* ---------- 方案管理 ---------- */
function switchPlan(i) { state.activePlan = i; busNotice = null; render(); save(); }
function addPlan(copy) {
  const src = state.plans[state.activePlan];
  const np = copy
    ? newPlan(src.name + '副本', clone(src.assign))
    : newPlan('方案' + '一二三四五六七八'[state.plans.length] || ('方案' + (state.plans.length + 1)));
  state.plans.push(np);
  state.activePlan = state.plans.length - 1;
  render(); save();
}
function deletePlan(i) {
  if (state.plans.length <= 1) return;
  if (!confirm(`删除「${state.plans[i].name}」？`)) return;
  state.plans.splice(i, 1);
  state.activePlan = Math.min(state.activePlan, state.plans.length - 1);
  render(); save();
}

/* ---------- 时间窗口 ---------- */
function setWindowMin(min, start, end) {
  const oldMin = state.windowMin;
  state.windowMin = min;
  if (start !== undefined) state.winStart = start;
  if (end !== undefined) state.winEnd = end;
  __windowMin = min;
  save(); render(); // 窗口变化后横幅会实时显示谁超窗口
}

/* ---------- 事件 ---------- */
function bind() {
  // 分池卡片：甲/乙/丙 按钮（事件委托）
  document.addEventListener('click', e => {
    const assignBtn = e.target.closest('.assignbtns button');
    if (assignBtn && e.target.closest('.pool')) {
      if (assignBtn.classList.contains('off')) return;
      manualAssign(assignBtn.dataset.v, +assignBtn.dataset.c);
      return;
    }
    if (assignBtn) return;
    const tab = e.target.closest('.plan-tab');
    if (tab) {
      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); deletePlan(+del.dataset.del); return; }
      switchPlan(+tab.dataset.i);
      return;
    }
    if (e.target.closest('.planbar')) return;
    const lv = e.target.closest('[data-leave]');
    if (lv) { toggleLeave(+lv.dataset.leave); return; }
    if (e.target.closest('.ccard')) return;
    const back = e.target.closest('[data-back]');
    if (back) {
      const vid = back.dataset.back, p = plan();
      const tag = back.closest('.ccard');
      if (tag) manualAssign(vid, +tag.dataset.c);
      return;
    }
    const delV = e.target.closest('#registryTable .del');
    if (delV) { deleteVillage(delV.closest('tr').dataset.v); return; }
  });

  // 登记表字段
  $('#registryTable').addEventListener('change', e => {
    const inp = e.target.closest('[data-f]');
    if (!inp) return;
    const tr = inp.closest('tr');
    updateVillageField(tr.dataset.v, inp.dataset.f, inp.value);
  });

  // 快递员改名
  $('#courierCards').addEventListener('change', e => {
    const inp = e.target.closest('[data-f="cname"]');
    if (!inp) return;
    const name = inp.value.trim();
    if (name) { state.couriers[+inp.dataset.c].name = name; save(); render(); }
  });

  // 班车横幅上的重划提示点击区域不拦截；按钮
  $('#btnRepart').onclick = () => { applyRebalance('stabilize', 'window'); busNotice = null; render(); };
  $('#btnBalance').onclick = () => { applyRebalance('full', 'auto'); busNotice = null; render(); };
  $('#btnBaseline').onclick = () => { takeBaseline(state, plan()); render(); save(); };
  $('#btnUndo').onclick = () => {
    const s = undoStack.pop();
    if (!s) return;
    const prev = JSON.parse(s);
    const oldA = clone(plan().assign);
    plan().assign = prev.assign;
    plan().log.unshift({ reason: 'manual',
      changes: state.villages.filter(v => oldA[v.id] !== plan().assign[v.id])
        .map(v => ({ villageId: v.id, from: oldA[v.id], to: plan().assign[v.id], session: v.session })),
      delta: summarizeChanges(state, oldA, plan().assign,
        state.villages.filter(v => oldA[v.id] !== plan().assign[v.id])
          .map(v => ({ villageId: v.id, from: oldA[v.id], to: plan().assign[v.id], session: v.session }))),
      time: labelTime() });
    render(); save();
  };
  $('#btnCompare').onclick = openCompare;
  $('#btnCloseCompare').onclick = () => $('#compareOverlay').classList.add('hidden');
  $('#btnAddVillage').onclick = addVillage;
  $('#busBanner').addEventListener('click', e => {
    if (e.target.id === 'bannerRepart') { applyRebalance('stabilize', 'bus'); busNotice = null; render(); }
    if (e.target.id === 'bannerAssign') { applyRebalance('stabilize', 'bus'); busNotice = null; render(); }
    if (e.target.id === 'bannerClose') { busNotice = null; render(); }
  });
  $('#btnReset').onclick = () => {
    if (!confirm('恢复为示例数据？当前所有划法将被清空。')) return;
    localStorage.removeItem(STORAGE_KEY);
    state = sampleState();
    const fresh = rebalance(state, state.plans[0], 'full', 'auto');
    state.plans[0].assign = fresh.nextAssign;
    undoStack = []; busNotice = null;
    save(); render();
  };

  // 时间窗口
  const syncFromInputs = () => {
    let a = timeToMin($('#winStart').value), b = timeToMin($('#winEnd').value);
    if (b <= a) b = a + 240;
    setWindowMin(b - a, $('#winStart').value, minToTime(b));
  };
  $('#winStart').onchange = syncFromInputs;
  $('#winEnd').onchange = syncFromInputs;
  $$('.presets button').forEach(btn => btn.onclick = () => {
    const w = +btn.dataset.w;
    const s = timeToMin(state.winStart);
    setWindowMin(w, minToTime(s), minToTime(s + w));
  });

  // 标题栏双击新增/复制方案：改用 tab 栏旁右键菜单太隐蔽，这里提供键盘式按钮——
  // 在操作栏开头加两个小按钮
  const addBtns = document.createElement('span');
  addBtns.innerHTML = `<button id="btnNewPlan" title="空白新方案">＋新划法</button>
    <button id="btnCopyPlan" title="复制当前划法再微调">⎘复制</button>`;
  addBtns.style.cssText = 'display:flex;gap:6px';
  $('.plan-actions').prepend(addBtns);
  $('#btnNewPlan').onclick = () => addPlan(false);
  $('#btnCopyPlan').onclick = () => addPlan(true);
}

let __inited = false;
function init() {
  if (__inited) return;
  __inited = true;
  bind();
  // 首次进入给示例方案做一次均衡，便于直接看到效果
  const p = plan();
  if (Object.keys(p.assign).length === 0) {
    const r = rebalance(state, p, 'full', 'auto');
    p.assign = r.nextAssign;
    save();
  }
  render();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
}
