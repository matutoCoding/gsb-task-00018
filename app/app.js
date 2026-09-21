/* ===== 界面层 ===== */
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
const roadLabel = v => (ROADS.find(r=>r.v===v)||{}).label || v;
const activePlan = () => state.plans.find(p=>p.id===state.activePlanId) || state.plans[0];

/* ---------- 弹窗 ---------- */
function showModal(html){
  $('#modal').innerHTML = html;
  $('#modalMask').classList.remove('hidden');
}
function closeModal(){ $('#modalMask').classList.add('hidden'); }
$('#modalMask').addEventListener('click', e => { if(e.target === $('#modalMask')) closeModal(); });

/* ---------- 页签 ---------- */
$('#tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if(!btn) return;
  $$('.tab').forEach(t=>t.classList.toggle('active', t===btn));
  const tab = btn.dataset.tab;
  $$('.panel').forEach(p=>p.classList.remove('active'));
  $('#tab-'+tab).classList.add('active');
  render();
});

/* ================= ① 数据页 ================= */
function renderData(){
  $('#windowMinutes').value = state.windowMinutes;
  const tb = $('#villageTable tbody');
  tb.innerHTML = state.villages.map(v => `
    <tr data-id="${v.id}">
      <td><input class="f-name" value="${esc(v.name)}"></td>
      <td>
        <select class="f-road">
          ${ROADS.map(r=>`<option value="${r.v}" ${r.v===v.road?'selected':''}>${r.label}</option>`).join('')}
        </select>
      </td>
      <td><input class="f-trip num" type="number" min="5" max="300" value="${v.trip}"></td>
      <td><input class="f-parcels num" type="number" min="0" max="500" value="${v.parcels}"></td>
      <td>
        <select class="f-bus">
          <option value="early" ${v.bus==='early'?'selected':''}>早班车（上午）</option>
          <option value="late"  ${v.bus==='late' ?'selected':''}>晚班车（下午）</option>
        </select>
      </td>
      <td><input class="f-bustime" type="time" value="${esc(v.busTime)}"></td>
      <td><button class="icon-btn f-del" title="删除村">🗑</button></td>
    </tr>`).join('');

  const total = state.villages.reduce((a,v)=>a+v.parcels,0);
  const e = state.villages.filter(v=>v.bus==='early').length;
  const l = state.villages.length - e;
  $('#sumParcels').textContent = total + ' 件';
  $('#sumBus').innerHTML = `<span class="bus-early">早班 ${e} 村</span> · <span class="bus-late">晚班 ${l} 村</span>`;

  $('#courierList').innerHTML = state.couriers.map(c => `
    <div class="courier-card" style="--c:${c.color}">
      <span class="dot"></span>
      <input type="text" class="f-cname" data-id="${c.id}" value="${esc(c.name)}">
      <input type="color" class="f-ccolor" data-id="${c.id}" value="${c.color}" title="颜色">
      <button class="icon-btn f-cdel" data-id="${c.id}" title="删除快递员">🗑</button>
    </div>`).join('');
}

$('#villageTable').addEventListener('input', e => {
  const tr = e.target.closest('tr'); if(!tr) return;
  const v = state.villages.find(x=>x.id===tr.dataset.id); if(!v) return;
  const t = e.target;
  if(t.classList.contains('f-name')) v.name = t.value.trim() || v.name;
  if(t.classList.contains('f-road')) v.road = t.value;
  if(t.classList.contains('f-trip')) v.trip = clampInt(t.value, 5, 300, v.trip);
  if(t.classList.contains('f-parcels')) v.parcels = clampInt(t.value, 0, 500, v.parcels);
  if(t.classList.contains('f-bus')) v.bus = t.value;
  if(t.classList.contains('f-bustime')) v.busTime = t.value;
  save(); refreshStatsOnly();
});
$('#villageTable').addEventListener('click', e => {
  if(!e.target.classList.contains('f-del')) return;
  const tr = e.target.closest('tr');
  const v = state.villages.find(x=>x.id===tr.dataset.id);
  if(!confirm(`删除「${v.name}」？所有方案中的该村分派也会移除。`)) return;
  state.villages = state.villages.filter(x=>x.id!==v.id);
  state.plans.forEach(p=>delete p.assign[v.id]);
  save(); render();
});

$('#courierList').addEventListener('input', e => {
  const id = e.target.dataset.id;
  const c = state.couriers.find(x=>x.id===id); if(!c) return;
  if(e.target.classList.contains('f-cname')) c.name = e.target.value.trim() || c.name;
  if(e.target.classList.contains('f-ccolor')) c.color = e.target.value;
  save();
  if(!e.target.classList.contains('f-ccolor')) return;
  refreshStatsOnly();
});
$('#courierList').addEventListener('change', refreshStatsOnly);
$('#courierList').addEventListener('click', e => {
  if(!e.target.classList.contains('f-cdel')) return;
  const id = e.target.dataset.id;
  if(state.couriers.length <= 1){ alert('至少保留一名快递员'); return; }
  const c = state.couriers.find(x=>x.id===id);
  if(!confirm(`删除快递员「${c.name}」？他在各方案中的村子会变成未分配，可重新自动分片。`)) return;
  state.couriers = state.couriers.filter(x=>x.id!==id);
  state.plans.forEach(p=>{
    for(const vid in p.assign) if(p.assign[vid].courier===id) delete p.assign[vid];
    if(p.lateCourier===id) p.lateCourier=null;
    if(p.leaveCourier===id) p.leaveCourier=null;
  });
  save(); render();
});

$('#addVillageBtn').addEventListener('click', () => {
  state.villages.push({ id:uid('v'), name:'新村'+(state.villages.length+1), road:'mid', trip:45, parcels:30, bus:'early', busTime:'08:30' });
  save(); render();
});

$('#resetDataBtn').addEventListener('click', () => {
  if(!confirm('恢复为示例数据？当前所有村子、人员和方案都会清空。')) return;
  localStorage.removeItem(STORAGE_KEY);
  state = load(); save(); render();
});

/* 改时间窗口：保留熟片，仅对超窗口的方案给提示（不强制重划，可点按钮重划） */
$('#applyWindow').addEventListener('click', () => {
  const val = clampInt($('#windowMinutes').value, 60, 720, state.windowMinutes);
  state.windowMinutes = val;
  state.plans.forEach(p=>p.windowMinutes = val);
  save();
  const p = activePlan();
  const notice = $('#windowNotice');
  notice.className = 'notice info';
  notice.innerHTML = `时间窗口已改为 <b>${val} 分钟</b>。窗口变了可能原来的片跑不完。
    <div class="btns">
      <button class="btn small primary" id="replanStable">🔒 保留熟片微调重划</button>
      <button class="btn small" id="replanFull">⚖️ 全部重新均衡</button>
    </div>`;
  notice.classList.remove('hidden');
  $('#replanStable').onclick = () => { autoAllocate(state, p, {early:true,late:true}, true); save(); notice.classList.add('hidden'); render(); };
  $('#replanFull').onclick = () => { autoAllocate(state, p, {early:true,late:true}, false); save(); notice.classList.add('hidden'); render(); };
  render();
});

function clampInt(v, min, max, fallback){
  const n = parseInt(v, 10);
  if(isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/* ================= ② 分片页 ================= */
function renderPlan(){
  const sel = $('#planSelect');
  sel.innerHTML = state.plans.map(p=>`<option value="${p.id}" ${p.id===state.activePlanId?'selected':''}>${esc(p.name)}</option>`).join('');
  $('#delPlanBtn').disabled = state.plans.length <= 1;

  const plan = activePlan(); if(!plan) return;

  /* 模式条 */
  const lateC = state.couriers.find(c=>c.id===plan.lateCourier);
  const leaveC = state.couriers.find(c=>c.id===plan.leaveCourier);
  $('#modeRow').innerHTML = `
    <span class="mode-chip">窗口 ${plan.windowMinutes} 分钟</span>
    <button class="mode-chip ${plan.lateOnly?'late':''}" id="lateModeBtn">
      晚班村：${plan.lateOnly ? `由「${esc(lateC?lateC.name:'?')}」单独跑` : '与早班一起均衡分'} ⇄
    </button>
    <button class="mode-chip ${plan.leaveCourier?'leave':''}" id="leaveModeBtn">
      ${plan.leaveCourier ? `🙋 请假中：${esc(leaveC?leaveC.name:'?')}` : '🙋 无人请假'}
    </button>`;

  const unassigned = unassignedVillages(plan);
  const notice = $('#planNotice');
  if(unassigned.length){
    const list = unassigned.map(v=>`「${esc(v.name)}」`).join('、');
    notice.className = 'notice danger';
    notice.innerHTML = `有 <b>${unassigned.length}</b> 个村没分下去：${list}。
      <div class="btns"><button class="btn small primary" id="fixUnassigned">一键重分（保留熟片）</button></div>`;
    $('#fixUnassigned').onclick = () => {
      // 清掉无效指派再重分
      unassigned.forEach(v=>delete plan.assign[v.id]);
      autoAllocate(state, plan, {early:true,late:true}, true);
      save(); render();
    };
    notice.classList.remove('hidden');
  }else{
    notice.classList.add('hidden');
  }

  const f = planFairness(plan);
  const over = f.rows.filter(r=>r.mins > plan.windowMinutes);
  const zones = $('#zones');
  zones.innerHTML = f.rows.map(r => renderZoneCard(plan, r, f)).join('');

  // 未分配
  const ua = unassignedVillages(plan);
  $('#unassigned').classList.toggle('hidden', ua.length===0);
  if(ua.length){
    $('#unassigned').innerHTML = `<h4>未分配的村（${ua.length}）— 直接指定人：</h4>
      <div class="chips">${ua.map(v=>{
        const elig = eligibleCouriers(state, plan, v.bus);
        return `<span class="uv-chip"><b class="vtag ${v.bus}">${v.bus==='late'?'晚':'早'}</b>${esc(v.name)}
          <span class="meta">${villageWork(v)}分/${v.parcels}件</span>
          <select data-vid="${v.id}">
            <option value="">分给…</option>
            ${elig.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}
          </select></span>`;
      }).join('')}</div>`;
  }

  // 超窗口提示（在模式条下面追加，非阻断）
  if(over.length && ua.length===0){
    notice.className = 'notice';
    notice.innerHTML = `⚠️ ${over.map(r=>`「${esc(r.name)}」总时长 ${r.mins} 分钟，超出窗口 ${r.mins-plan.windowMinutes} 分钟`).join('；')}。
      <div class="btns">
        <button class="btn small primary" id="rebalanceStable">保留熟片微调</button>
        <button class="btn small" id="rebalanceFull">重新均衡</button>
      </div>`;
    notice.classList.remove('hidden');
    $('#rebalanceStable').onclick = ()=>{ autoAllocate(state, plan, {early:true,late:true}, true); save(); render(); };
    $('#rebalanceFull').onclick = ()=>{ autoAllocate(state, plan, {early:true,late:true}, false); save(); render(); };
  }
}

function renderZoneCard(plan, r, fair){
  const c = state.couriers.find(x=>x.id===r.cid);
  const vs = state.villages.filter(v=>plan.assign[v.id] && plan.assign[v.id].courier===r.cid);
  const early = vs.filter(v=>v.bus==='early');
  const late  = vs.filter(v=>v.bus==='late');
  const stats = personStats(plan, r.cid);
  const heavy = r.cid === (fair.rows.find(x=>x.mins===fair.max)||{}).cid && fair.max>fair.min;
  const light = r.cid === (fair.rows.find(x=>x.mins===fair.min)||{}).cid && fair.max>fair.min;
  const over = stats.total.mins > plan.windowMinutes;
  const takeover = stats.total.takeoverCount
    ? `<span class="delta-add">代班 +${stats.total.takeoverParcels}件 / +${stats.total.takeoverMins}分</span>` : '';

  const listOf = arr => arr.length
    ? `<ul class="villages">${arr.map(v=>{
        const elig = eligibleCouriers(state, plan, v.bus);
        return `<li>
          <span class="vn">${esc(v.name)}</span>
          <span class="meta">${roadLabel(v.road)} · ${v.trip}分路 · ${v.parcels}件</span>
          ${plan.assign[v.id].takeover ? '<span class="vtag takeover">代班</span>' : ''}
          <select data-move="${v.id}">
            ${state.couriers.map(c=>{
              const ok = elig.some(e=>e.id===c.id);
              const dis = ok ? '' : 'disabled';
              return `<option value="${c.id}" ${c.id===r.cid?'selected':''} ${dis}>${esc(c.name)}${ok?'':'（不可混分/请假）'}</option>`;
            }).join('')}
          </select>
        </li>`;
      }).join('')}</ul>`
    : '<div class="drop-hint">— 无 —</div>';

  return `
  <div class="zone-card ${late.length && !early.length?'late':''}" style="--c:${c.color}">
    <div class="zone-head">
      <span class="dot" style="width:12px;height:12px;border-radius:50%;background:${c.color}"></span>
      <span class="name">${esc(c.name)}</span>
      ${late.length?'<span class="badge late">晚班片</span>':''}
      ${early.length?'<span class="badge early">早班片</span>':''}
      ${takeover}
      <span class="rest">${r.earlyMins?'早'+r.earlyMins+'分':''}${r.lateMins?' · 晚'+r.lateMins+'分':''}</span>
    </div>
    <div class="zone-stats">
      <div class="stat ${heavy?'heavy':''} ${light?'light':''}">
        <b>${stats.total.mins}</b><span>总时长(分) ${over?'<div class="over">超窗口'+(stats.total.mins-plan.windowMinutes)+'</div>':''}</span>
      </div>
      <div class="stat ${heavy?'heavy':''} ${light?'light':''}">
        <b>${stats.total.parcels}</b><span>总件量</span>
      </div>
      <div class="stat"><b>${stats.total.count}</b><span>村子数</span></div>
    </div>
    ${early.length?`<div style="padding:6px 14px 0;font-size:12px;color:#16a34a;font-weight:700">☀️ 早班车片（${early.length}村 / ${stats.early.parcels}件 / ${stats.early.mins}分）</div>`:''}
    ${listOf(early)}
    ${late.length?`<div style="padding:6px 14px 0;font-size:12px;color:#d97706;font-weight:700">🌙 晚班车片（${late.length}村 / ${stats.late.parcels}件 / ${stats.late.mins}分）</div>`:''}
    ${listOf(late)}
  </div>`;
}

function refreshStatsOnly(){
  renderData();
  if($('#tab-plan').classList.contains('active')) renderPlan();
  if($('#tab-compare').classList.contains('active')) renderCompare();
  // 数据页合计即时更新
  const total = state.villages.reduce((a,v)=>a+v.parcels,0);
  $('#sumParcels').textContent = total + ' 件';
}

/* 手动移动村子 */
$('#zones').addEventListener('change', e => {
  const vid = e.target.dataset.move;
  const plan = activePlan();
  if(!vid) return;
  const v = state.villages.find(x=>x.id===vid);
  const target = e.target.value;
  const prev = plan.assign[vid];
  const wasLeavers = prev && prev.courier === plan.leaveCourier;
  plan.assign[vid] = { courier: target, takeover: !!wasLeavers || (prev && prev.takeover && target === plan.leaveCourier ? false : prev && prev.takeover) };
  // 简单规则：从请假人手里接走的村保持"代班"标记；移到别人手上仍算新增负担
  plan.assign[vid].takeover = !!(wasLeavers || (prev && prev.takeover));
  save(); render();
});
$('#unassigned').addEventListener('change', e => {
  const vid = e.target.dataset.vid;
  const plan = activePlan();
  if(!vid || !e.target.value) return;
  plan.assign[vid] = { courier: e.target.value, takeover: !!plan.leaveCourier };
  save(); render();
});

/* 方案增删切换 */
$('#planSelect').addEventListener('change', e => { state.activePlanId = e.target.value; save(); render(); });
$('#copyPlanBtn').addEventListener('click', () => {
  const p = activePlan();
  const names = state.plans.map(x=>x.name);
  let base = p.name.replace(/\s*副本\d*$/,''), n = base + ' 副本', i=2;
  while(names.includes(n)){ n = base + ' 副本' + (i++); }
  const np = createPlanFrom(state, n, p);
  state.plans.push(np); state.activePlanId = np.id; save(); render();
});
$('#delPlanBtn').addEventListener('click', () => {
  if(state.plans.length<=1) return;
  const p = activePlan();
  if(!confirm(`删除方案「${p.name}」？`)) return;
  state.plans = state.plans.filter(x=>x.id!==p.id);
  state.activePlanId = state.plans[0].id; save(); render();
});

/* 自动均衡 */
$('#autoBtn').addEventListener('click', () => {
  const plan = activePlan();
  showModal(`
    <h3>⚖️ 自动均衡分片</h3>
    <p style="color:#6b7280;line-height:1.8">按 <b>路况折算时长 + 件量耗时</b> 均衡早晚两批村（早晚绝不混分）。重活先派，每步分给当前最闲的人。</p>
    <label class="field" style="display:flex;gap:8px;align-items:center;font-weight:500">
      <input type="checkbox" id="stableChk" checked> 保留熟片（只动必须动的村，适合窗口/班车微调后）
    </label>
    <div class="actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" id="doAuto">开始分片</button>
    </div>`);
  $('#doAuto').onclick = () => {
    const stable = $('#stableChk').checked;
    autoAllocate(state, plan, {early:true,late:true}, stable);
    save(); closeModal(); render();
  };
});

/* 晚班村：单独安排 / 混编 切换 */
$('#modeRow').addEventListener('click', e => {
  const plan = activePlan();
  if(e.target.id === 'lateModeBtn'){
    showModal(`
      <h3>🌙 晚班车片安排</h3>
      <p style="color:#6b7280;line-height:1.8">晚班车下午才到镇，晚到村单独安排，<b>不能和早班混着分</b>。指定一个人专跑晚班片后，他不再分早班村，其他人的晚班村会交给他。</p>
      <div class="field">
        <label>晚班片由谁跑</label>
        <select id="lateCourierSel">
          <option value="">不单独安排（早晚一起均衡分）</option>
          ${state.couriers.filter(c=>c.id!==plan.leaveCourier).map(c=>
            `<option value="${c.id}" ${c.id===plan.lateCourier?'selected':''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <label class="field" style="display:flex;gap:8px;font-weight:500">
        <input type="checkbox" id="lateStable" checked> 其余村尽量不动（保留熟片）
      </label>
      <div class="actions">
        <button class="btn" onclick="closeModal()">取消</button>
        <button class="btn primary" id="lateOk">确定并重分</button>
      </div>`);
    $('#lateOk').onclick = () => {
      const cid = $('#lateCourierSel').value;
      const stable = $('#lateStable').checked;
      plan.lateOnly = !!cid;
      plan.lateCourier = cid || null;
      // 违反新约束的指派作废后重分
      unassignedVillages(plan).forEach(v=>delete plan.assign[v.id]);
      autoAllocate(state, plan, {early:true,late:true}, stable);
      save(); closeModal(); render();
    };
  }
  if(e.target.id === 'leaveModeBtn'){
    const cur = plan.leaveCourier;
    showModal(`
      <h3>🙋 请假代班</h3>
      <p style="color:#6b7280;line-height:1.8">请假后，他的片区会拆给其他人，接过来的村打 <span class="vtag takeover">代班</span> 标记，
      分片卡片上能直接看到每个人<b style="color:#dc2626">多出多少件、多少分钟</b>。</p>
      <div class="field">
        <label>今天谁请假</label>
        <select id="leaveSel">
          <option value="">无人请假（正常排班）</option>
          ${state.couriers.map(c=>`<option value="${c.id}" ${c.id===cur?'selected':''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="actions">
        <button class="btn" onclick="closeModal()">取消</button>
        <button class="btn primary" id="leaveOk">确定，拆片区</button>
      </div>`);
    $('#leaveOk').onclick = () => {
      const cid = $('#leaveSel').value;
      if(cid === (plan.leaveCourier||'')){ closeModal(); return; }
      if(cid){
        if(plan.lateCourier === cid){ plan.lateOnly = false; plan.lateCourier = null; }
        applyLeave(plan, cid);
      }else{
        cancelLeave(plan);
      }
      save(); closeModal(); render();
    };
  }
});

/* 批量改班车批次/到镇时间 */
$('#busBatchBtn').addEventListener('click', () => {
  const plan = activePlan();
  showModal(`
    <h3>🚌 批量调整班车</h3>
    <p style="color:#6b7280">班车时间一变，原先分的片得跟着动。勾选受影响的村，改完自动只重划早晚受影响的批，熟片尽量不动。</p>
    <div class="field">
      <label>改为</label>
      <select id="busBatchGroup">
        <option value="early">早班车（上午到镇）</option>
        <option value="late">晚班车（下午到镇）</option>
      </select>
    </div>
    <div class="field">
      <label>到镇时间</label>
      <input type="time" id="busBatchTime" value="13:20">
    </div>
    <div class="field">
      <label>勾选村子</label>
      <div class="check-list" id="busCheckList">
        ${state.villages.map(v=>`
          <label><input type="checkbox" value="${v.id}">
            <span class="vn">${esc(v.name)}</span>
            <span class="m"><b class="vtag ${v.bus}">${v.bus==='late'?'晚':'早'}</b> ${esc(v.busTime)} · ${v.parcels}件</span>
          </label>`).join('')}
      </div>
    </div>
    <div class="actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" id="busBatchOk">应用并重划</button>
    </div>`);
  $('#busBatchOk').onclick = () => {
    const ids = $$('#busCheckList input:checked').map(i=>i.value);
    if(!ids.length){ alert('先勾选要调整的村'); return; }
    const group = $('#busBatchGroup').value;
    const time = $('#busBatchTime').value;
    const touchedGroups = { early:false, late:false };
    ids.forEach(id=>{
      const v = state.villages.find(x=>x.id===id);
      if(v.bus !== group) touchedGroups[v.bus] = true; // 原批次要补人
      v.bus = group; v.busTime = time;
      touchedGroups[group] = true;
    });
    // 越界指派作废
    unassignedVillages(plan).forEach(v=>delete plan.assign[v.id]);
    autoAllocate(state, plan, touchedGroups, true);
    save(); closeModal(); render();
  };
});

/* ================= ③ 方案对比 ================= */
function renderCompare(){
  const grid = $('#compareGrid');
  grid.innerHTML = state.plans.map(p=>{
    const f = planFairness(p);
    const leaveC = state.couriers.find(c=>c.id===p.leaveCourier);
    const lateC = state.couriers.find(c=>c.id===p.lateCourier);
    const totalParcels = f.rows.reduce((a,b)=>a+b.parcels,0);
    const gap = f.max - f.min;
    return `
    <div class="cmp-card">
      <div class="cmp-head">
        <span class="nm">${esc(p.name)}</span>
        ${leaveC?`<span class="badge leave">${esc(leaveC.name)}请假</span>`:''}
        ${p.lateOnly?`<span class="badge late">${esc(lateC?lateC.name:'')}专跑晚班</span>`:''}
        ${p.id===state.activePlanId?'<span class="badge early">当前</span>':
          `<button class="btn small ghost use" data-use="${p.id}">切到该方案</button>`}
      </div>
      ${f.rows.map(r=>{
        const cls = r.mins===f.max && f.max>f.min ? 'heavy' : (r.mins===f.min && f.max>f.min ? 'light':'');
        return `<div class="cmp-row ${cls}">
          <span class="who"><i style="background:${r.color}"></i>${esc(r.name)}</span>
          <span class="vals">${r.mins}分 · ${r.parcels}件
            ${r.takeoverParcels?`<b style="color:#7c3aed">（代班+${r.takeoverParcels}件）</b>`:''}
            ${r.mins>p.windowMinutes?'<b style="color:#dc2626">超窗口</b>':''}</span>
        </div>`;
      }).join('')}
      <div class="cmp-total">
        <span>忙闲差：<b style="color:${gap>60?'#dc2626':'#16a34a'}">${gap} 分钟</b></span>
        <span>${totalParcels} 件 / ${f.rows.length} 人 · 窗口 ${p.windowMinutes} 分</span>
      </div>
    </div>`;
  }).join('');

  /* 公平性明细表 */
  const all = state.plans.map(p=>{
    const f = planFairness(p);
    const gap = f.max - f.min;
    return { p, f, gap };
  });
  const bestGap = Math.min(...all.map(a=>a.gap));
  const worstGap = Math.max(...all.map(a=>a.gap));
  const maxGap = Math.max(1, worstGap);
  $('#fairnessTable').innerHTML = `
    <table>
      <thead><tr><th>方案</th><th>人均时长</th><th>最忙 / 最闲</th><th>忙闲差（越小越公平）</th></tr></thead>
      <tbody>
        ${all.map(a=>`
          <tr>
            <td>${esc(a.p.name)}${a.p.leaveCourier?' <span class="badge leave">请假</span>':''}</td>
            <td>${a.f.avg} 分</td>
            <td>${a.f.max} 分 / ${a.f.min} 分</td>
            <td>
              <span class="${a.gap===bestGap?'best':a.gap===worstGap&&all.length>1?'worst':''}">${a.gap} 分</span>
              <span class="bar" style="width:${Math.round(a.gap/maxGap*90)+30}px"></span>
              ${a.gap===bestGap?'最均衡':''}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

$('#compareGrid').addEventListener('click', e=>{
  const btn = e.target.closest('[data-use]');
  if(!btn) return;
  state.activePlanId = btn.dataset.use; save(); render();
});

/* ---------- 总渲染 ---------- */
function render(){
  renderData();
  renderPlan();
  renderCompare();
}
render();
