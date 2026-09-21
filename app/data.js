/* ===== 数据层：村庄 / 快递员 / 方案，localStorage 持久化 ===== */

const STORAGE_KEY = 'kuaidi_fenpian_v1';

const ROADS = [
  { v: 'good', label: '柏油路好走' },
  { v: 'mid',  label: '水泥路一般' },
  { v: 'bad',  label: '山路/泥路难走' },
];

/* 路况系数：同样的往返分钟，难走路耗费更多精力，折算成"作业时长" */
const ROAD_FACTOR = { good: 1.0, mid: 1.2, bad: 1.5 };
/* 每件在村里派送+电话联系的耗时（分钟） */
const MIN_PER_PARCEL = 1.5;

function seedData(){
  return {
    windowMinutes: 480,
    couriers: [
      { id: 'c1', name: '王建国', color: '#2563eb', leave: false },
      { id: 'c2', name: '李秀芳', color: '#16a34a', leave: false },
      { id: 'c3', name: '张志强', color: '#d97706', leave: false },
    ],
    villages: [
      { id:'v1',  name:'东河村', road:'good', trip:35, parcels:60, bus:'early', busTime:'08:30' },
      { id:'v2',  name:'西坡村', road:'mid',  trip:50, parcels:45, bus:'early', busTime:'08:30' },
      { id:'v3',  name:'南峪村', road:'bad',  trip:75, parcels:30, bus:'early', busTime:'08:50' },
      { id:'v4',  name:'北沟村', road:'mid',  trip:55, parcels:40, bus:'early', busTime:'08:50' },
      { id:'v5',  name:'大岭村', road:'bad',  trip:80, parcels:25, bus:'late',  busTime:'13:20' },
      { id:'v6',  name:'小岭村', road:'mid',  trip:60, parcels:35, bus:'late',  busTime:'13:20' },
      { id:'v7',  name:'青石村', road:'good', trip:40, parcels:55, bus:'early', busTime:'08:30' },
      { id:'v8',  name:'白沙村', road:'good', trip:30, parcels:70, bus:'early', busTime:'08:30' },
      { id:'v9',  name:'红岩村', road:'bad',  trip:85, parcels:22, bus:'late',  busTime:'13:40' },
      { id:'v10', name:'双溪村', road:'mid',  trip:45, parcels:48, bus:'early', busTime:'08:50' },
      { id:'v11', name:'柳湾村', road:'good', trip:38, parcels:52, bus:'early', busTime:'08:30' },
      { id:'v12', name:'桃园村', road:'mid',  trip:58, parcels:33, bus:'late',  busTime:'13:40' },
      { id:'v13', name:'槐树村', road:'good', trip:32, parcels:58, bus:'early', busTime:'08:30' },
      { id:'v14', name:'石桥村', road:'mid',  trip:52, parcels:38, bus:'early', busTime:'08:50' },
    ],
    plans: [],
    activePlanId: null,
  };
}

let state = load();

function load(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const s = JSON.parse(raw);
      if(s && s.villages && s.couriers) return s;
    }
  }catch(e){}
  const fresh = seedData();
  const p = createPlanFrom(fresh, '方案A · 早晚均衡', null);
  autoAllocate(fresh, p, { late:true, early:true }, false);
  const p2 = createPlanFrom(fresh, '方案B · 晚班专跑', null);
  p2.lateOnly = true; p2.lateCourier = 'c3';
  autoAllocate(fresh, p2, { late:true, early:true }, false);
  fresh.plans = [p, p2];
  fresh.activePlanId = p.id;
  return fresh;
}

function save(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid(prefix){ return prefix + '_' + Math.random().toString(36).slice(2,8); }

/* 单个村的作业时长：往返时间 × 路况系数 + 件量×单件耗时 */
function villageWork(v){
  return Math.round(v.trip * (ROAD_FACTOR[v.road]||1) + v.parcels * MIN_PER_PARCEL);
}

/* 某人在某方案中的统计：按班车批次分开算 */
function personStats(plan, cid){
  const r = {
    early:{ mins:0, parcels:0, count:0, takeoverMins:0, takeoverParcels:0, takeoverCount:0 },
    late:{ mins:0, parcels:0, count:0, takeoverMins:0, takeoverParcels:0, takeoverCount:0 },
  };
  for(const v of state.villages){
    const a = plan.assign[v.id];
    if(!a || a.courier !== cid) continue;
    const w = villageWork(v);
    const g = r[v.bus];
    g.mins += w; g.parcels += v.parcels; g.count++;
    if(a.takeover){ g.takeoverMins += w; g.takeoverParcels += v.parcels; g.takeoverCount++; }
  }
  r.total = {
    mins: r.early.mins + r.late.mins,
    parcels: r.early.parcels + r.late.parcels,
    count: r.early.count + r.late.count,
    takeoverMins: r.early.takeoverMins + r.late.takeoverMins,
    takeoverParcels: r.early.takeoverParcels + r.late.takeoverParcels,
    takeoverCount: r.early.takeoverCount + r.late.takeoverCount,
  };
  return r;
}

/* 创建空方案 */
function createPlanFrom(src, name, copyFrom){
  const plan = {
    id: uid('p'),
    name: name || ('方案 ' + String.fromCharCode(65 + src.plans.length)),
    windowMinutes: src.windowMinutes,
    lateOnly: false,      // 晚班村是否单独找人（true=晚班只分给指定1人）
    lateCourier: null,
    leaveCourier: null,
    assign: {},
  };
  if(copyFrom){
    plan.windowMinutes = copyFrom.windowMinutes;
    plan.lateOnly = copyFrom.lateOnly;
    plan.lateCourier = copyFrom.lateCourier;
    plan.leaveCourier = copyFrom.leaveCourier;
    plan.assign = JSON.parse(JSON.stringify(copyFrom.assign));
  }
  return plan;
}

/* 当前可参与某批次分配的人 */
function eligibleCouriers(src, plan, bus){
  let list = src.couriers.filter(c => !c.leave && !(plan.leaveCourier && c.id === plan.leaveCourier));
  if(bus === 'late'){
    if(plan.lateOnly && plan.lateCourier) list = list.filter(c => c.id === plan.lateCourier);
  }else{
    if(plan.lateOnly && plan.lateCourier) list = list.filter(c => c.id !== plan.lateCourier);
  }
  return list;
}

/*
 * 自动均衡分片（贪心 LPT：重活先挑，每步分给当前最闲的人）
 * groups: {early:true/false, late:true/false}  只重划指定批次；
 * stable: true 时保留原归属，仅在人不够/原主人请假时才动，尽量少动熟片
 */
function autoAllocate(src, plan, groups, stable){
  const pool = src.villages.slice().sort((a,b)=> villageWork(b) - villageWork(a));
  const loads = {};
  for(const c of src.couriers) loads[c.id] = { early:0, late:0 };

  // 先把"不动"批次的现有分配计入负载
  for(const v of src.villages){
    if(groups[v.bus]) continue;
    const a = plan.assign[v.id];
    if(a && loads[a.courier]) loads[a.courier][v.bus] += villageWork(v);
  }

  for(const v of pool){
    if(!groups[v.bus]) continue;
    const elig = eligibleCouriers(src, plan, v.bus).map(c=>c.id);
    const prev = plan.assign[v.id];
    if(stable && prev && elig.includes(prev.courier) && !prev.takeover){
      loads[prev.courier][v.bus] += villageWork(v);
      continue; // 熟片不动
    }
    if(elig.length === 0){
      delete plan.assign[v.id];
      continue;
    }
    let best;
    let bestLoad = Infinity;
    const otherBus = v.bus === 'late' ? 'early' : 'late';
    for(const cid of elig){
      // 先保证本批次内各人均衡（主分），再用总负载做小权重约束，
      // 避免"早晚都跑同一个人"导致某人总量被塞满
      const gLoad = loads[cid][v.bus];
      const total = loads[cid].early + loads[cid].late;
      const score = gLoad * 4 + total;
      if(score < bestLoad - 1e-9 ||
         (Math.abs(score - bestLoad) <= 1e-9 &&
          gLoad + loads[cid][otherBus] < (loads[best] ? loads[best][v.bus] + loads[best][otherBus] : Infinity))){
        bestLoad = score; best = cid;
      }
    }
    const wasTakeover = !!(plan.leaveCourier && prev &&
      (prev.courier === plan.leaveCourier || prev.takeover));
    plan.assign[v.id] = { courier: best, takeover: wasTakeover };
    loads[best][v.bus] += villageWork(v);
  }
  return plan;
}

/* 请假：标记请假人，把他的村重分给别人（takeover=true 以便看出谁变重了） */
function applyLeave(plan, cid){
  plan.leaveCourier = cid;
  for(const v of state.villages){
    const a = plan.assign[v.id];
    if(a && a.courier === cid){
      a.takeover = true; // 先标记，重划时若换了主人就保留"代班"标记
    }
  }
  autoAllocate(state, plan, { early:true, late:true }, true);
  // 分给本人（已被排除，不会）或仍未分的村 takeover 标记清理
}

function cancelLeave(plan){
  // 把代班期间拆出去的村还给回来的人（他跑熟的片），其余村不动
  const cid = plan.leaveCourier;
  if(cid){
    for(const k in plan.assign){
      const a = plan.assign[k];
      if(a.takeover){ a.courier = cid; a.takeover = false; }
    }
  }
  plan.leaveCourier = null;
}

/* 把所有未分配村列出（如人不够、班车改批次后越界） */
function unassignedVillages(plan){
  return state.villages.filter(v => {
    const a = plan.assign[v.id];
    if(!a) return true;
    const c = state.couriers.find(x=>x.id===a.courier);
    if(!c || c.leave || c.id===plan.leaveCourier) return true;
    if(plan.lateOnly && a.courier === plan.lateCourier && v.bus !== 'late') return true;
    if(plan.lateOnly && a.courier !== plan.lateCourier && v.bus === 'late') return true;
    return false;
  });
}

/* 方案公平性指标 */
function planFairness(plan){
  const active = state.couriers.filter(c => !c.leave && c.id !== plan.leaveCourier);
  const rows = active.map(c=>{
    const s = personStats(plan, c.id);
    return { cid:c.id, name:c.name, color:c.color, mins:s.total.mins, parcels:s.total.parcels,
             earlyMins:s.early.mins, lateMins:s.late.mins,
             takeoverMins:s.total.takeoverMins, takeoverParcels:s.total.takeoverParcels };
  });
  const minsArr = rows.map(r=>r.mins);
  return {
    rows,
    max: rows.length ? Math.max(...minsArr) : 0,
    min: rows.length ? Math.min(...minsArr) : 0,
    avg: rows.length ? Math.round(rows.reduce((a,b)=>a+b.mins,0)/rows.length) : 0,
  };
}
