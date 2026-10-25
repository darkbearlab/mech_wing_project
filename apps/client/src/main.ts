import {
  CHASSIS,
  EQUIPMENT,
  GRAPPLE_NAMES,
  PILOTS,
  availableManeuvers,
  bandName,
  buildPath,
  config,
  grappleOptions,
  hitChance,
  parseManeuver,
  planCost,
  samplePath,
  type EquipState,
  type GameEvent,
  type GrappleChoice,
  type Hand,
  type ActionPlan,
  type ClientMessage,
  type MovePlan,
  type PlayerId,
  type PlayerView,
  type ServerMessage,
  type Stance,
  type UnitState,
  type UnitView,
  type Vec,
} from '@mech/rules';
import { LocalGame } from './local';

// ---------- 連線 ----------

const params = new URLSearchParams(location.search);
// server：連本機 WebSocket 伺服器，兩個視窗各坐一席；local：同一台裝置輪流（GitHub Pages 用這個）
const mode = params.get('mode') ?? (import.meta.env.PROD ? 'local' : 'server');
const room = params.get('room') || 'test';
let seat: PlayerId = params.get('seat') === '1' ? 1 : 0;

let ws: WebSocket;
let local: LocalGame | null = null;
let view: PlayerView | null = null;
let connected: [boolean, boolean] = [false, false];
let deadline: number | null = null;
let errors: string[] = [];

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}&seat=${seat}`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data) as ServerMessage);
  ws.onclose = () => {
    connected = [false, false];
    renderStatus();
    setTimeout(connect, 1000);
  };
}

function sendMsg(msg: ClientMessage) {
  if (local) {
    const next = local.submit(seat, msg);
    if (next === null) return;
    if (msg.t === 'reset') switchSeat(next);
    else showCover(next);
    return;
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

const SIDE = (s: PlayerId) => (s === 0 ? 'A' : 'B');

/** 本機模式換手：先蓋住畫面，等下一位按下才顯示他的視角 */
function showCover(next: PlayerId) {
  const cover = document.getElementById('cover')!;
  cover.innerHTML = `<div><p>輪到 <b style="color:${color(next)}">${SIDE(next)} 方</b></p><p class="muted">請把裝置交給對方，避免看到彼此的駕駛與指令。</p><button class="primary" id="coverBtn">我是 ${SIDE(next)} 方，開始</button></div>`;
  cover.hidden = false;
  document.getElementById('coverBtn')!.onclick = () => {
    cover.hidden = true;
    switchSeat(next);
  };
}

function switchSeat(next: PlayerId) {
  seat = next;
  view = null;
  draftKey = '';
  selected = null;
  playback = null;
  pendingView = null;
  errors = [];
  renderLog();
  local!.takeOver(next);
}

// ---------- 用戶端狀態 ----------

let moveDrafts: Record<string, MovePlan> = {};
let actionDrafts: Record<string, ActionPlan> = {};
let draftKey = '';
let selected: string | null = null;
let pendingView: PlayerView | null = null;
let playback: { events: GameEvent[]; start: number; duration: number; prevUnits: UnitView[] } | null = null;
const logs: [{ text: string; cls: string }[], { text: string; cls: string }[]] = [[], []];
const PLAYBACK_MS = 2600;
/** 只有射擊等動作、沒有移動時的播放時間 */
const ACTION_PLAYBACK_MS = 900;

function onMessage(msg: ServerMessage) {
  if (msg.t === 'state') {
    connected = msg.connected;
    deadline = msg.deadline;
    if (playback) pendingView = msg.view;
    else applyView(msg.view);
  } else if (msg.t === 'resolved') {
    errors = [];
    appendLog(msg.events);
    const duration = msg.events.some((e) => e.type === 'move') ? PLAYBACK_MS : ACTION_PLAYBACK_MS;
    playback = { events: msg.events, start: performance.now(), duration, prevUnits: view?.state.units ?? [] };
    // 用計時器結束播放：分頁在背景時 requestAnimationFrame 不會跑，不能靠它套用新狀態
    const current = playback;
    setTimeout(() => {
      if (playback !== current) return;
      playback = null;
      if (pendingView) applyView(pendingView);
      pendingView = null;
    }, duration + 400);
  } else if (msg.t === 'error') {
    errors = msg.errors;
    renderPanel();
  }
}

function applyView(v: PlayerView) {
  view = v;
  const key = `${v.state.turn}:${v.phase}`;
  if (key !== draftKey) {
    draftKey = key;
    moveDrafts = {};
    actionDrafts = {};
    for (const u of ownUnits()) {
      if (u.status !== 'active') continue;
      if (v.phase === 'move') moveDrafts[u.id] = initialMove(u);
      if (v.phase === 'action') actionDrafts[u.id] = { action: { type: 'none' } };
    }
  }
  if (!selected || !v.state.units.some((u) => u.id === selected)) selected = ownUnits().find((u) => u.status === 'active')?.id ?? null;
  renderAll();
}

const ownUnits = () => (view ? view.state.units.filter((u) => u.owner === view!.you) : []);
const unitView = (id: string) => view?.state.units.find((u) => u.id === id);
const labelOf = (id: string) => unitView(id)?.label ?? playback?.prevUnits.find((u) => u.id === id)?.label ?? id;
const inGrapple = (id: string) => !!view?.state.grapples.some((g) => g.a === id || g.b === id);
const equipName = (u: UnitView | undefined, eqId: string | null) => {
  if (!eqId) return '空手';
  const e = u?.equipment.find((x) => x.id === eqId);
  return e ? EQUIPMENT[e.defId].name : eqId;
};

function initialMove(u: UnitView): MovePlan {
  const opts = availableManeuvers(u);
  const pick = opts.find((m) => m.id === 'straight-S-2') ?? opts.find((m) => m.propellant === 0) ?? opts[0];
  return { maneuver: pick?.id ?? 'hover-S-0', stance: 'normal', facingOffset: 0, limiter: false, soften: false, grapple: 'push' };
}

/** 套用規劃中的換武器後，手上會拿著什麼 */
function equipmentAfterSwap(u: UnitView, plan: ActionPlan | undefined): EquipState[] {
  const eq = structuredClone(u.equipment);
  if (!plan?.swap) return eq;
  const { hand, equip } = plan.swap;
  for (const e of eq) if (e.location === hand) e.location = 'stowed';
  const next = eq.find((e) => e.id === equip);
  if (next) next.location = hand;
  return eq;
}

function heldAfter(u: UnitView, plan: ActionPlan | undefined, hand: Hand): EquipState | null {
  const arm = hand === 'right' ? 'rarm' : 'larm';
  if (u.parts[arm].destroyed) return null;
  return equipmentAfterSwap(u, plan).find((e) => e.location === hand && !u.parts[e.id].destroyed) ?? null;
}

// ---------- 畫面：地圖 ----------

const canvas = document.getElementById('map') as HTMLCanvasElement;
const g = canvas.getContext('2d')!;
const S = canvas.width / config.MAP_SIZE;
const color = (owner: number, alpha = 1) => (owner === 0 ? `rgba(74,163,255,${alpha})` : `rgba(255,93,93,${alpha})`);

canvas.addEventListener('click', (e) => {
  if (!view) return;
  const r = canvas.getBoundingClientRect();
  const k = canvas.width / r.width;
  const p = { x: ((e.clientX - r.left) * k) / S, y: ((e.clientY - r.top) * k) / S };
  const hit = view.state.units.find((u) => Math.hypot(u.pos.x - p.x, u.pos.y - p.y) < config.BASE_RADIUS + 0.2);
  if (hit) {
    selected = hit.id;
    renderAll();
  }
});

function drawFrame(now: number) {
  requestAnimationFrame(drawFrame);
  g.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();
  if (!view) return;

  let progress = 1;
  // rAF 的時間戳可能比 playback.start 還早，要夾在 0..1
  if (playback) progress = Math.max(0, Math.min(1, (now - playback.start) / playback.duration));

  if (!playback) {
    drawRanges();
    drawPreviews();
    for (const u of view.state.units) drawUnit(u, u.pos, u.facing);
  } else {
    const moves = new Map<string, [number, number, number][]>();
    for (const e of playback.events) if (e.type === 'move') moves.set(e.unit, e.samples);
    for (const [, samples] of moves) {
      g.strokeStyle = 'rgba(255,255,255,0.12)';
      g.beginPath();
      samples.forEach(([x, y], i) => (i ? g.lineTo(x * S, y * S) : g.moveTo(x * S, y * S)));
      g.stroke();
    }
    for (const e of playback.events) {
      if (e.type === 'contact' && e.t <= progress && e.result !== 'none') {
        const a = sampleAt(moves.get(e.a), e.t);
        const b = sampleAt(moves.get(e.b), e.t);
        if (a && b) {
          g.fillStyle = e.result === 'ram' ? '#ff8a3d' : e.result === 'hitrun' ? '#ffcf4a' : '#c0c0ff';
          g.beginPath();
          g.arc(((a.x + b.x) / 2) * S, ((a.y + b.y) / 2) * S, 6, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    for (const u of playback.prevUnits) {
      const s = sampleAt(moves.get(u.id), progress);
      const live = view.state.units.find((x) => x.id === u.id) ?? u;
      drawUnit(progress >= 1 ? live : u, s ?? u.pos, s?.f ?? u.facing);
    }
    if (progress >= 1) drawShots(playback.events);
  }
}

function sampleAt(samples: [number, number, number][] | undefined, t: number): (Vec & { f: number }) | null {
  if (!samples) return null;
  const idx = Math.min(samples.length - 1, t * (samples.length - 1));
  const i = Math.floor(idx);
  const j = Math.min(samples.length - 1, i + 1);
  const k = idx - i;
  const [x0, y0, f0] = samples[i];
  const [x1, y1, f1] = samples[j];
  return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k, f: k < 0.5 ? f0 : f1 };
}

function drawGrid() {
  for (let i = 0; i <= config.MAP_SIZE; i++) {
    g.strokeStyle = i % 6 === 0 ? '#1f2a35' : '#141b22';
    g.beginPath();
    g.moveTo(i * S, 0);
    g.lineTo(i * S, canvas.height);
    g.moveTo(0, i * S);
    g.lineTo(canvas.width, i * S);
    g.stroke();
  }
}

function drawUnit(u: UnitView, pos: Vec, facing: number) {
  const out = u.status !== 'active';
  const x = pos.x * S;
  const y = pos.y * S;
  const r = config.BASE_RADIUS * S;
  g.fillStyle = out ? '#3a3f45' : color(u.owner, 0.85);
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  if (u.id === selected) {
    g.strokeStyle = '#ffcf4a';
    g.lineWidth = 2;
    g.stroke();
    g.lineWidth = 1;
  }
  // 朝向
  g.strokeStyle = '#fff';
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + Math.cos(facing) * r * 1.4, y + Math.sin(facing) * r * 1.4);
  g.stroke();
  // 盾弧
  const shield = (['right', 'left'] as Hand[]).find((h) => {
    const e = u.equipment.find((x) => x.location === h && !u.parts[x.id].destroyed);
    return e && EQUIPMENT[e.defId].kind === 'shield' && !u.parts[h === 'right' ? 'rarm' : 'larm'].destroyed;
  });
  if (shield && !out) {
    const c = facing + (shield === 'right' ? 1 : -1) * config.SHIELD_ARC_OFFSET_DEG * (Math.PI / 180);
    const half = config.SHIELD_ARC_HALF_DEG * (Math.PI / 180);
    g.strokeStyle = '#e6e6a0';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, r + 3, c - half, c + half);
    g.stroke();
    g.lineWidth = 1;
  }
  g.fillStyle = out ? '#777' : '#fff';
  g.font = '11px sans-serif';
  g.textAlign = 'center';
  g.fillText(u.label.split(' ')[0] + (u.vague === 'sluggish' ? ' ⚠' : ''), x, y - r - 4);
}

function drawRanges() {
  const u = selected ? unitView(selected) : null;
  if (!u || u.status !== 'active') return;
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  for (const lim of [config.RANGE_LIMITS.r1, config.RANGE_LIMITS.r2, config.RANGE_LIMITS.r3]) {
    g.beginPath();
    g.arc(u.pos.x * S, u.pos.y * S, (lim + 2 * config.BASE_RADIUS) * S, 0, Math.PI * 2);
    g.stroke();
  }
}

function drawPath(u: UnitView, maneuver: string, limiter: boolean, style: string) {
  const pts = samplePath(buildPath(u, { maneuver, limiter }));
  g.strokeStyle = style;
  g.setLineDash([5, 4]);
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p.x * S, p.y * S) : g.moveTo(p.x * S, p.y * S)));
  g.stroke();
  g.setLineDash([]);
  const end = pts[pts.length - 1];
  g.strokeStyle = style;
  g.beginPath();
  g.arc(end.x * S, end.y * S, config.BASE_RADIUS * S, 0, Math.PI * 2);
  g.stroke();
}

function drawPreviews() {
  if (view?.phase === 'move') {
    for (const [id, plan] of Object.entries(moveDrafts)) {
      const u = unitView(id);
      if (u && !inGrapple(id)) drawPath(u, plan.maneuver, plan.limiter, color(u.owner, id === selected ? 0.9 : 0.45));
    }
  } else if (view?.phase === 'action') {
    // 已選的射擊／鎖定目標
    for (const [id, plan] of Object.entries(actionDrafts)) {
      const a = unitView(id);
      const t = plan.action.type !== 'none' ? unitView(plan.action.target) : null;
      if (!a || !t) continue;
      g.strokeStyle = plan.action.type === 'shoot' ? 'rgba(255,207,74,0.8)' : 'rgba(120,220,255,0.7)';
      g.setLineDash([6, 4]);
      g.beginPath();
      g.moveTo(a.pos.x * S, a.pos.y * S);
      g.lineTo(t.pos.x * S, t.pos.y * S);
      g.stroke();
      g.setLineDash([]);
    }
  }
}

function drawShots(events: GameEvent[]) {
  for (const e of events) {
    if (e.type !== 'shot') continue;
    const a = unitView(e.attacker);
    const b = unitView(e.target);
    if (!a || !b) continue;
    g.strokeStyle = e.hits ? 'rgba(255,207,74,0.8)' : 'rgba(255,255,255,0.25)';
    g.beginPath();
    g.moveTo(a.pos.x * S, a.pos.y * S);
    g.lineTo(b.pos.x * S, b.pos.y * S);
    g.stroke();
  }
}

// ---------- 畫面：面板 ----------

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function renderAll() {
  renderStatus();
  renderUnits();
  renderPanel();
}

function renderStatus() {
  const other = seat === 0 ? 1 : 0;
  $('seatLinks').innerHTML = local
    ? `本機輪流模式　現在是 <b style="color:${color(seat)}">${SIDE(seat)} 方</b>`
    : `房間 <b>${esc(room)}</b>　你是 <b style="color:${color(seat)}">${SIDE(seat)} 方</b> <a href="?room=${encodeURIComponent(room)}&seat=${other}" target="_blank">開啟${SIDE(other)} 方視窗</a>`;
  if (!view) {
    $('status').textContent = '連線中…';
    return;
  }
  const phase = { move: '步驟 1／2：移動', action: '步驟 2／2：動作', over: '對戰結束' }[view.phase];
  const opp = connected[seat === 0 ? 1 : 0] ? '' : '（對手未連線）';
  const timer = deadline ? `　剩 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))} 秒` : '';
  $('status').textContent = `第 ${view.state.turn} 回合 · ${phase}${opp}${timer}`;
}
setInterval(() => deadline && renderStatus(), 1000);

function renderUnits() {
  if (!view) return;
  const el = $('units');
  el.innerHTML = '';
  for (const u of view.state.units) {
    const b = document.createElement('button');
    b.textContent = u.label + (u.status !== 'active' ? ' ✕' : '');
    b.className = [u.owner !== view.you ? 'enemy' : '', u.id === selected ? 'sel' : '', u.status !== 'active' ? 'out' : ''].join(' ');
    b.onclick = () => {
      selected = u.id;
      renderAll();
    };
    el.appendChild(b);
  }
}

function partsHtml(u: UnitView): string {
  const rows = Object.values(u.parts).map((p) => {
    const ratio = 1 - p.damage / p.durability;
    const cls = p.destroyed ? 'dead' : p.damage ? 'hurt' : '';
    return `<span>${esc(p.name)}</span><span class="bar ${cls}"><i style="width:${Math.max(4, ratio * 100)}%"></i></span><span class="muted">${p.durability - p.damage}/${p.durability}</span>`;
  });
  return `<div class="parts">${rows.join('')}</div>`;
}

const PHASE_HINT = {
  move: '<b>步驟 1／2：移動</b>　替每台機體選機動和姿態（地圖上的虛線是預計路徑），全部選好後按「送出移動」。雙方同時移動。',
  action: '<b>步驟 2／2：動作</b>　移動已結算，現在看得到實際距離。替每台機體選射擊、鎖定或換武器，再按「送出動作」。駕駛技能高的先結算。',
  over: '',
};

function renderPanel() {
  const ed = $('editor');
  const sub = $('submitArea');
  if (!view) {
    ed.innerHTML = '';
    sub.innerHTML = '';
    return;
  }
  $('phaseHint').innerHTML = PHASE_HINT[view.phase];
  const u = selected ? unitView(selected) : null;
  ed.innerHTML = u ? unitPanel(u) : '';
  bindEditor(u);

  sub.innerHTML = '';
  if (view.phase === 'over') {
    const w = view.state.winner;
    sub.innerHTML = `<h3>${w === 'draw' ? '平手' : w === view.you ? '勝利' : '敗北'}</h3>`;
    return;
  }
  const done = view.submitted[view.you];
  const isMove = view.phase === 'move';
  const label = done ? '已送出，等待對手…' : isMove ? '送出移動' : '送出動作';
  sub.innerHTML = `<hr>${isMove ? moveSummary() : actionSummary()}<div class="row"><button class="primary" id="submitBtn" ${done ? 'disabled' : ''}>${label}</button></div>`;
  $('submitBtn').onclick = () => sendMsg(isMove ? { t: 'moves', moves: moveDrafts } : { t: 'actions', actions: actionDrafts });
  if (errors.length) sub.innerHTML += `<div class="err">${errors.map(esc).join('<br>')}</div>`;
}

function moveSummary(): string {
  const lines = Object.entries(moveDrafts).map(([id, plan]) => {
    const u = unitView(id)!;
    if (inGrapple(id)) return `${esc(u.label)}：纏鬥「${GRAPPLE_NAMES[plan.grapple ?? 'push']}」`;
    const c = planCost(plan);
    return `${esc(u.label)}：${parseManeuver(plan.maneuver).name}，推進劑 −${c.propellant}，壓力 +${c.stress}`;
  });
  return `<div class="muted" style="font-size:12px">${lines.join('<br>')}</div>`;
}

function actionSummary(): string {
  const lines = Object.entries(actionDrafts).map(([id, plan]) => {
    const u = unitView(id)!;
    if (view!.state.bumped.includes(id)) return `${esc(u.label)}：擦撞，本回合不能行動`;
    const a = plan.action;
    const parts = [];
    if (plan.swap) parts.push(`換上${equipName(u, plan.swap.equip)}`);
    if (a.type === 'shoot') parts.push(`射擊 ${esc(labelOf(a.target))}`);
    if (a.type === 'lock') parts.push(`鎖定 ${esc(labelOf(a.target))}`);
    return `${esc(u.label)}：${parts.join('，') || '不行動'}`;
  });
  return `<div class="muted" style="font-size:12px">${lines.join('<br>')}</div>`;
}

function unitPanel(u: UnitView): string {
  const ch = CHASSIS[u.chassisId];
  const mine = u.owner === view!.you;
  const hands = (['right', 'left'] as Hand[]).map((h) => `${h === 'right' ? '右手' : '左手'}：${equipName(u, u.equipment.find((e) => e.location === h && !u.parts[e.id].destroyed)?.id ?? null)}`).join('　');
  let html = `<h3 style="color:${color(u.owner)}">${esc(u.label)} <span class="muted">${esc(ch.name)}　重量級 ${ch.weightClass}</span></h3>`;
  if (mine && u.pilotId) {
    const p = PILOTS[u.pilotId];
    html += `<div>駕駛：${esc(p.name)}（技能 ${p.skill}${p.abilities.length ? '・' + p.abilities.map(() => '快速拔刀').join('・') : ''}）</div>`;
    html += `<div>壓力 <b>${u.stress}</b>/${u.maxStress}　推進劑 <b>${u.propellant}</b>/${u.maxPropellant}${u.blackout ? '　<span class="warn">黑視中</span>' : ''}${u.lockOn ? `　鎖定：${esc(labelOf(u.lockOn))}` : ''}</div>`;
  } else {
    html += `<div class="muted">駕駛：不明${u.vague === 'sluggish' ? '　<span class="warn">動作遲鈍</span>' : ''}</div>`;
  }
  html += `<div>${hands}</div>${partsHtml(u)}`;
  if (u.status !== 'active') return html + `<div class="err">${{ destroyed: '已擊毀', withdrawn: '已脫離戰場', unconscious: '駕駛昏迷', disabled: '停止動作' }[u.status]}</div>`;
  if (!mine || view!.phase === 'over' || view!.submitted[view!.you]) return html;
  html += '<hr>';
  return html + (view!.phase === 'move' ? moveControls(u, moveDrafts[u.id]) : actionControls(u, actionDrafts[u.id]));
}

function moveControls(u: UnitView, plan: MovePlan): string {
  if (inGrapple(u.id)) {
    const opts = grappleOptions(u as unknown as UnitState);
    return `<div class="warn">纏鬥中：本回合不移動，改選纏鬥動作</div><div class="row"><label>纏鬥</label><select data-f="grapple">${opts.map((o) => `<option value="${o}" ${plan.grapple === o ? 'selected' : ''}>${GRAPPLE_NAMES[o]}</option>`).join('')}</select></div>`;
  }
  const prop = (u.propellant ?? 0) - (plan.facingOffset ? config.FACING_OFFSET_COST : 0);
  const opts = availableManeuvers({ ...u, propellant: prop });
  if (!opts.some((m) => m.id === plan.maneuver) && opts[0]) plan.maneuver = opts[0].id;
  let html = `<div class="row"><label>機動</label><select data-f="maneuver">${opts.map((m) => `<option value="${m.id}" ${m.id === plan.maneuver ? 'selected' : ''}>${m.name}（推 ${m.propellant}／壓 ${m.stress}）</option>`).join('')}</select></div>`;
  html += `<div class="row"><label>姿態</label>${(['normal', 'charge', 'evade'] as Stance[]).map((s) => `<label><input type="radio" name="stance" value="${s}" ${plan.stance === s ? 'checked' : ''}> ${{ normal: '一般', charge: '突進', evade: '迴避' }[s]}</label>`).join('')}</div>`;
  html += `<div class="muted" style="font-size:12px">${{ normal: '撞到別人只算碰撞。', charge: '撞到敵機時發動近戰（手上要有光劍或熱能斧才砍得到）。', evade: '比較不容易被撞到、被射中。' }[plan.stance]}</div>`;
  html += `<div class="row"><label>轉身</label><select data-f="facingOffset">${config.FACING_OFFSETS.map((f) => `<option value="${f}" ${plan.facingOffset === f ? 'selected' : ''}>${f === 0 ? '不轉' : `${f > 0 ? '右' : '左'} ${Math.abs(f)}°`}</option>`).join('')}</select></div>`;
  html += `<div class="row"><label></label><label><input type="checkbox" data-f="limiter" ${plan.limiter ? 'checked' : ''}> 限制器解除（速度 +1，壓力 +${config.LIMITER_STRESS}）</label></div>`;
  html += `<div class="row"><label></label><label><input type="checkbox" data-f="soften" ${plan.soften ? 'checked' : ''}> 收刀（接觸時花 1 壓力降一檔）</label></div>`;
  return html;
}

function actionControls(u: UnitView, plan: ActionPlan): string {
  if (view!.state.bumped.includes(u.id)) return '<div class="warn">這台機體在移動時擦撞，本回合不能行動。</div>';
  const swappable = u.equipment.filter((e) => e.location !== 'mount' && !u.parts[e.id].destroyed);
  const swapHand = plan.swap?.hand ?? 'right';
  let html = `<div class="row"><label>換武器</label><select data-f="swapHand"><option value="">不換</option>${(['right', 'left'] as Hand[]).map((h) => `<option value="${h}" ${plan.swap && swapHand === h ? 'selected' : ''}>${h === 'right' ? '右手' : '左手'}</option>`).join('')}</select>`;
  if (plan.swap) html += `<select data-f="swapEquip"><option value="">空手</option>${swappable.map((e) => `<option value="${e.id}" ${plan.swap!.equip === e.id ? 'selected' : ''}>${EQUIPMENT[e.defId].name}</option>`).join('')}</select>`;
  html += '</div>';
  const enemies = view!.state.units.filter((x) => x.owner !== view!.you && x.status === 'active');
  const ranged = (['right', 'left'] as Hand[]).map((h) => heldAfter(u, plan, h)).filter((e): e is EquipState => !!e && EQUIPMENT[e.defId].kind === 'ranged');
  const act = plan.action;
  html += `<div class="row"><label>動作</label><select data-f="actionType"><option value="none">不行動</option><option value="shoot" ${act.type === 'shoot' ? 'selected' : ''}>射擊</option><option value="lock" ${act.type === 'lock' ? 'selected' : ''}>鎖定（下次射擊 +${config.LOCK_BONUS}%）</option></select>`;
  if (act.type === 'shoot') html += `<select data-f="weapon">${ranged.map((e) => `<option value="${e.id}" ${act.weapon === e.id ? 'selected' : ''}>${EQUIPMENT[e.defId].name}</option>`).join('') || '<option value="">（手上沒有射擊武器）</option>'}</select>`;
  if (act.type !== 'none') {
    html += `<select data-f="target">${enemies
      .map((t) => {
        let est = '';
        if (act.type === 'shoot') {
          const w = ranged.find((e) => e.id === act.weapon);
          const h = w ? hitChance({ attacker: u, attackerSkill: PILOTS[u.pilotId!].skill, weapon: EQUIPMENT[w.defId], target: t, targetSkill: null, targetStance: null, targetHovered: false }) : null;
          est = h ? `　${bandName(h.band)}・約 ${h.chance}%` : '　射程外';
        }
        return `<option value="${t.id}" ${act.target === t.id ? 'selected' : ''}>${esc(t.label)}${est}</option>`;
      })
      .join('')}</select>`;
  }
  html += '</div>';
  if (act.type === 'shoot') html += '<div class="muted" style="font-size:12px">命中率是估計值：看不到對手的駕駛技能與姿態，實際通常會再低一些。</div>';
  if (plan.swap && !PILOTS[u.pilotId!].abilities.includes('quick_draw') && act.type !== 'none') html += '<div class="warn">換武器會用掉這回合的動作。</div>';
  return html;
}

function bindEditor(u: UnitView | null | undefined) {
  if (!u) return;
  const move = moveDrafts[u.id];
  const plan = actionDrafts[u.id];
  const ed = $('editor');
  const rerender = () => renderPanel();
  ed.querySelectorAll<HTMLInputElement>('input[name=stance]').forEach((r) => (r.onchange = () => ((move.stance = r.value as Stance), rerender())));
  ed.querySelectorAll<HTMLSelectElement | HTMLInputElement>('[data-f]').forEach((el) => {
    el.onchange = () => {
      const v = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
      switch (el.dataset.f) {
        case 'maneuver':
          move.maneuver = v as string;
          break;
        case 'grapple':
          move.grapple = v as GrappleChoice;
          break;
        case 'facingOffset':
          move.facingOffset = Number(v);
          break;
        case 'limiter':
          move.limiter = v as boolean;
          break;
        case 'soften':
          move.soften = v as boolean;
          break;
        case 'swapHand':
          plan.swap = v ? { hand: v as Hand, equip: heldAfter(u, undefined, v as Hand)?.id ?? null } : undefined;
          break;
        case 'swapEquip':
          if (plan.swap) plan.swap.equip = (v as string) || null;
          break;
        case 'actionType': {
          const firstEnemy = view!.state.units.find((x) => x.owner !== view!.you && x.status === 'active')?.id ?? '';
          if (v === 'none') plan.action = { type: 'none' };
          else if (v === 'lock') plan.action = { type: 'lock', target: firstEnemy };
          else {
            const w = (['right', 'left'] as Hand[]).map((h) => heldAfter(u, plan, h)).find((e) => e && EQUIPMENT[e.defId].kind === 'ranged');
            plan.action = { type: 'shoot', weapon: w?.id ?? '', target: firstEnemy };
          }
          break;
        }
        case 'weapon':
          if (plan.action.type === 'shoot') plan.action.weapon = v as string;
          break;
        case 'target':
          if (plan.action.type !== 'none') plan.action.target = v as string;
          break;
      }
      rerender();
    };
  });
}

// ---------- 事件紀錄 ----------

const RESULT_NAMES = { none: '擦身而過', bump: '擦撞', clinch: '纏鬥', hitrun: '一擊脫離', ram: '撞擊' };
const ANGLE_NAMES = { front: '正面', side: '側面', back: '背後' };

function partName(unitId: string, part: string): string {
  const u = unitView(unitId) ?? playback?.prevUnits.find((x) => x.id === unitId);
  return u?.parts[part]?.name ?? part;
}

function describe(e: GameEvent): string | null {
  const L = labelOf;
  switch (e.type) {
    case 'turnStart':
      return `── 第 ${e.turn} 回合 ──`;
    case 'contact':
      return e.result === 'none' ? null : `${L(e.a)} 與 ${L(e.b)} 接觸（Vc ${e.vc}）：${RESULT_NAMES[e.result]}`;
    case 'strike':
      return `${L(e.attacker)} 以${EQUIPMENT[e.weapon].name}斬向 ${L(e.defender)}（${ANGLE_NAMES[e.angle]}${e.chance !== undefined ? `，防禦機率 ${e.chance}%` : ''}）：${{ hit: '命中', parried: '被架開', blocked: '被盾擋下' }[e.outcome]}`;
    case 'shot':
      return `${L(e.attacker)} 以${EQUIPMENT[e.weapon].name}射擊 ${L(e.target)}（${bandName(e.band)}${e.chance !== undefined ? `，命中率 ${e.chance}%` : ''}）：${e.hits}/${e.shots} 命中${e.blocked ? `，盾擋 ${e.blocked}` : ''}`;
    case 'damage':
      return e.amount ? `${L(e.unit)} ${partName(e.unit, e.part)} 受 ${e.amount} 點傷害${e.destroyed ? '，破壞！' : ''}` : `${L(e.unit)} ${partName(e.unit, e.part)} 失效`;
    case 'knockback':
      return `${L(e.unit)} 被撞開，姿勢失控`;
    case 'stress':
      return `${L(e.unit)} 壓力 ${e.amount > 0 ? '+' : ''}${e.amount}（${e.reason}）→ ${e.total}`;
    case 'propellant':
      return `${L(e.unit)} 推進劑 ${e.amount} → ${e.total}`;
    case 'pilot':
      return `${L(e.unit)} ${{ blackout: '駕駛黑視', injured: '駕駛負傷', unconscious: '駕駛昏迷', sluggish: '動作遲鈍' }[e.state]}`;
    case 'status':
      return `${L(e.unit)} ${{ destroyed: '被擊毀', withdrawn: '脫離戰場', disabled: '停止動作' }[e.status]}`;
    case 'grapple':
      return `纏鬥 ${L(e.a)}「${GRAPPLE_NAMES[e.choiceA]}」 vs ${L(e.b)}「${GRAPPLE_NAMES[e.choiceB]}」：${e.summary}`;
    case 'swap':
      return `${L(e.unit)} ${e.hand === 'right' ? '右手' : '左手'}換成 ${equipName(unitView(e.unit), e.equip)}`;
    case 'lock':
      return `${L(e.unit)} 鎖定 ${L(e.target)}`;
    case 'actionFail':
      return `${L(e.unit)} 動作落空：${e.reason}`;
    case 'fuelFire':
      return `${L(e.unit)} 燃料槽引燃！`;
    case 'gameOver':
      return e.winner === 'draw' ? '對戰結束：平手' : `對戰結束：${e.winner === 0 ? 'A' : 'B'} 方勝利`;
    default:
      return null;
  }
}

function eventOwner(e: GameEvent): number | null {
  const id = 'unit' in e ? e.unit : 'attacker' in e ? e.attacker : null;
  return id ? (unitView(id)?.owner ?? null) : null;
}

function appendLog(events: GameEvent[]) {
  for (const e of events) {
    const text = describe(e);
    if (!text) continue;
    const owner = eventOwner(e);
    logs[seat].push({ text, cls: e.type === 'turnStart' || e.type === 'gameOver' ? 'turn' : owner === null ? '' : owner === seat ? 'mine' : 'theirs' });
  }
  renderLog();
}

function renderLog() {
  const el = $('log');
  el.innerHTML = logs[seat].map((l) => `<div class="${l.cls}">${esc(l.text)}</div>`).join('');
  el.scrollTop = el.scrollHeight;
}

$('resetBtn').onclick = () => {
  if (confirm(local ? '重新開始一場對戰？' : '重開這個房間？雙方的對戰都會重設。')) {
    logs[0].length = 0;
    logs[1].length = 0;
    $('log').innerHTML = '';
    draftKey = '';
    sendMsg({ t: 'reset' });
  }
};

// 玩法說明：第一次開啟時自動顯示
const HELP_KEY = 'mech-wing-help-seen';
function setHelp(open: boolean) {
  $('help').hidden = !open;
  if (!open) {
    try {
      localStorage.setItem(HELP_KEY, '1');
    } catch {}
  }
}
$('helpBtn').onclick = () => setHelp(true);
$('helpClose').onclick = () => setHelp(false);
try {
  if (!localStorage.getItem(HELP_KEY)) setHelp(true);
} catch {
  setHelp(true);
}

if (mode === 'local') {
  local = new LocalGame(onMessage);
  switchSeat(0);
} else {
  connect();
}
requestAnimationFrame(drawFrame);
