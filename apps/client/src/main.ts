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
  worldPose,
  type EquipState,
  type GameEvent,
  type GrappleChoice,
  type Hand,
  type ActionPlan,
  type ClientMessage,
  type ManeuverSpec,
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
import { SHOT_FLIGHT, SHOT_GAP, SHOT_DELAY, buildBeats, moveProgress, shotLandTime, type Beat } from './show';

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
  stopShow();
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
/** 演出中各機體在地圖上的位置與狀態（一拍結束才定格） */
interface Disp {
  x: number;
  y: number;
  f: number;
  status: UnitView['status'];
}
interface Show {
  beats: Beat[];
  index: number;
  beatStart: number;
  prevUnits: UnitView[];
  display: Map<string, Disp>;
  timer: number;
}
let show: Show | null = null;
/** 滑鼠停在機動按鈕上時預覽的軌跡 */
let hoverManeuver: { unit: string; maneuver: string } | null = null;
const logs: [{ text: string; cls: string }[], { text: string; cls: string }[]] = [[], []];

function onMessage(msg: ServerMessage) {
  if (msg.t === 'state') {
    connected = msg.connected;
    deadline = msg.deadline;
    if (show) pendingView = msg.view;
    else applyView(msg.view);
  } else if (msg.t === 'resolved') {
    errors = [];
    startShow(msg.events);
  } else if (msg.t === 'error') {
    errors = msg.errors;
    renderPanel();
  }
}

// ---------- 結算演出：一拍一拍播放 ----------

function startShow(events: GameEvent[]) {
  stopShow();
  const prevUnits = view?.state.units ?? [];
  const display = new Map(prevUnits.map((u) => [u.id, { x: u.pos.x, y: u.pos.y, f: u.facing, status: u.status }]));
  show = { beats: buildBeats(events), index: -1, beatStart: 0, prevUnits, display, timer: 0 };
  renderPanel();
  nextBeat();
}

function nextBeat() {
  const s = show;
  if (!s) return;
  if (s.index >= 0) settleBeat(s, s.beats[s.index]);
  s.index++;
  if (s.index >= s.beats.length) return finishShow();
  const beat = s.beats[s.index];
  appendLog(beat.events);
  s.beatStart = performance.now();
  // 用計時器推進：分頁在背景時 requestAnimationFrame 不會跑，不能靠它
  s.timer = window.setTimeout(nextBeat, beat.duration);
}

/** 一拍結束：把位置與狀態定格 */
function settleBeat(s: Show, b: Beat) {
  for (const e of b.events) {
    const d = 'unit' in e ? s.display.get(e.unit) : undefined;
    if (!d) continue;
    if (e.type === 'move') [d.x, d.y, d.f] = e.samples[e.samples.length - 1];
    else if (e.type === 'reposition' || e.type === 'knockback') Object.assign(d, e.to);
    else if (e.type === 'status') d.status = e.status;
  }
}

function stopShow() {
  if (show) clearTimeout(show.timer);
  show = null;
}

function finishShow() {
  stopShow();
  if (pendingView) applyView(pendingView);
  pendingView = null;
  renderPanel();
}

function skipShow() {
  if (!show) return;
  for (let i = show.index + 1; i < show.beats.length; i++) appendLog(show.beats[i].events);
  finishShow();
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
const labelOf = (id: string) => unitView(id)?.label ?? show?.prevUnits.find((u) => u.id === id)?.label ?? id;
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
  if (!show) {
    drawRanges();
    drawPreviews();
    for (const u of view.state.units) drawUnit(u, u.pos, u.facing);
    return;
  }
  const beat = show.beats[show.index];
  const elapsed = Math.max(0, now - show.beatStart);
  const over = new Map<string, Disp>();
  if (beat?.kind === 'move') {
    const mp = moveProgress(beat, elapsed);
    for (const e of beat.events) {
      if (e.type !== 'move') continue;
      const p = sampleAt(e.samples, mp.t);
      if (p) over.set(e.unit, { ...show.display.get(e.unit)!, x: p.x, y: p.y, f: p.f });
      g.strokeStyle = 'rgba(255,255,255,0.10)';
      g.beginPath();
      e.samples.forEach(([x, y], i) => (i ? g.lineTo(x * S, y * S) : g.moveTo(x * S, y * S)));
      g.stroke();
    }
    drawShowUnits(over);
    if (mp.pause !== null) drawContact(beat, mp.pause, mp.pauseP, over);
    else drawBanner('同時移動中…');
    return;
  }
  if (beat?.kind === 'grapple') {
    const k = Math.min(1, elapsed / 700);
    for (const e of beat.events) {
      if (e.type !== 'reposition') continue;
      const d = show.display.get(e.unit)!;
      over.set(e.unit, { ...d, x: d.x + (e.to.x - d.x) * k, y: d.y + (e.to.y - d.y) * k });
    }
  }
  drawShowUnits(over);
  if (beat) drawBeatEffect(beat, elapsed, over);
}

const posOf = (id: string, over: Map<string, Disp>): Disp | undefined => over.get(id) ?? show?.display.get(id);

function drawShowUnits(over: Map<string, Disp>) {
  for (const u of show!.prevUnits) {
    const d = posOf(u.id, over)!;
    drawUnit({ ...u, status: d.status }, d, d.f);
  }
}

function drawBanner(text: string) {
  g.font = 'bold 15px sans-serif';
  const w = Math.min(canvas.width - 20, g.measureText(text).width + 28);
  g.fillStyle = 'rgba(10,14,18,0.85)';
  g.fillRect((canvas.width - w) / 2, 10, w, 30);
  g.fillStyle = '#ffe9a8';
  g.textAlign = 'center';
  g.fillText(text, canvas.width / 2, 31, w - 16);
}

/** 浮在機體上方的文字（傷害數字等），p 為 0..1 的進度 */
function drawFloat(at: Vec, text: string, colour: string, p: number, line = 0) {
  if (p < 0 || p > 1) return;
  g.globalAlpha = p < 0.8 ? 1 : (1 - p) / 0.2;
  g.font = 'bold 14px sans-serif';
  g.textAlign = 'center';
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  const y = at.y * S - 22 - p * 18 - line * 16;
  g.strokeText(text, at.x * S, y);
  g.fillStyle = colour;
  g.fillText(text, at.x * S, y);
  g.globalAlpha = 1;
  g.lineWidth = 1;
}

function damageText(e: Extract<GameEvent, { type: 'damage' }>): [string, string] {
  const part = partName(e.unit, e.part);
  if (!e.amount) return [`${part} 失效`, '#ff8080'];
  return [`-${e.amount} ${part}${e.destroyed ? ' 破壞！' : ''}`, e.destroyed ? '#ff5d5d' : '#ffb347'];
}

function drawDamageFloats(events: GameEvent[], from: number, elapsed: number, over: Map<string, Disp>) {
  const lines = new Map<string, number>();
  events.forEach((e) => {
    if (e.type !== 'damage' && e.type !== 'status') return;
    const at = posOf(e.unit, over);
    if (!at) return;
    const line = lines.get(e.unit) ?? 0;
    lines.set(e.unit, line + 1);
    const p = (elapsed - from - line * 120) / 1000;
    if (e.type === 'damage') {
      const [text, colour] = damageText(e);
      drawFloat(at, text, colour, p, line);
    } else {
      drawFloat(at, { destroyed: '擊毀！', withdrawn: '脫離戰場', disabled: '停止動作' }[e.status], '#ff5d5d', p, line);
    }
  });
}

/** 移動中停在某次接觸：斬擊、撞擊、纏鬥、擦撞的效果 */
function drawContact(beat: Beat, pause: number, p: number, over: Map<string, Disp>) {
  // 這次接觸之後、下一次接觸之前的事件都屬於它
  const related: GameEvent[] = [];
  let current = -1;
  for (const e of beat.events) {
    if (e.type === 'contact') current = e.t;
    else if (current === pause) related.push(e);
  }
  const contacts = beat.events.filter((e): e is Extract<GameEvent, { type: 'contact' }> => e.type === 'contact' && e.t === pause && e.result !== 'none');
  const elapsed = p * 900;
  for (const c of contacts) {
    const a = posOf(c.a, over)!;
    const b = posOf(c.b, over)!;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (c.result === 'hitrun') {
      for (const st of related) if (st.type === 'strike') drawSlash(posOf(st.defender, over)!, posOf(st.attacker, over)!, p, st.outcome);
    } else {
      const colour = { ram: '255,138,61', clinch: '190,150,255', bump: '200,200,200', hitrun: '', none: '' }[c.result];
      const r = (0.4 + p * (c.result === 'ram' ? 1.4 : 0.8)) * S;
      g.strokeStyle = `rgba(${colour},${1 - p})`;
      g.lineWidth = c.result === 'ram' ? 5 : 3;
      g.beginPath();
      g.arc(mid.x * S, mid.y * S, r, 0, Math.PI * 2);
      g.stroke();
      g.lineWidth = 1;
    }
    const title = { ram: '撞擊！', clinch: '纏鬥！', bump: '擦撞', hitrun: '一擊脫離！', none: '' }[c.result];
    drawBanner(`${labelOf(c.a)} × ${labelOf(c.b)}（相對速度 ${c.vc}）：${title}`);
  }
  drawDamageFloats(related, 250, elapsed, over);
}

function drawSlash(def: Vec, att: Vec, p: number, outcome: 'hit' | 'parried' | 'blocked') {
  const base = Math.atan2(att.y - def.y, att.x - def.x);
  const sweep = Math.min(1, p * 2.5);
  g.strokeStyle = `rgba(255,255,255,${p < 0.6 ? 1 : (1 - p) / 0.4})`;
  g.lineWidth = 4;
  g.beginPath();
  g.arc(def.x * S, def.y * S, 0.9 * S, base - 1.3, base - 1.3 + 2.6 * sweep);
  g.stroke();
  g.lineWidth = 1;
  if (outcome !== 'hit' && p > 0.3) {
    g.fillStyle = `rgba(150,220,255,${1 - p})`;
    g.beginPath();
    g.arc(((def.x + att.x) / 2) * S, ((def.y + att.y) / 2) * S, 8 + p * 10, 0, Math.PI * 2);
    g.fill();
  }
  drawFloat(def, { hit: '斬！', parried: '架開', blocked: '盾擋' }[outcome], outcome === 'hit' ? '#ffffff' : '#9fe0ff', p * 0.9, 2);
}

const WEAPON_STYLE: Record<string, { colour: string; size: number; beam: boolean }> = {
  beam_rifle: { colour: '#7fe9ff', size: 3, beam: true },
  sniper: { colour: '#ffffff', size: 2, beam: true },
  machine_gun: { colour: '#ffd34a', size: 2.5, beam: false },
  bazooka: { colour: '#ff8a3d', size: 6, beam: false },
};

function drawBeatEffect(beat: Beat, elapsed: number, over: Map<string, Disp>) {
  const head = beat.events[0];
  const text = describe(head);
  if (text && beat.kind !== 'note') drawBanner(text);
  if (head.type === 'shot') {
    const a = posOf(head.attacker, over)!;
    const t = posOf(head.target, over)!;
    const style = WEAPON_STYLE[head.weapon] ?? WEAPON_STYLE.beam_rifle;
    const dx = t.x - a.x;
    const dy = t.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    for (let i = 0; i < head.shots; i++) {
      const local = (elapsed - SHOT_DELAY - i * SHOT_GAP) / SHOT_FLIGHT;
      if (local < 0) continue;
      const outcome = i < head.blocked ? 'block' : i < head.hits ? 'hit' : 'miss';
      const side = i % 2 ? 1 : -1;
      const end =
        outcome === 'hit' ? t : outcome === 'block' ? { x: t.x - ux * 0.5, y: t.y - uy * 0.5 } : { x: t.x + ux * 1.6 - uy * 0.8 * side, y: t.y + uy * 1.6 + ux * 0.8 * side };
      if (local < 1) {
        const px = a.x + (end.x - a.x) * local;
        const py = a.y + (end.y - a.y) * local;
        g.strokeStyle = style.colour;
        g.fillStyle = style.colour;
        if (style.beam) {
          const back = Math.max(0, local - 0.25);
          g.lineWidth = style.size;
          g.beginPath();
          g.moveTo((a.x + (end.x - a.x) * back) * S, (a.y + (end.y - a.y) * back) * S);
          g.lineTo(px * S, py * S);
          g.stroke();
          g.lineWidth = 1;
        } else {
          g.beginPath();
          g.arc(px * S, py * S, style.size, 0, Math.PI * 2);
          g.fill();
        }
      } else if (outcome !== 'miss' && local < 2) {
        const k = local - 1;
        g.fillStyle = outcome === 'hit' ? `rgba(255,170,60,${1 - k})` : `rgba(240,240,160,${1 - k})`;
        g.beginPath();
        g.arc(end.x * S, end.y * S, 6 + k * 16, 0, Math.PI * 2);
        g.fill();
        if (outcome === 'block') drawFloat(t, '盾擋', '#f0f0a0', k, 2);
      } else if (outcome === 'miss' && local < 1.6) {
        drawFloat(end, 'MISS', '#bbbbbb', (local - 1) / 0.6, 0);
      }
    }
    if (elapsed < SHOT_DELAY + 150) {
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.beginPath();
      g.arc((a.x + ux * 0.6) * S, (a.y + uy * 0.6) * S, 5, 0, Math.PI * 2);
      g.fill();
    }
    drawDamageFloats(beat.events.slice(1), shotLandTime(head.shots - 1), elapsed, over);
  } else if (head.type === 'lock') {
    const a = posOf(head.unit, over)!;
    const t = posOf(head.target, over)!;
    const k = Math.min(1, elapsed / 500);
    g.strokeStyle = 'rgba(120,220,255,0.8)';
    g.setLineDash([6, 4]);
    g.beginPath();
    g.moveTo(a.x * S, a.y * S);
    g.lineTo((a.x + (t.x - a.x) * k) * S, (a.y + (t.y - a.y) * k) * S);
    g.stroke();
    g.setLineDash([]);
    if (k >= 1) {
      const r = (1.2 - Math.min(1, (elapsed - 500) / 300) * 0.4) * S;
      g.beginPath();
      g.arc(t.x * S, t.y * S, r, 0, Math.PI * 2);
      g.moveTo(t.x * S - r - 4, t.y * S);
      g.lineTo(t.x * S + r + 4, t.y * S);
      g.moveTo(t.x * S, t.y * S - r - 4);
      g.lineTo(t.x * S, t.y * S + r + 4);
      g.stroke();
    }
  } else if (head.type === 'swap') {
    drawFloat(posOf(head.unit, over)!, `換上${equipName(unitView(head.unit), head.equip)}`, '#c8f7c5', elapsed / 800);
  } else if (head.type === 'actionFail') {
    drawFloat(posOf(head.unit, over)!, '落空', '#bbbbbb', elapsed / 800);
  } else if (head.type === 'grapple') {
    const a = posOf(head.a, over)!;
    const b = posOf(head.b, over)!;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const k = Math.min(1, elapsed / 1700);
    g.strokeStyle = `rgba(255,230,120,${1 - k})`;
    g.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2 + k * 2;
      g.beginPath();
      g.moveTo((mid.x + Math.cos(ang) * 0.2) * S, (mid.y + Math.sin(ang) * 0.2) * S);
      g.lineTo((mid.x + Math.cos(ang) * (0.5 + k)) * S, (mid.y + Math.sin(ang) * (0.5 + k)) * S);
      g.stroke();
    }
    g.lineWidth = 1;
    drawFloat(a, GRAPPLE_NAMES[head.choiceA], '#ffe9a8', k, 2);
    drawFloat(b, GRAPPLE_NAMES[head.choiceB], '#ffe9a8', k, 2);
    drawDamageFloats(beat.events.slice(1), 700, elapsed, over);
  } else {
    const end = beat.events.find((e) => e.type === 'gameOver');
    if (end) drawBanner(describe(end) ?? '');
    drawDamageFloats(beat.events, 0, elapsed, over);
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

function drawPath(u: UnitView, plan: Pick<MovePlan, 'maneuver' | 'limiter' | 'facingOffset'>, style: string, ghost: boolean) {
  const path = buildPath(u, plan);
  const pts = samplePath(path);
  g.strokeStyle = style;
  g.setLineDash([5, 4]);
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p.x * S, p.y * S) : g.moveTo(p.x * S, p.y * S)));
  g.stroke();
  g.setLineDash([]);
  const end = worldPose(path, 1);
  const facing = end.facing + (path.length === 0 ? (plan.facingOffset * Math.PI) / 180 : 0);
  const r = config.BASE_RADIUS * S;
  g.beginPath();
  g.arc(end.pos.x * S, end.pos.y * S, r, 0, Math.PI * 2);
  if (ghost) {
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fill();
  }
  g.stroke();
  if (ghost) {
    g.beginPath();
    g.moveTo(end.pos.x * S, end.pos.y * S);
    g.lineTo(end.pos.x * S + Math.cos(facing) * r * 1.4, end.pos.y * S + Math.sin(facing) * r * 1.4);
    g.stroke();
  }
}

function drawPreviews() {
  if (view?.phase === 'move') {
    for (const [id, plan] of Object.entries(moveDrafts)) {
      const u = unitView(id);
      if (!u || inGrapple(id)) continue;
      if (hoverManeuver?.unit === id) drawPath(u, { ...plan, maneuver: hoverManeuver.maneuver, facingOffset: 0 }, 'rgba(255,255,255,0.95)', true);
      else drawPath(u, plan, color(u.owner, id === selected ? 0.9 : 0.45), id === selected);
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
  const total = Object.values(u.parts).reduce((t, p) => t + p.durability, 0);
  const left = Object.values(u.parts).reduce((t, p) => t + p.durability - p.damage, 0);
  const broken = Object.values(u.parts).filter((p) => p.destroyed).map((p) => p.name);
  const summary = `部位耐久 ${left}/${total}${broken.length ? `　<span class="err">已破壞：${broken.map(esc).join('、')}</span>` : ''}`;
  return `<details id="partsBox" ${partsOpen ? 'open' : ''}><summary>${summary}</summary><div class="parts">${rows.join('')}</div></details>`;
}

let partsOpen = false;

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
  if (show) {
    sub.innerHTML = '<hr><div class="row"><span class="muted">結算演出中…</span><button id="skipBtn">跳過演出</button></div>';
    $('skipBtn').onclick = skipShow;
    return;
  }
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

const DIAL_COLUMNS = ['turn-L', 'bank-L', 'straight-S', 'bank-R', 'turn-R'];
const GLYPH: Record<string, string> = { 'turn-L': '↰', 'bank-L': '↖', 'straight-S': '↑', 'bank-R': '↗', 'turn-R': '↱', 'arc-L': '⤺', 'arc-R': '⤻', 'kturn-S': '⥁', 'hover-S': '◎' };
const dialKey = (m: ManeuverSpec) => `${m.kind}-${m.dir === -1 ? 'L' : m.dir === 1 ? 'R' : 'S'}`;

/** 機動盤：每個機動一顆按鈕，滑鼠停上去會在地圖預覽 */
function dialHtml(u: UnitView, plan: MovePlan): string {
  const dial = CHASSIS[u.chassisId].dial.map(parseManeuver);
  const usable = new Set(availableManeuvers(u).map((m) => m.id));
  const button = (m: ManeuverSpec) => {
    const ok = usable.has(m.id);
    const cls = ['mv', m.id === plan.maneuver ? 'on' : '', m.stress > 0 ? 'hard' : '', m.propellant > 0 ? 'fuel' : ''].join(' ');
    const title = `${m.name}：推進劑 −${m.propellant}／壓力 +${m.stress}${ok ? '' : '（目前不能用：推進劑不足、部位損壞或黑視）'}`;
    return `<button class="${cls}" data-m="${m.id}" title="${title}" ${ok ? '' : 'disabled'}>${GLYPH[dialKey(m)]}<small>${m.kind === 'hover' ? '' : m.speed}</small></button>`;
  };
  const basic = dial.filter((m) => DIAL_COLUMNS.includes(dialKey(m)));
  const speeds = [...new Set(basic.map((m) => m.speed))].sort((a, b) => b - a);
  let html = '<div class="dial">';
  for (const sp of speeds) {
    for (const col of DIAL_COLUMNS) {
      const m = basic.find((x) => x.speed === sp && dialKey(x) === col);
      html += m ? button(m) : '<span></span>';
    }
  }
  html += '</div><div class="dialExtra">';
  const order = ['arc-L', 'kturn-S', 'hover-S', 'arc-R'];
  for (const key of order) for (const m of dial.filter((x) => dialKey(x) === key)) html += button(m);
  html += '</div>';
  return html;
}

function moveControls(u: UnitView, plan: MovePlan): string {
  if (inGrapple(u.id)) {
    const opts = grappleOptions(u as unknown as UnitState);
    return `<div class="warn">纏鬥中：本回合不移動，改選纏鬥動作</div><div class="row"><label>纏鬥</label><select data-f="grapple">${opts.map((o) => `<option value="${o}" ${plan.grapple === o ? 'selected' : ''}>${GRAPPLE_NAMES[o]}</option>`).join('')}</select></div>`;
  }
  const usable = availableManeuvers(u);
  if (!usable.some((m) => m.id === plan.maneuver) && usable[0]) plan.maneuver = usable[0].id;
  const m = parseManeuver(plan.maneuver);
  const cost = planCost(plan);
  let html = `<div class="row"><label>機動</label><span><b>${m.name}</b>　推進劑 −${cost.propellant}　壓力 +${cost.stress}</span></div>`;
  html += dialHtml(u, plan);
  html += '<div class="muted" style="font-size:12px">滑鼠停在按鈕上可預覽路徑。紅字：會增加壓力；黃底線：消耗推進劑。</div>';
  html += `<div class="row"><label>姿態</label>${(['normal', 'charge', 'evade'] as Stance[]).map((s) => `<label><input type="radio" name="stance" value="${s}" ${plan.stance === s ? 'checked' : ''}> ${{ normal: '一般', charge: '突進', evade: '迴避' }[s]}</label>`).join('')}</div>`;
  html += `<div class="muted" style="font-size:12px">${{ normal: '撞到別人只算碰撞。', charge: '撞到敵機時發動近戰（手上要有光劍或熱能斧才砍得到）。', evade: '比較不容易被撞到、被射中。' }[plan.stance]}</div>`;
  if (m.kind === 'hover') {
    html += `<div class="row"><label>轉身</label><select data-f="facingOffset">${config.FACING_OFFSETS.map((f) => `<option value="${f}" ${plan.facingOffset === f ? 'selected' : ''}>${f === 0 ? '不轉' : `${f > 0 ? '右' : '左'} ${Math.abs(f)}°`}</option>`).join('')}</select></div>`;
    html += '<div class="muted" style="font-size:12px">懸停時可以原地轉身，讓正面或盾牌對準敵人（迴避會 −10）。</div>';
  } else {
    html += `<div class="row"><label></label><label><input type="checkbox" data-f="limiter" ${plan.limiter ? 'checked' : ''}> 限制器解除（多走 1 格，壓力 +${config.LIMITER_STRESS}）</label></div>`;
  }
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
  const box = ed.querySelector<HTMLDetailsElement>('#partsBox');
  if (box) box.ontoggle = () => (partsOpen = box.open);
  ed.querySelectorAll<HTMLInputElement>('input[name=stance]').forEach((r) => (r.onchange = () => ((move.stance = r.value as Stance), rerender())));
  ed.querySelectorAll<HTMLButtonElement>('button[data-m]').forEach((b) => {
    b.onmouseenter = () => (hoverManeuver = { unit: u.id, maneuver: b.dataset.m! });
    b.onmouseleave = () => (hoverManeuver = null);
    b.onclick = () => {
      move.maneuver = b.dataset.m!;
      if (parseManeuver(move.maneuver).kind === 'hover') move.limiter = false;
      else move.facingOffset = 0;
      hoverManeuver = null;
      rerender();
    };
  });
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
  const u = unitView(unitId) ?? show?.prevUnits.find((x) => x.id === unitId);
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
