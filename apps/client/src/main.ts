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
import { Camera, attachCameraControls, type CameraView, type Projected } from './camera';
import { LocalGame, type Opponent } from './local';
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
    if (msg.t === 'reset' || next === seat) switchSeat(next);
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
  savedViews[seat] = cam.save();
  seat = next;
  view = null;
  draftKey = '';
  selected = null;
  stopShow();
  pendingView = null;
  errors = [];
  document.getElementById('confirm')!.hidden = true;
  const saved = savedViews[next];
  if (saved) cam.restore(saved);
  else resetCamera();
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
/** 這一步已經點過選項的機體（用來判斷「已下指令」） */
let touched = new Set<string>();
/** 滑鼠目前停在哪台機體上（行動步驟顯示命中率） */
let hoverUnit: string | null = null;
interface LogLine {
  text: string;
  cls: string;
  at: number;
}
const logs: [LogLine[], LogLine[]] = [[], []];
let logOpen = false;

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

/** 每次結算的演出都記下來，對戰結束後可以整場重播（各席位只記自己看得到的內容） */
interface ReplayItem {
  turn: number;
  phase: 'move' | 'action';
  events: GameEvent[];
  prevUnits: UnitView[];
}
const replays: [ReplayItem[], ReplayItem[]] = [[], []];
/** 重播中：還沒播的段落 */
let replayQueue: ReplayItem[] | null = null;
let replayNow: ReplayItem | null = null;

function startShow(events: GameEvent[], replayed?: ReplayItem) {
  stopShow();
  const prevUnits = replayed?.prevUnits ?? view?.state.units ?? [];
  if (!replayed && view && view.phase !== 'over') replays[seat].push({ turn: view.state.turn, phase: view.phase, events, prevUnits });
  replayNow = replayed ?? null;
  const display = new Map(prevUnits.map((u) => [u.id, { x: u.pos.x, y: u.pos.y, f: u.facing, status: u.status }]));
  show = { beats: buildBeats(events), index: -1, beatStart: 0, prevUnits, display, timer: 0 };
  renderPanel();
  nextBeat();
}

function startReplay() {
  replayQueue = [...replays[seat]];
  playNextReplay();
}

function playNextReplay() {
  const next = replayQueue?.shift();
  if (!next) return stopReplay();
  startShow(next.events, next);
}

function stopReplay() {
  replayQueue = null;
  replayNow = null;
  stopShow();
  renderAll();
}

function nextBeat() {
  const s = show;
  if (!s) return;
  if (s.index >= 0) settleBeat(s, s.beats[s.index]);
  s.index++;
  if (s.index >= s.beats.length) return finishShow();
  const beat = s.beats[s.index];
  if (!replayNow) appendLog(beat.events);
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
  if (replayQueue) {
    window.setTimeout(() => replayQueue && !show && playNextReplay(), 500);
    renderPanel();
    return;
  }
  if (pendingView) applyView(pendingView);
  pendingView = null;
  renderPanel();
  scheduleAuto();
}

function skipShow() {
  if (!show) return;
  if (!replayNow) for (let i = show.index + 1; i < show.beats.length; i++) appendLog(show.beats[i].events);
  finishShow();
}

// ---------- 電腦對戰電腦：自動推進 ----------

let autoTimer = 0;

function scheduleAuto() {
  if (!local || local.opponent !== 'aivai' || autoTimer) return;
  autoTimer = window.setTimeout(() => {
    autoTimer = 0;
    if (!local || local.opponent !== 'aivai' || show || replayQueue || !view || view.phase === 'over') return;
    local.autoStep();
    local.takeOver(seat);
  }, 700);
}

function applyView(v: PlayerView) {
  view = v;
  const key = `${v.state.turn}:${v.phase}`;
  if (key !== draftKey) {
    draftKey = key;
    touched = new Set();
    document.getElementById('confirm')!.hidden = true;
    moveDrafts = {};
    actionDrafts = {};
    for (const u of ownUnits()) {
      if (u.status !== 'active') continue;
      if (v.phase === 'move') moveDrafts[u.id] = initialMove(u);
      if (v.phase === 'action') actionDrafts[u.id] = { action: { type: 'none' } };
    }
  }
  if (!show) scheduleAuto();
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

// ---------- 畫面：地圖（透視相機） ----------

const canvas = document.getElementById('map') as HTMLCanvasElement;
const g = canvas.getContext('2d')!;
const cam = new Camera(config.MAP_SIZE);
/** 畫布的 CSS 像素尺寸 */
let W = 800;
let H = 600;
/** 機體浮在地面上的視覺高度（規則上不存在，只用來表現） */
const UNIT_Z = 0.8;
const color = (owner: number, alpha = 1) => (owner === 0 ? `rgba(74,163,255,${alpha})` : `rgba(255,93,93,${alpha})`);
/** 本機輪流時各席位各自記住視角 */
const savedViews: [CameraView | null, CameraView | null] = [null, null];
/** 各席位的預設視角：自己的陣地在畫面下方 */
const seatYaw = (s: PlayerId) => (s === 0 ? Math.PI : 0);

let sized = false;

function resizeCanvas() {
  const stage = document.getElementById('stage')!;
  const first = !sized;
  sized = true;
  W = Math.max(200, stage.clientWidth);
  H = Math.max(200, stage.clientHeight);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  cam.width = W;
  cam.height = H;
  if (first) resetCamera();
}

function resetCamera() {
  cam.reset();
  cam.yaw = seatYaw(seat);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

const pr = (x: number, y: number, z = 0) => cam.project(x, y, z);

/** 依世界座標畫折線（看不到的點會斷開） */
function polyWorld(points: [number, number, number][]) {
  g.beginPath();
  let open = false;
  for (const [x, y, z] of points) {
    const p = pr(x, y, z);
    if (!p.visible) {
      open = false;
      continue;
    }
    if (open) g.lineTo(p.x, p.y);
    else g.moveTo(p.x, p.y);
    open = true;
  }
}

/** 地面（或指定高度）上的圓或圓弧 */
function ringWorld(x: number, y: number, r: number, z = 0, a0 = 0, a1 = Math.PI * 2, n = 40) {
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r, z]);
  }
  polyWorld(pts);
}

/** 螢幕上的實心圓，半徑依距離縮放 */
function dotAt(p: Projected, px: number, fill: string) {
  if (!p.visible) return;
  g.fillStyle = fill;
  g.beginPath();
  g.arc(p.x, p.y, Math.max(1.5, px * Math.min(2, Math.max(0.5, p.k / 25))), 0, Math.PI * 2);
  g.fill();
}

/** 螢幕座標最接近的機體（看浮空標記和地面底板） */
function unitAt(sx: number, sy: number): UnitView | undefined {
  let best: UnitView | undefined;
  let bestD = Infinity;
  for (const u of view?.state.units ?? []) {
    const top = pr(u.pos.x, u.pos.y, UNIT_Z);
    const base = pr(u.pos.x, u.pos.y, 0);
    if (!top.visible) continue;
    const d = Math.min(Math.hypot(top.x - sx, top.y - sy), Math.hypot(base.x - sx, base.y - sy));
    if (d < Math.max(12, top.k * 0.55) && d < bestD) {
      best = u;
      bestD = d;
    }
  }
  return best;
}

/** 行動步驟：已選裝備的本方機體點敵機＝設定目標；其他情況點機體＝選取查看 */
attachCameraControls(canvas, cam, {
  onClick(sx, sy) {
    const hit = unitAt(sx, sy);
    if (!view || !hit || show) return;
    const sel = selected ? unitView(selected) : undefined;
    const plan = sel ? actionDrafts[sel.id] : undefined;
    if (view.phase === 'action' && sel?.owner === view.you && plan && plan.action.type !== 'none' && hit.owner !== view.you && hit.status === 'active' && !view.submitted[view.you]) {
      setTarget(sel.id, hit.id);
      return;
    }
    selected = hit.id;
    renderAll();
  },
  onHover(sx, sy) {
    const hit = unitAt(sx, sy);
    hoverUnit = hit?.id ?? null;
    canvas.style.cursor = hit ? 'pointer' : 'grab';
  },
  onLeave() {
    hoverUnit = null;
  },
});

function drawFrame(now: number) {
  requestAnimationFrame(drawFrame);
  g.clearRect(0, 0, W, H);
  drawGround();
  if (!view) return;
  if (!show) {
    drawRanges();
    drawPreviews();
    drawUnits(view.state.units.map((u) => ({ u, pos: u.pos, f: u.facing })));
    drawHoverHint();
    placeCard();
    drawCardLink();
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
      g.strokeStyle = 'rgba(255,255,255,0.14)';
      polyWorld(e.samples.map(([x, y]) => [x, y, 0]));
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
/** 效果用的位置：機體浮空標記的高度 */
const fx = (v: Vec) => pr(v.x, v.y, UNIT_Z);

function drawShowUnits(over: Map<string, Disp>) {
  drawUnits(
    show!.prevUnits.map((u) => {
      const d = posOf(u.id, over)!;
      return { u: { ...u, status: d.status }, pos: d, f: d.f };
    }),
  );
}

function drawBanner(text: string) {
  g.font = 'bold 15px sans-serif';
  const w = Math.min(W - 20, g.measureText(text).width + 28);
  g.fillStyle = 'rgba(10,14,18,0.85)';
  g.fillRect((W - w) / 2, 12, w, 30);
  g.fillStyle = '#ffe9a8';
  g.textAlign = 'center';
  g.fillText(text, W / 2, 33, w - 16);
}

/** 浮在機體上方的文字（傷害數字等），p 為 0..1 的進度 */
function drawFloat(at: Vec, text: string, colour: string, p: number, line = 0) {
  if (p < 0 || p > 1) return;
  const s = fx(at);
  if (!s.visible) return;
  g.globalAlpha = p < 0.8 ? 1 : (1 - p) / 0.2;
  g.font = 'bold 14px sans-serif';
  g.textAlign = 'center';
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  const y = s.y - 26 - p * 18 - line * 16;
  g.strokeText(text, s.x, y);
  g.fillStyle = colour;
  g.fillText(text, s.x, y);
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
  for (const c of contacts) {
    const a = posOf(c.a, over)!;
    const b = posOf(c.b, over)!;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (c.result === 'hitrun') {
      for (const cl of related) {
        if (cl.type !== 'clash') continue;
        const att = posOf(cl.attacker, over)!;
        const def = posOf(cl.defender, over)!;
        if (cl.winner === cl.attacker) drawSlash(def, att, p, 'hit');
        else if (cl.winner && cl.damage) drawSlash(att, def, p, 'counter');
        else drawSlash(def, att, p, cl.winner ? (cl.defense === 'shield' ? 'blocked' : 'dodged') : 'tie');
      }
    } else {
      const colour = { ram: '255,138,61', clinch: '190,150,255', bump: '200,200,200', hitrun: '', none: '' }[c.result];
      g.strokeStyle = `rgba(${colour},${1 - p})`;
      g.lineWidth = c.result === 'ram' ? 5 : 3;
      ringWorld(mid.x, mid.y, 0.4 + p * (c.result === 'ram' ? 1.4 : 0.8), UNIT_Z);
      g.stroke();
      g.lineWidth = 1;
    }
    const title = { ram: '撞擊！', clinch: '纏鬥！', bump: '擦撞', hitrun: '一擊脫離！', none: '' }[c.result];
    const clash = related.find((e): e is Extract<GameEvent, { type: 'clash' }> => e.type === 'clash');
    drawBanner(clash && p > 0.25 ? clashText(clash) : `${labelOf(c.a)} × ${labelOf(c.b)}（相對速度 ${c.vc}）：${title}`);
  }
  drawDamageFloats(related, 250, p * 900, over);
}

/** 斬擊弧線畫在被砍的一方身上；counter 時 def 其實是被反斬的攻擊方 */
function drawSlash(def: Vec, att: Vec, p: number, outcome: 'hit' | 'counter' | 'blocked' | 'dodged' | 'tie') {
  const base = Math.atan2(att.y - def.y, att.x - def.x);
  const sweep = Math.min(1, p * 2.5);
  g.strokeStyle = `rgba(255,255,255,${p < 0.6 ? 1 : (1 - p) / 0.4})`;
  g.lineWidth = 4;
  ringWorld(def.x, def.y, 0.9, UNIT_Z, base - 1.3, base - 1.3 + 2.6 * sweep, 20);
  g.stroke();
  g.lineWidth = 1;
  const struck = outcome === 'hit' || outcome === 'counter';
  if (!struck && p > 0.3) dotAt(fx({ x: (def.x + att.x) / 2, y: (def.y + att.y) / 2 }), 8 + p * 10, `rgba(150,220,255,${1 - p})`);
  drawFloat(def, { hit: '斬！', counter: '反斬！', blocked: '盾擋', dodged: '閃開', tie: '刀刃相抵' }[outcome], struck ? '#ffffff' : '#9fe0ff', p * 0.9, 2);
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
    const len = Math.hypot(t.x - a.x, t.y - a.y) || 1;
    const ux = (t.x - a.x) / len;
    const uy = (t.y - a.y) / len;
    for (let i = 0; i < head.shots; i++) {
      const local = (elapsed - SHOT_DELAY - i * SHOT_GAP) / SHOT_FLIGHT;
      if (local < 0) continue;
      const outcome = i < head.blocked ? 'block' : i < head.hits ? 'hit' : 'miss';
      const side = i % 2 ? 1 : -1;
      const end =
        outcome === 'hit' ? t : outcome === 'block' ? { x: t.x - ux * 0.5, y: t.y - uy * 0.5 } : { x: t.x + ux * 1.6 - uy * 0.8 * side, y: t.y + uy * 1.6 + ux * 0.8 * side };
      const at = (k: number) => ({ x: a.x + (end.x - a.x) * k, y: a.y + (end.y - a.y) * k });
      if (local < 1) {
        if (style.beam) {
          g.strokeStyle = style.colour;
          g.lineWidth = style.size;
          const b0 = at(Math.max(0, local - 0.25));
          const b1 = at(local);
          polyWorld([
            [b0.x, b0.y, UNIT_Z],
            [b1.x, b1.y, UNIT_Z],
          ]);
          g.stroke();
          g.lineWidth = 1;
        } else {
          dotAt(fx(at(local)), style.size, style.colour);
        }
      } else if (outcome !== 'miss' && local < 2) {
        const k = local - 1;
        dotAt(fx(end), 6 + k * 16, outcome === 'hit' ? `rgba(255,170,60,${1 - k})` : `rgba(240,240,160,${1 - k})`);
        if (outcome === 'block') drawFloat(t, '盾擋', '#f0f0a0', k, 2);
      } else if (outcome === 'miss' && local < 1.6) {
        drawFloat(end, 'MISS', '#bbbbbb', (local - 1) / 0.6, 0);
      }
    }
    if (elapsed < SHOT_DELAY + 150) dotAt(fx({ x: a.x + ux * 0.6, y: a.y + uy * 0.6 }), 5, 'rgba(255,255,255,0.8)');
    drawDamageFloats(beat.events.slice(1), shotLandTime(head.shots - 1), elapsed, over);
  } else if (head.type === 'lock') {
    const a = posOf(head.unit, over)!;
    const t = posOf(head.target, over)!;
    const k = Math.min(1, elapsed / 500);
    g.strokeStyle = 'rgba(120,220,255,0.8)';
    g.setLineDash([6, 4]);
    polyWorld([
      [a.x, a.y, UNIT_Z],
      [a.x + (t.x - a.x) * k, a.y + (t.y - a.y) * k, UNIT_Z],
    ]);
    g.stroke();
    g.setLineDash([]);
    if (k >= 1) {
      ringWorld(t.x, t.y, 1.2 - Math.min(1, (elapsed - 500) / 300) * 0.4, UNIT_Z);
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
      polyWorld([
        [mid.x + Math.cos(ang) * 0.2, mid.y + Math.sin(ang) * 0.2, UNIT_Z],
        [mid.x + Math.cos(ang) * (0.5 + k), mid.y + Math.sin(ang) * (0.5 + k), UNIT_Z],
      ]);
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

/** 地面：地圖範圍、格線、雙方陣地的顏色提示 */
function drawGround() {
  const M = config.MAP_SIZE;
  g.fillStyle = '#0d1319';
  polyWorld([
    [0, 0, 0],
    [M, 0, 0],
    [M, M, 0],
    [0, M, 0],
    [0, 0, 0],
  ]);
  g.fill();
  for (let i = 0; i <= M; i++) {
    g.strokeStyle = i % 6 === 0 ? '#22303d' : '#16202a';
    polyWorld([
      [i, 0, 0],
      [i, M, 0],
    ]);
    g.stroke();
    polyWorld([
      [0, i, 0],
      [M, i, 0],
    ]);
    g.stroke();
  }
  g.strokeStyle = '#3a4a5c';
  g.lineWidth = 2;
  polyWorld([
    [0, 0, 0],
    [M, 0, 0],
    [M, M, 0],
    [0, M, 0],
    [0, 0, 0],
  ]);
  g.stroke();
  g.lineWidth = 1;
}

/** 由遠到近畫，近的蓋在遠的上面 */
function drawUnits(list: { u: UnitView; pos: Vec; f: number }[]) {
  list
    .map((x) => ({ ...x, k: pr(x.pos.x, x.pos.y, 0).k }))
    .sort((a, b) => a.k - b.k)
    .forEach((x) => drawUnit(x.u, x.pos, x.f));
}

function drawUnit(u: UnitView, pos: Vec, facing: number) {
  const out = u.status !== 'active';
  const R = config.BASE_RADIUS;
  const top = pr(pos.x, pos.y, UNIT_Z);
  const base = pr(pos.x, pos.y, 0);
  if (!top.visible || !base.visible) return;
  // 地面底板與朝向
  g.fillStyle = out ? 'rgba(80,80,80,0.25)' : color(u.owner, 0.18);
  g.strokeStyle = out ? '#555' : color(u.owner, 0.7);
  ringWorld(pos.x, pos.y, R);
  g.fill();
  g.stroke();
  g.strokeStyle = out ? '#555' : 'rgba(255,255,255,0.75)';
  polyWorld([
    [pos.x, pos.y, 0],
    [pos.x + Math.cos(facing) * R * 1.5, pos.y + Math.sin(facing) * R * 1.5, 0],
  ]);
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
    ringWorld(pos.x, pos.y, R + 0.12, 0, c - half, c + half, 16);
    g.stroke();
    g.lineWidth = 1;
  }
  // 垂直線與浮空標記
  g.strokeStyle = out ? '#444' : color(u.owner, 0.5);
  g.beginPath();
  g.moveTo(base.x, base.y);
  g.lineTo(top.x, top.y);
  g.stroke();
  const r = Math.max(5, top.k * 0.3);
  g.fillStyle = out ? '#3a3f45' : color(u.owner, 0.95);
  g.beginPath();
  g.arc(top.x, top.y, r, 0, Math.PI * 2);
  g.fill();
  if (u.id === selected) {
    g.strokeStyle = '#ffcf4a';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(top.x, top.y, r + 3, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 1;
  }
  const nose = pr(pos.x + Math.cos(facing) * 0.6, pos.y + Math.sin(facing) * 0.6, UNIT_Z);
  g.strokeStyle = '#fff';
  g.beginPath();
  g.moveTo(top.x, top.y);
  g.lineTo(nose.x, nose.y);
  g.stroke();
  g.fillStyle = out ? '#777' : '#fff';
  g.font = '11px sans-serif';
  g.textAlign = 'center';
  g.fillText(u.label.split(' ')[0] + (u.vague === 'sluggish' ? ' ⚠' : ''), top.x, top.y - r - 5);
}

function drawRanges() {
  const u = selected ? unitView(selected) : null;
  if (!u || u.status !== 'active') return;
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  for (const lim of [config.RANGE_LIMITS.r1, config.RANGE_LIMITS.r2, config.RANGE_LIMITS.r3]) {
    ringWorld(u.pos.x, u.pos.y, lim + 2 * config.BASE_RADIUS, 0, 0, Math.PI * 2, 64);
    g.stroke();
  }
}

function drawPath(u: UnitView, plan: Pick<MovePlan, 'maneuver' | 'limiter' | 'facingOffset'>, style: string, ghost: boolean) {
  const path = buildPath(u, plan);
  g.strokeStyle = style;
  g.setLineDash([5, 4]);
  polyWorld(samplePath(path).map((p) => [p.x, p.y, 0]));
  g.stroke();
  g.setLineDash([]);
  const end = worldPose(path, 1);
  const facing = end.facing + (path.length === 0 ? (plan.facingOffset * Math.PI) / 180 : 0);
  const R = config.BASE_RADIUS;
  ringWorld(end.pos.x, end.pos.y, R);
  if (ghost) {
    g.fillStyle = 'rgba(255,255,255,0.15)';
    g.fill();
  }
  g.stroke();
  if (ghost) {
    polyWorld([
      [end.pos.x, end.pos.y, 0],
      [end.pos.x + Math.cos(facing) * R * 1.5, end.pos.y + Math.sin(facing) * R * 1.5, 0],
    ]);
    g.stroke();
    // 終點的浮空殘影
    const top = pr(end.pos.x, end.pos.y, UNIT_Z);
    const base = pr(end.pos.x, end.pos.y, 0);
    g.beginPath();
    g.moveTo(base.x, base.y);
    g.lineTo(top.x, top.y);
    g.stroke();
    dotAt(top, 6, 'rgba(255,255,255,0.35)');
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
      const t = plan.action.type !== 'none' && plan.action.target ? unitView(plan.action.target) : null;
      if (!a || !t) continue;
      g.strokeStyle = plan.action.type === 'shoot' ? 'rgba(255,207,74,0.8)' : 'rgba(120,220,255,0.7)';
      g.setLineDash([6, 4]);
      polyWorld([
        [a.pos.x, a.pos.y, UNIT_Z],
        [t.pos.x, t.pos.y, UNIT_Z],
      ]);
      g.stroke();
      g.setLineDash([]);
    }
  }
}

/** 行動步驟：滑鼠停在敵機上時顯示所選機體對它的估計命中率 */
function drawHoverHint() {
  if (view?.phase !== 'action') return;
  const sel = selected ? unitView(selected) : undefined;
  const hov = hoverUnit ? unitView(hoverUnit) : undefined;
  const plan = sel ? actionDrafts[sel.id] : undefined;
  if (!sel || !hov || !plan || plan.action.type === 'none' || hov.owner === view.you || hov.status !== 'active') return;
  const text = plan.action.type === 'shoot' ? `點擊設為目標・${estimate(sel, plan, hov)}` : '點擊鎖定';
  const p = fx(hov.pos);
  g.strokeStyle = 'rgba(255,207,74,0.9)';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(p.x, p.y, Math.max(5, p.k * 0.3) + 7, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 3;
  g.font = 'bold 13px sans-serif';
  g.textAlign = 'left';
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(text, p.x + 18, p.y + 4);
  g.fillStyle = '#ffe9a8';
  g.fillText(text, p.x + 18, p.y + 4);
  g.lineWidth = 1;
}

// 視角按鈕
document.querySelectorAll<HTMLButtonElement>('#viewCtl button[data-view]').forEach((b) => {
  b.onclick = () => {
    const v = b.dataset.view;
    if (v === 'left') cam.rotate(-Math.PI / 4);
    else if (v === 'right') cam.rotate(Math.PI / 4);
    else if (v === 'top') cam.toggleTopDown();
    else resetCamera();
  };
});

// ---------- 畫面：面板 ----------

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function renderAll() {
  renderStatus();
  renderUnitList();
  renderPanel();
}

function renderStatus() {
  const other = seat === 0 ? 1 : 0;
  $('seatLinks').innerHTML = local
    ? local.opponent === 'aivai'
      ? '觀戰中（從 A 方視角）'
      : local.opponent === 'ai'
        ? `你是 <b style="color:${color(seat)}">A 方</b>，B 方由電腦操作`
        : `同機輪流　現在是 <b style="color:${color(seat)}">${SIDE(seat)} 方</b>`
    : `房間 <b>${esc(room)}</b>　你是 <b style="color:${color(seat)}">${SIDE(seat)} 方</b> <a href="?room=${encodeURIComponent(room)}&seat=${other}" target="_blank">開啟${SIDE(other)} 方視窗</a>`;
  if (!view) {
    $('status').textContent = '連線中…';
    return;
  }
  const phase = { move: '步驟 1／2：移動', action: '步驟 2／2：行動', over: '對戰結束' }[view.phase];
  const opp = connected[seat === 0 ? 1 : 0] ? '' : '（對手未連線）';
  const timer = deadline ? `　剩 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))} 秒` : '';
  $('status').textContent = `第 ${view.state.turn} 回合 · ${phase}${opp}${timer}`;
}
setInterval(() => deadline && renderStatus(), 1000);

const PHASE_HINT = {
  move: '替每台機體選機動和姿態，全部選好後按「送出指令」',
  action: '移動已結算：選一件裝備，再點地圖上的敵機當目標',
  over: '',
};

/** 這一步需要下指令的機體（擦撞的機體行動步驟不用） */
const needsOrder = (u: UnitView) => u.status === 'active' && !(view!.phase === 'action' && view!.state.bumped.includes(u.id));

/** 已經點過選項；射擊和鎖定還要選好目標才算完成 */
function orderDone(u: UnitView): boolean {
  if (!touched.has(u.id)) return false;
  if (view!.phase !== 'action') return true;
  const a = actionDrafts[u.id]?.action;
  return !a || a.type === 'none' || !!a.target;
}

function unitStatusText(u: UnitView): [string, boolean] {
  if (u.status !== 'active') return [{ destroyed: '已擊毀', withdrawn: '已脫離戰場', unconscious: '駕駛昏迷', disabled: '停止動作' }[u.status], false];
  if (!view || view.phase === 'over' || show) return ['', false];
  if (view.submitted[view.you]) return ['已送出', true];
  if (!needsOrder(u)) return ['擦撞，本回合不能行動', false];
  return orderDone(u) ? ['✓ 已下指令', true] : ['未下指令', false];
}

/** 左側：只列本方機體 */
function renderUnitList() {
  const el = $('unitList');
  if (!view) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = ownUnits()
    .map((u) => {
      const stress = Math.min(1, (u.stress ?? 0) / Math.max(1, u.maxStress ?? 1));
      const prop = (u.propellant ?? 0) / Math.max(1, u.maxPropellant ?? 1);
      const [st, done] = unitStatusText(u);
      const cls = ['ucard', u.id === selected ? 'sel' : '', u.status !== 'active' ? 'out' : ''].join(' ');
      return `<div class="${cls}" data-unit="${u.id}"><b>${esc(u.label)}</b>
        <div class="meter" title="壓力 ${u.stress}/${u.maxStress}"><i style="width:${stress * 100}%;background:#e24b4a"></i></div>
        <div class="meter" title="推進劑 ${u.propellant}/${u.maxPropellant}"><i style="width:${prop * 100}%;background:#ef9f27"></i></div>
        <div class="st ${done ? 'done' : ''}">${st}</div></div>`;
    })
    .join('');
  el.querySelectorAll<HTMLElement>('[data-unit]').forEach((c) => {
    c.onclick = () => {
      selected = c.dataset.unit!;
      renderAll();
    };
  });
}

function renderPanel() {
  if (!view) {
    $('infoCard').hidden = true;
    $('cmdCard').hidden = true;
    $('submitCol').innerHTML = '';
    return;
  }
  $('phaseHint').textContent = replayNow
    ? `重播中：第 ${replayNow.turn} 回合・${replayNow.phase === 'move' ? '移動' : '行動'}（剩 ${replayQueue?.length ?? 0} 段）`
    : local?.opponent === 'aivai' && view.phase !== 'over'
      ? '觀戰中：雙方都由電腦操作，會自動進行到分出勝負'
      : show || view.submitted[view.you]
        ? ''
        : PHASE_HINT[view.phase];
  const u = selected ? unitView(selected) : undefined;
  $('info').innerHTML = u ? infoHtml(u) : '';
  $('infoCard').hidden = !u;
  const ctrl = controlsHtml(u);
  $('controls').innerHTML = ctrl;
  $('cmdCard').hidden = !ctrl;
  if (ctrl && u) {
    $('cmdTitle').textContent = `${u.label.split(' ')[0]}・${view.phase === 'move' ? (inGrapple(u.id) ? '纏鬥' : '移動') : '行動'}`;
    $('cmdPin').textContent = cardPinned ? '已固定・雙擊還原' : '';
    defaultTip = defaultTipFor(u);
    $('tipBox').textContent = defaultTip;
  }
  bindControls(u);
  bindTips();
  renderSubmit();
  renderUnitList();
  placeCard();
}

// ---- 指令卡：說明區、自動擺放與拖曳 ----

let defaultTip = '';
/** 拖曳過的卡片會固定在那個位置，雙擊標題列恢復自動擺放 */
let cardPinned: { x: number; y: number } | null = null;
let cardSide = -1;
let cardRect: { x: number; y: number; w: number; h: number } | null = null;

function defaultTipFor(u: UnitView): string {
  if (view!.phase === 'move') {
    if (inGrapple(u.id)) return '纏鬥中：本回合不移動。滑鼠停在選項上看說明。';
    const m = parseManeuver(moveDrafts[u.id].maneuver);
    const c = planCost(moveDrafts[u.id]);
    return `已選 ${m.name}：推進劑 −${c.propellant}、壓力 +${c.stress}。滑鼠停在按鈕上可預覽路徑與看說明；紅字會加壓力，黃底線會耗推進劑。`;
  }
  const plan = actionDrafts[u.id];
  const a = plan?.action;
  if (!a || a.type === 'none') return plan?.swap ? '拔出武器。' : '選一件裝備，再點地圖上的敵機當目標。';
  if (!a.target) return '點地圖上的敵機當目標（滑鼠移上去會顯示估計命中率）。';
  const t = unitView(a.target);
  return a.type === 'lock' ? `鎖定 ${labelOf(a.target)}，下次對它射擊命中率 +${config.LOCK_BONUS}%。` : `射擊 ${labelOf(a.target)}${t ? `：${estimate(u, plan, t)}` : ''}。命中率是估計值，看不到對手的駕駛與姿態。`;
}

function bindTips() {
  const box = $('tipBox');
  $('cmdCard')
    .querySelectorAll<HTMLElement>('[data-tip]')
    .forEach((el) => {
      el.addEventListener('mouseenter', () => (box.textContent = el.dataset.tip!));
      el.addEventListener('mouseleave', () => (box.textContent = defaultTip));
    });
}

const relRect = (el: HTMLElement, stage: DOMRect) => {
  const r = el.getBoundingClientRect();
  return { x: r.left - stage.left, y: r.top - stage.top, w: r.width, h: r.height };
};
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** 在機體的右、左、上、下挑一個最不擋到其他機體與浮層、也不超出畫面的位置 */
function placeCard() {
  layoutFloaters();
  const card = $('cmdCard');
  if (card.hidden) {
    cardRect = null;
    return;
  }
  const u = selected ? unitView(selected) : undefined;
  if (!u) return;
  const stage = $('stage').getBoundingClientRect();
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const clamp = (x: number, y: number) => ({ x: Math.max(4, Math.min(W - w - 4, x)), y: Math.max(4, Math.min(H - h - 4, y)) });
  let pos: { x: number; y: number };
  if (cardPinned) {
    pos = clamp(cardPinned.x, cardPinned.y);
  } else {
    const p = fx(u.pos);
    const gap = 34;
    const cands = [
      { x: p.x + gap, y: p.y - h / 2 },
      { x: p.x - gap - w, y: p.y - h / 2 },
      { x: p.x - w / 2, y: p.y - gap - h },
      { x: p.x - w / 2, y: p.y + gap },
    ];
    const blockers = [$('leftCol'), $('submitBox'), $('viewCtl'), $('log')].map((el) => relRect(el, stage));
      if (!$('infoCard').hidden) blockers.push(relRect($('infoCard'), stage));
    const others = view!.state.units.filter((x) => x.id !== u.id).map((x) => fx(x.pos));
    let best = 0;
    let bestScore = Infinity;
    cands.forEach((c, i) => {
      const r = { x: c.x, y: c.y, w, h };
      const off = Math.max(0, -c.x) + Math.max(0, c.x + w - W) + Math.max(0, -c.y) + Math.max(0, c.y + h - H);
      let score = off * 8 + (i === cardSide ? 0 : 40);
      for (const o of others) if (o.visible && o.x > c.x - 14 && o.x < c.x + w + 14 && o.y > c.y - 14 && o.y < c.y + h + 14) score += 400;
      for (const b of blockers) score += overlap(r, b) / 40;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    cardSide = best;
    pos = clamp(cands[best].x, cands[best].y);
  }
  card.style.left = `${pos.x}px`;
  card.style.top = `${pos.y}px`;
  cardRect = { x: pos.x, y: pos.y, w, h };
}

/** 指令卡與機體資料卡之間的細線 */
function drawCardLink() {
  const info = $('infoCard');
  if (!cardRect || show || info.hidden) return;
  const r = relRect(info, $('stage').getBoundingClientRect());
  const inside = (p: { x: number; y: number }, q: { x: number; y: number; w: number; h: number }) => ({
    x: Math.max(q.x, Math.min(q.x + q.w, p.x)),
    y: Math.max(q.y, Math.min(q.y + q.h, p.y)),
  });
  const a = inside({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, cardRect);
  const b = inside({ x: cardRect.x + cardRect.w / 2, y: cardRect.y + cardRect.h / 2 }, r);
  if (Math.hypot(a.x - b.x, a.y - b.y) < 4) return;
  g.strokeStyle = 'rgba(255,207,74,0.6)';
  g.setLineDash([4, 3]);
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.stroke();
  g.setLineDash([]);
  for (const p of [a, b]) {
    g.fillStyle = 'rgba(255,207,74,0.9)';
    g.beginPath();
    g.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    g.fill();
  }
}

// ---- 可拖曳的浮層：機體清單、送出指令、機體資料卡（位置記在瀏覽器裡，雙擊標題恢復原位） ----

type Pin = { x: number; y: number };
const PIN_KEY = 'mech-wing-pins';
const FLOATERS = ['leftCol', 'submitBox', 'infoCard'];
const pins: Record<string, Pin | null> = (() => {
  try {
    return JSON.parse(localStorage.getItem(PIN_KEY) ?? '{}');
  } catch {
    return {};
  }
})();
const savePins = () => {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pins));
  } catch {}
};

function defaultPos(id: string, el: HTMLElement): Pin {
  if (id === 'submitBox') {
    const list = $('leftCol');
    return { x: list.offsetLeft, y: list.offsetTop + list.offsetHeight + 6 };
  }
  if (id === 'infoCard') return { x: W - el.offsetWidth - 10, y: 76 };
  return { x: 10, y: 10 };
}

function layoutFloaters() {
  for (const id of FLOATERS) {
    const el = $(id);
    if (el.hidden) continue;
    const p = pins[id] ?? defaultPos(id, el);
    el.style.left = `${Math.max(0, Math.min(W - el.offsetWidth, p.x))}px`;
    el.style.top = `${Math.max(0, Math.min(H - 24, p.y))}px`;
  }
}

for (const id of FLOATERS) {
  const el = $(id);
  const head = el.querySelector<HTMLElement>('.dragHead')!;
  let drag: { mx: number; my: number; x: number; y: number } | null = null;
  head.addEventListener('mousedown', (e) => {
    drag = { mx: e.clientX, my: e.clientY, x: el.offsetLeft, y: el.offsetTop };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    pins[id] = { x: drag.x + e.clientX - drag.mx, y: drag.y + e.clientY - drag.my };
    layoutFloaters();
  });
  window.addEventListener('mouseup', () => {
    if (drag) savePins();
    drag = null;
  });
  head.addEventListener('dblclick', () => {
    pins[id] = null;
    savePins();
    layoutFloaters();
  });
}

{
  const head = $('cmdHead');
  let drag: { mx: number; my: number; x: number; y: number } | null = null;
  head.addEventListener('mousedown', (e) => {
    const card = $('cmdCard');
    drag = { mx: e.clientX, my: e.clientY, x: card.offsetLeft, y: card.offsetTop };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    cardPinned = { x: drag.x + e.clientX - drag.mx, y: drag.y + e.clientY - drag.my };
    $('cmdPin').textContent = '已固定・雙擊還原';
    placeCard();
  });
  window.addEventListener('mouseup', () => (drag = null));
  head.addEventListener('dblclick', () => {
    cardPinned = null;
    $('cmdPin').textContent = '';
    placeCard();
  });
}

// ---- 左欄：機體資料與部位 ----

function partCell(u: UnitView, id: string): string {
  const p = u.parts[id];
  if (!p) return '<span></span>';
  const cls = p.destroyed ? 'dead' : p.damage ? 'hurt' : '';
  return `<span class="${cls}">${esc(p.name)}(${p.durability - p.damage}/${p.durability})</span>`;
}

function infoHtml(u: UnitView): string {
  const ch = CHASSIS[u.chassisId];
  const mine = u.owner === view!.you;
  let html = `<div class="uname" style="color:${color(u.owner)}">${esc(u.label)} <span class="muted small">${esc(ch.name.replace(/^X-\d+ /, ''))}・重量級 ${ch.weightClass}</span></div>`;
  if (mine && u.pilotId) {
    const p = PILOTS[u.pilotId];
    html += `<div class="small">${esc(p.name)}（技能 ${p.skill}${p.abilities.includes('quick_draw') ? '・快速拔刀' : ''}）　壓力 <b>${u.stress}</b>/${u.maxStress}　推進劑 <b>${u.propellant}</b>/${u.maxPropellant}</div>`;
    const flags = [u.blackout ? '<span class="warn">黑視中</span>' : '', u.lockOn ? `鎖定 ${esc(labelOf(u.lockOn))}` : '', inGrapple(u.id) ? '<span class="warn">纏鬥中</span>' : ''].filter(Boolean);
    if (flags.length) html += `<div class="small">${flags.join('　')}</div>`;
  } else {
    html += `<div class="small muted">駕駛：不明${u.vague === 'sluggish' ? '　<span class="warn">動作遲鈍</span>' : ''}</div>`;
  }
  const body = [
    ['', 'head', ''],
    ['larm', 'torso', 'rarm'],
    ['', 'pack', ''],
    ['', 'legs', ''],
  ];
  html += `<div class="body">${body.flat().map((id) => (id ? partCell(u, id) : '<span></span>')).join('')}</div>`;
  const where = { right: '右手', left: '左手', stowed: '收納', mount: '外掛' };
  html += `<div class="equip">${u.equipment.map((e) => `<span>${where[e.location]} ${partCell(u, e.id)}</span>`).join('')}</div>`;
  if (u.status !== 'active') html += `<div class="err">${{ destroyed: '已擊毀', withdrawn: '已脫離戰場', unconscious: '駕駛昏迷', disabled: '停止動作' }[u.status]}</div>`;
  return html;
}

// ---- 中欄：機動盤／行動 ----

function resultText(): string {
  const w = view!.state.winner;
  if (w === 'draw') return '平手';
  if (local?.opponent === 'aivai') return `${SIDE(w as PlayerId)} 方勝利`;
  return w === view!.you ? '勝利' : '敗北';
}

function controlsHtml(u: UnitView | undefined): string {
  if (replayNow || show || !u || view!.phase === 'over' || local?.opponent === 'aivai') return '';
  if (u.owner !== view!.you || u.status !== 'active' || view!.submitted[view!.you]) return '';
  return view!.phase === 'move' ? moveControls(u, moveDrafts[u.id]) : actionControls(u, actionDrafts[u.id]);
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
    return `<button class="${cls}" data-m="${m.id}" data-tip="${esc(title)}" ${ok ? '' : 'disabled'}>${GLYPH[dialKey(m)]}<small>${m.kind === 'hover' ? '' : m.speed}</small></button>`;
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
  for (const key of ['arc-L', 'kturn-S', 'hover-S', 'arc-R']) for (const m of dial.filter((x) => dialKey(x) === key)) html += button(m);
  return html + '</div>';
}

const STANCE_TIPS: Record<Stance, string> = {
  normal: '撞到其他機體只算擦撞：雙方停在接觸點、本回合不能行動，但不受傷。',
  charge: '撞到敵機時出手。相對速度 0–2：纏在一起（纏鬥）。3 以上：一擊脫離，雙方擲骰比近戰（駕駛技能越高骰越多），贏越多傷害越大；速度 5 以上出手會加壓力（王牌 6 以上）。手上沒有近戰武器則是撞擊：速度越快傷害越大，自己也吃一半。',
  evade: '底板判定變小，比較不容易被撞到；被射擊時命中率 −15%。撞到別人時效果同「一般」。',
};
const STANCE_NAMES: Record<Stance, string> = { normal: '一般', charge: '突進', evade: '迴避' };
const GRAPPLE_TIPS: Record<GrappleChoice, string> = {
  slash: '用手上的近戰武器攻擊。會被「架」擋下，但能打斷「抓」。',
  parry: '用近戰武器或盾牌擋下「斬」並取得優勢；擋不住「抓」，也會被「推」壓制。',
  grab: '需要一隻空手。成功就把對方甩開 2 格、造成傷害並結束纏鬥；怕「斬」。',
  push: '比力氣（出力＋重量＋駕駛＋骰子），贏的一方取得優勢，差 3 以上直接把對方推開。',
  disengage: '花 1 壓力離開纏鬥；對方選「抓」就會脫離失敗。',
};

/** 在按鈕上掛說明文字，滑鼠停留時顯示在卡片下方的說明區 */
const tip = (button: string, text: string) => button.replace(/^<button /, `<button data-tip="${esc(text)}" `);

function moveControls(u: UnitView, plan: MovePlan): string {
  if (inGrapple(u.id)) {
    const opts = grappleOptions(u as unknown as UnitState);
    return `<div class="sec">選一個纏鬥動作</div><div class="row">${opts
      .map((o) => tip(`<button class="${plan.grapple === o && touched.has(u.id) ? 'on' : ''}" data-grapple="${o}">${GRAPPLE_NAMES[o]}</button>`, GRAPPLE_TIPS[o]))
      .join('')}</div>`;
  }
  const usable = availableManeuvers(u);
  if (!usable.some((m) => m.id === plan.maneuver) && usable[0]) plan.maneuver = usable[0].id;
  const m = parseManeuver(plan.maneuver);
  const cost = planCost(plan);
  let html = '<div class="ctrlRow"><div>';
  html += `<div class="sec">機動：<b style="color:var(--text)">${m.name}</b>　推 −${cost.propellant}　壓 +${cost.stress}</div>`;
  html += dialHtml(u, plan);
  html += '</div><div>';
  html += '<div class="sec">姿態</div><div class="row">';
  html += (['normal', 'charge', 'evade'] as Stance[]).map((s) => tip(`<button class="${plan.stance === s ? 'on' : ''}" data-stance="${s}">${STANCE_NAMES[s]}</button>`, STANCE_TIPS[s])).join('');
  html += '</div>';
  if (m.kind === 'hover') {
    html += `<div class="row"><span class="small muted">原地轉身</span><select data-f="facingOffset">${config.FACING_OFFSETS.map((f) => `<option value="${f}" ${plan.facingOffset === f ? 'selected' : ''}>${f === 0 ? '不轉' : `${f > 0 ? '右' : '左'} ${Math.abs(f)}°`}</option>`).join('')}</select></div>`;
  } else {
    html += `<div class="row small"><label><input type="checkbox" data-f="limiter" ${plan.limiter ? 'checked' : ''}> 限制器解除（多走 1 格，壓力 +${config.LIMITER_STRESS}）</label></div>`;
  }
  html += `<div class="row small"><label><input type="checkbox" data-f="soften" ${plan.soften ? 'checked' : ''}> 收刀（接觸時花 1 壓力降一檔）</label></div>`;
  return html + '</div></div>';
}

interface EquipOption {
  key: string;
  label: string;
  kind: 'shoot' | 'draw' | 'lock' | 'none';
  equip?: string;
}

/** 行動步驟可選的「裝備」：手上的射擊武器、收著的武器、頭部感測器 */
function equipOptions(u: UnitView): EquipOption[] {
  const out: EquipOption[] = [];
  const alive = (id: string) => !u.parts[id].destroyed;
  const handOk = (h: Hand) => alive(h === 'right' ? 'rarm' : 'larm');
  for (const e of u.equipment) {
    const def = EQUIPMENT[e.defId];
    if (!alive(e.id)) continue;
    if ((e.location === 'right' || e.location === 'left') && handOk(e.location) && def.kind === 'ranged') out.push({ key: `shoot:${e.id}`, label: `${def.name}・射擊`, kind: 'shoot', equip: e.id });
    if (e.location === 'stowed' && (def.kind === 'melee' || def.kind === 'ranged') && (handOk('right') || handOk('left'))) out.push({ key: `draw:${e.id}`, label: `${def.name}・拔出`, kind: 'draw', equip: e.id });
  }
  if (alive('head')) out.push({ key: 'lock', label: '頭部感測器・鎖定', kind: 'lock' });
  out.push({ key: 'none', label: '不行動', kind: 'none' });
  return out;
}

/** 拔出的武器放到哪隻手：先找空手，再找沒拿盾、也不是要射擊的那隻 */
function drawHand(u: UnitView, keep?: string): Hand {
  const hands = (['right', 'left'] as Hand[]).filter((h) => !u.parts[h === 'right' ? 'rarm' : 'larm'].destroyed);
  const held = (h: Hand) => u.equipment.find((e) => e.location === h && !u.parts[e.id].destroyed);
  return (
    hands.find((h) => !held(h)) ??
    hands.find((h) => EQUIPMENT[held(h)!.defId].kind !== 'shield' && held(h)!.id !== keep) ??
    hands[0] ??
    'right'
  );
}

function optionOn(o: EquipOption, plan: ActionPlan, u: UnitView): boolean {
  if (!touched.has(u.id)) return false;
  const a = plan.action;
  if (o.kind === 'shoot') return a.type === 'shoot' && a.weapon === o.equip;
  if (o.kind === 'draw') return plan.swap?.equip === o.equip;
  if (o.kind === 'lock') return a.type === 'lock';
  return a.type === 'none' && !plan.swap;
}

function estimate(u: UnitView, plan: ActionPlan, t: UnitView): string {
  if (plan.action.type === 'lock') return '';
  if (plan.action.type !== 'shoot') return '';
  const w = u.equipment.find((e) => e.id === (plan.action as { weapon: string }).weapon);
  const h = w ? hitChance({ attacker: u, attackerSkill: PILOTS[u.pilotId!].skill, weapon: EQUIPMENT[w.defId], target: t, targetSkill: null, targetStance: null, targetHovered: false }) : null;
  return h ? `${bandName(h.band)}・約 ${h.chance}%` : '射程外';
}

const BAND_SHORT = { 1: '近', 2: '中', 3: '遠' } as const;

function optionTip(u: UnitView, o: EquipOption, quick: boolean): string {
  if (o.kind === 'lock') return `鎖定一台敵機，下次對它射擊命中率 +${config.LOCK_BONUS}%。頭部被破壞就不能鎖定。`;
  if (o.kind === 'none') return '這回合不行動。';
  const def = EQUIPMENT[u.equipment.find((e) => e.id === o.equip)!.defId];
  if (o.kind === 'draw') return `把${def.name}換到手上${def.kind === 'melee' ? '，之後突進撞到敵機時才砍得到' : ''}。${quick ? '快速拔刀：不佔行動。' : '會用掉這回合的行動。'}`;
  const ranges = ([1, 2, 3] as const)
    .filter((b) => def.ranges?.[b] !== undefined)
    .map((b) => `${BAND_SHORT[b]} ${def.ranges![b]! >= 0 ? '+' : ''}${def.ranges![b]}`)
    .join('／');
  return `${def.name}：每發 ${def.damage} 傷害${(def.shots ?? 1) > 1 ? `，一次 ${def.shots} 發` : ''}。距離修正 ${ranges}。`;
}

function actionControls(u: UnitView, plan: ActionPlan): string {
  if (view!.state.bumped.includes(u.id)) return '<div class="warn">這台機體在移動時擦撞，本回合不能行動。</div>';
  const quick = PILOTS[u.pilotId!].abilities.includes('quick_draw');
  let html = '<div class="sec">選一件裝備</div><div class="optList">';
  html += equipOptions(u)
    .map((o) => tip(`<button class="${optionOn(o, plan, u) ? 'on' : ''}" data-opt="${o.key}">${esc(o.label)}</button>`, optionTip(u, o, quick)))
    .join('');
  html += '</div>';
  const a = plan.action;
  if (a.type === 'shoot' || a.type === 'lock') {
    const enemies = view!.state.units.filter((x) => x.owner !== view!.you && x.status === 'active');
    html += `<div class="sec">目標（也可以直接點地圖上的敵機）</div><div class="row">`;
    html += enemies
      .map((t) => tip(`<button class="${a.target === t.id ? 'on' : ''}" data-target="${t.id}">${esc(t.label.split(' ')[0])}</button>`, a.type === 'shoot' ? `${t.label}：${estimate(u, plan, t)}` : `鎖定 ${t.label}`))
      .join('');
    html += '</div>';
  }
  if (plan.swap) html += `<div class="small ${quick ? 'muted' : 'warn'}">${quick ? '快速拔刀：拔出不佔行動，還可以再選一件射擊武器或鎖定。' : '拔出武器會用掉這回合的行動。'}</div>`;
  return html;
}

function bindControls(u: UnitView | undefined) {
  if (!u || u.owner !== view!.you) return;
  const ctr = $('controls');
  const move = moveDrafts[u.id];
  const plan = actionDrafts[u.id];
  const changed = () => {
    touched.add(u.id);
    renderPanel();
  };
  ctr.querySelectorAll<HTMLButtonElement>('button[data-m]').forEach((b) => {
    b.onmouseenter = () => (hoverManeuver = { unit: u.id, maneuver: b.dataset.m! });
    b.onmouseleave = () => (hoverManeuver = null);
    b.onclick = () => {
      move.maneuver = b.dataset.m!;
      if (parseManeuver(move.maneuver).kind === 'hover') move.limiter = false;
      else move.facingOffset = 0;
      hoverManeuver = null;
      changed();
    };
  });
  ctr.querySelectorAll<HTMLButtonElement>('button[data-stance]').forEach((b) => (b.onclick = () => ((move.stance = b.dataset.stance as Stance), changed())));
  ctr.querySelectorAll<HTMLButtonElement>('button[data-grapple]').forEach((b) => (b.onclick = () => ((move.grapple = b.dataset.grapple as GrappleChoice), changed())));
  ctr.querySelectorAll<HTMLSelectElement | HTMLInputElement>('[data-f]').forEach((el) => {
    el.onchange = () => {
      const v = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.f === 'facingOffset') move.facingOffset = Number(v);
      if (el.dataset.f === 'limiter') move.limiter = v as boolean;
      if (el.dataset.f === 'soften') move.soften = v as boolean;
      changed();
    };
  });
  if (!plan) return;
  const quick = PILOTS[u.pilotId!].abilities.includes('quick_draw');
  const target = () => (plan.action.type !== 'none' ? plan.action.target : '');
  ctr.querySelectorAll<HTMLButtonElement>('button[data-opt]').forEach((b) => {
    b.onclick = () => {
      const o = equipOptions(u).find((x) => x.key === b.dataset.opt)!;
      if (o.kind === 'shoot') {
        plan.action = { type: 'shoot', weapon: o.equip!, target: target() };
        if (!quick) plan.swap = undefined;
      } else if (o.kind === 'lock') {
        plan.action = { type: 'lock', target: target() };
        if (!quick) plan.swap = undefined;
      } else if (o.kind === 'draw') {
        const keep = plan.action.type === 'shoot' ? plan.action.weapon : undefined;
        plan.swap = plan.swap?.equip === o.equip && quick ? undefined : { hand: drawHand(u, keep), equip: o.equip! };
        if (!quick) plan.action = { type: 'none' };
      } else {
        plan.action = { type: 'none' };
        plan.swap = undefined;
      }
      changed();
    };
  });
  ctr.querySelectorAll<HTMLButtonElement>('button[data-target]').forEach((b) => (b.onclick = () => setTarget(u.id, b.dataset.target!)));
}

function setTarget(unitId: string, targetId: string) {
  const plan = actionDrafts[unitId];
  if (!plan || plan.action.type === 'none') return;
  plan.action.target = targetId;
  touched.add(unitId);
  renderPanel();
}

// ---- 右欄：送出指令 ----

function renderSubmit() {
  const col = $('submitCol');
  if (replayNow || (replayQueue && !show)) {
    col.innerHTML = '<button class="big" id="skipBtn">跳過這段</button><button class="big" id="stopReplayBtn">結束重播</button>';
    $('skipBtn').onclick = skipShow;
    $('stopReplayBtn').onclick = stopReplay;
    return;
  }
  if (show) {
    col.innerHTML = '<button class="big" id="skipBtn">跳過演出</button>';
    $('skipBtn').onclick = skipShow;
    return;
  }
  if (view?.phase === 'over') {
    col.innerHTML = `<h3>${resultText()}</h3><button class="primary big" id="replayBtn" ${replays[seat].length ? '' : 'disabled'}>重播整場戰鬥</button><button class="big" id="againBtn">再來一場</button>`;
    $('replayBtn').onclick = startReplay;
    $('againBtn').onclick = () => restart();
    return;
  }
  if (!view || local?.opponent === 'aivai') {
    col.innerHTML = '';
    return;
  }
  const done = view.submitted[view.you];
  col.innerHTML = `${errors.length ? `<div class="err small">${errors.map(esc).join('<br>')}</div>` : ''}<button class="primary big" id="submitBtn" ${done ? 'disabled' : ''}>${done ? '等待對手…' : '送出指令'}</button>`;
  $('submitBtn').onclick = trySubmit;
}

function trySubmit() {
  const missing = ownUnits().filter((u) => needsOrder(u) && !orderDone(u));
  if (!missing.length) return submitOrders();
  const fallback = view!.phase === 'move' ? '移動步驟會用預設機動（直線 2）' : '行動步驟則是不行動（選了裝備但沒選目標的也一樣）';
  const dlg = $('confirm');
  dlg.innerHTML = `<div class="dlg"><h3>還有機體沒下指令</h3><p class="muted">${missing.map((u) => esc(u.label.split(' ')[0])).join('、')} 還沒下指令。照預設送出的話，${fallback}。</p><div class="row" style="justify-content:flex-end"><button id="dlgBack">回去下指令</button><button class="primary" id="dlgGo">照預設送出</button></div></div>`;
  dlg.hidden = false;
  $('dlgBack').onclick = () => {
    dlg.hidden = true;
    selected = missing[0].id;
    renderAll();
  };
  $('dlgGo').onclick = () => {
    dlg.hidden = true;
    submitOrders();
  };
}

function submitOrders() {
  if (view!.phase === 'move') return sendMsg({ t: 'moves', moves: moveDrafts });
  // 沒選目標的射擊／鎖定視為不行動
  const actions: Record<string, ActionPlan> = {};
  for (const [id, p] of Object.entries(actionDrafts)) actions[id] = p.action.type !== 'none' && !p.action.target ? { ...p, action: { type: 'none' } } : p;
  sendMsg({ t: 'actions', actions });
}

// ---------- 事件紀錄 ----------

const RESULT_NAMES = { none: '擦身而過', bump: '擦撞', clinch: '纏鬥', hitrun: '一擊脫離', ram: '撞擊' };

const DIE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const DEFENSE_NAMES = { blade: '迎擊', shield: '舉盾', dodge: '閃避', none: '背後中刀' };

function clashText(e: Extract<GameEvent, { type: 'clash' }>): string {
  const dice = (d: number[]) => d.map((x) => DIE_FACES[x]).join('');
  const side = `${labelOf(e.attacker)} 突進出刀 ${dice(e.attDice)}（${e.attHits} 成功）`;
  const def = e.defense === 'none' ? `${labelOf(e.defender)} 背後中刀` : `${labelOf(e.defender)} ${DEFENSE_NAMES[e.defense]} ${dice(e.defDice)}（${e.defHits} 成功）`;
  let result: string;
  if (e.winner === null) result = '刀刃相抵，雙方錯身而過';
  else if (e.winner === e.attacker) result = `${labelOf(e.attacker)} 斬中，${e.damage} 點傷害`;
  else if (e.damage) result = `${labelOf(e.defender)} 反斬，${e.damage} 點傷害`;
  else result = `${labelOf(e.defender)} ${e.defense === 'shield' ? '擋下' : '閃開'}了`;
  return `${side} vs ${def}：${result}`;
}

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
    case 'clash':
      return clashText(e);
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
  const at = Date.now();
  for (const e of events) {
    const text = describe(e);
    if (!text) continue;
    const owner = eventOwner(e);
    logs[seat].push({ text, at, cls: e.type === 'turnStart' || e.type === 'gameOver' ? 'turn' : owner === null ? '' : owner === seat ? 'mine' : 'theirs' });
  }
  renderLog();
}

/** 收合時只顯示最近幾秒的紀錄，最後一段慢慢淡出 */
const LOG_SHOW_MS = 6000;
const LOG_FADE_MS = 1500;

function renderLog() {
  const el = $('logLines');
  const list = logs[seat];
  el.classList.toggle('open', logOpen);
  $('logToggle').textContent = logOpen ? '收合紀錄' : `紀錄（${list.length}）`;
  if (logOpen) {
    el.innerHTML = list.map((l) => `<div class="${l.cls}">${esc(l.text)}</div>`).join('');
    el.scrollTop = el.scrollHeight;
    return;
  }
  const now = Date.now();
  el.innerHTML = list
    .filter((l) => now - l.at < LOG_SHOW_MS)
    .slice(-8)
    .map((l) => {
      const left = LOG_SHOW_MS - (now - l.at);
      return `<div class="${l.cls}" style="opacity:${Math.min(1, left / LOG_FADE_MS).toFixed(2)}">${esc(l.text)}</div>`;
    })
    .join('');
}
setInterval(() => !logOpen && renderLog(), 250);
$('logToggle').onclick = () => {
  logOpen = !logOpen;
  renderLog();
};

function restart() {
  logs[0].length = 0;
  logs[1].length = 0;
  replays[0].length = 0;
  replays[1].length = 0;
  replayQueue = null;
  replayNow = null;
  savedViews[0] = savedViews[1] = null;
  draftKey = '';
  renderLog();
  sendMsg({ t: 'reset' });
}

$('resetBtn').onclick = () => {
  if (confirm(local ? '重新開始一場對戰？' : '重開這個房間？雙方的對戰都會重設。')) restart();
};

// 對手：電腦／同機輪流／電腦對戰電腦（只有本機模式）
const OPPONENT_KEY = 'mech-wing-opponent';
const opponentSel = $('opponent') as HTMLSelectElement;
function initialOpponent(): Opponent {
  const fromUrl = params.get('opponent');
  if (fromUrl === 'ai' || fromUrl === 'hotseat' || fromUrl === 'aivai') return fromUrl;
  try {
    const saved = localStorage.getItem(OPPONENT_KEY);
    if (saved === 'ai' || saved === 'hotseat' || saved === 'aivai') return saved;
  } catch {}
  return 'ai';
}
opponentSel.onchange = () => {
  if (!local) return;
  local.opponent = opponentSel.value as Opponent;
  try {
    localStorage.setItem(OPPONENT_KEY, local.opponent);
  } catch {}
  restart();
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
  local = new LocalGame(onMessage, initialOpponent());
  opponentSel.value = local.opponent;
  switchSeat(0);
} else {
  opponentSel.hidden = true;
  connect();
}
requestAnimationFrame(drawFrame);
