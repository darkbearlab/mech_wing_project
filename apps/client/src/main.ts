import {
  ARMOR_NAMES,
  DAMAGE_TYPE_NAMES,
  matchupText,
  barrierBetween,
  buildingAim,
  buildingHitChance,
  topHp,
  levelHp,
  BUILDING_TYPE_MULT,
  inFootprint,
  barricadeWall,
  ecmOf,
  jammed,
  barrierOf,
  indirectFire,
  lungeCheck,
  readyMelee,
  shieldArcs,
  closeCombatOf,
  handOfPart,
  handUsable,
  isHumanoid,
  radiusOf,
  roleLost,
  CHASSIS,
  EQUIPMENT,
  GRAPPLE_NAMES,
  PILOTS,
  cruiseManeuver,
  maneuverCost,
  bandName,
  buildPath,
  config,
  grappleOptions,
  hitChance,
  alwaysReady,
  equipAlive,
  freeDraw,
  busyHands,
  heldItem,
  rackSide,
  shotWeapons,
  swapOrders,
  handBlocked,
  rangeBand,
  readyRanged,
  relativeAngle,
  lineOfFire,
  coverOf,
  coverParts,
  climbBlocked,
  climbLimits,
  wallPenetration,
  supportAt,
  sensorRange,
  relativeSpeed,
  moveSpeed,
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
  type PursuitPlan,
  type DeployPlan,
  techniqueUse,
  normalizeChoice,
  dangerClose,
  isShip,
  barrageStrength,
  barrageActive,
  barragePenalty,
  inBarrage,
  availableManeuvers,
  immobile,
  forecastMoves,
  contentVersion,
  jumpJetOf,
  jumpCost,
  coastEnd,
  landingHeight,
  exposed,
  flightFire,
  needsMark,
  screenBlocked,
  screenLaunchers,
  warningText,
  type MoveWarning,
  coveringShield,
  psycommuOf,
  canPsycommu,
  podDestination,
  bitsLeft,
  type Scenario,
  armorOf,
  aiDeploy,
  deployZone,
  minSpeedOf,
  Rng,
  type TurnPhase,
  type WinReason,
  dialOf,
  CONTROL_RADIUS,
  GOAL_RADIUS,
  controlPoints,
  supplyPoint,
  goalZone,
  type Obstacle,
  type PlayerId,
  type PlayerView,
  type ServerMessage,
  type Stance,
  type UnitState,
  type UnitView,
  type Vec,
} from '@mech/rules';
import { Camera, attachCameraControls, type CameraView, type Projected } from './camera';
import { loadContent } from './content';
import { lobbyUpdate, openLineup, seatLabel, type LineupSettings } from './lineup';
import { openMenu, type Side } from './menu';
import { LocalGame, type Opponent } from './local';
import { RecordPlayer, listBattles, loadBattle, setAdminKey } from './replay';
import { mechSilhouette } from './silhouette';
import { SHOT_FLIGHT, SHOT_GAP, SHOT_DELAY, buildBeats, moveProgress, shotLandTime, type Beat } from './show';

// ---------- 連線 ----------

const params = new URLSearchParams(location.search);
// server：連對戰伺服器，兩個視窗各坐一席；local：同一台裝置輪流（GitHub Pages 沒指定房間時用這個）
const mode = params.get('mode') ?? (import.meta.env.PROD && !params.has('room') ? 'local' : 'server');
/** 對戰伺服器：開發時是 Vite 轉給本機伺服器；線上是 Cloudflare 的房間；?server= 可以指定 */
const SERVER = params.get('server') ?? (import.meta.env.PROD ? (import.meta.env.VITE_ROOM_SERVER ?? 'wss://mech-wing-api.darkbearlab.workers.dev') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
const room = params.get('room') || 'test';
/** 席位：0、1，一方分成幾個小隊時是 0-1、1-2 這類（0 就是 0-0） */
const seatName = /^[01](-\d{1,2})?$/.test(params.get('seat') ?? '') ? params.get('seat')!.replace(/-0$/, '') : '0';
let seat: PlayerId = seatName.startsWith('1') ? 1 : 0;
/** 對戰紀錄：?replays 是清單，?replay=編號 重播那一場 */
const recordId = Number(params.get('replay')) || null;
const recordList = params.has('replays');
/** 觀戰（?seat=watch）與重播紀錄：雙方都看得到，不能下指令 */
const watching = params.get('seat') === 'watch' || recordId !== null;

let ws: WebSocket;
let local: LocalGame | null = null;
let view: PlayerView | null = null;
let connected: [boolean, boolean] = [false, false];
let deadline: number | null = null;
let errors: string[] = [];

function connect() {
  ws = new WebSocket(`${SERVER}/ws?room=${encodeURIComponent(room)}&seat=${watching ? 'watch' : seatName}`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data) as ServerMessage);
  ws.onclose = (e) => {
    connected = [false, false];
    // 同一席位在別的分頁開了：這一頁讓出來，不再重連（否則兩頁會互踢）
    if (e.code === 4000) {
      const cover = document.getElementById('cover')!;
      $('lineup').hidden = true;
      cover.innerHTML = `<div><p>這個席位已經在別的分頁或視窗開啟</p><p class="muted">這一頁已經讓出席位；要在這裡玩請重新整理。</p></div>`;
      cover.hidden = false;
      return;
    }
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
/** 追擊步驟：各機體選的追擊（null 表示放棄） */
let pursuitDrafts: Record<string, PursuitPlan | null> = {};
/** 部署：各機體擺的位置、朝向與起始動能 */
let deployDrafts: Record<string, DeployPlan> = {};
/** 部署時正在拖的機體 */
let dragging: string | null = null;
/** 正在拖曳面向把手的機體 */
let faceDrag: string | null = null;

const QUARTER = Math.PI / 4;
const snapFacing = (f: number) => Math.round(f / QUARTER) * QUARTER;
/** 起始動能的範圍：0–2，戰機至少最低速度 */
const momentumRange = (u: UnitView): [number, number] => [Math.min(minSpeedOf(u), 2), Math.max(2, minSpeedOf(u))];
/** 部署時機體顯示在擬定的位置 */
function shownPose(u: UnitView): { pos: Vec; f: number } {
  const d = view?.phase === 'deploy' ? deployDrafts[u.id] : undefined;
  return d ? { pos: { x: d.x, y: d.y }, f: d.facing } : { pos: u.pos, f: u.facing };
}
/** 部署擺法的問題：和隊友重疊、壓到大隕石 */
function deployProblem(u: UnitView): string | null {
  const d = deployDrafts[u.id];
  if (!d) return null;
  const r = radiusOf(u);
  if (view!.state.obstacles.some((o) => o.kind === 'rock' && Math.hypot(d.x - o.x, d.y - o.y) < o.r + r)) return '壓到大隕石';
  if (view!.state.obstacles.some((o) => o.kind === 'building' && wallPenetration(o, d, r) > 0)) return '壓到建築';
  for (const [id, q] of Object.entries(deployDrafts)) {
    const o = id !== u.id ? unitView(id) : undefined;
    if (o && Math.hypot(q.x - d.x, q.y - d.y) < radiusOf(o) + r + 0.1) return '和隊友重疊';
  }
  return null;
}
let draftKey = '';
let selected: string | null = null;
let pendingView: PlayerView | null = null;
/** 演出中各機體在地圖上的位置與狀態（一拍結束才定格） */
interface Disp {
  x: number;
  y: number;
  f: number;
  status: UnitView['status'];
  /** 高度（層） */
  z?: number;
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
/** 正在地圖上點選炮群目標點：哪台的哪個炮群 */
let podPick: { unit: string; equip: string } | null = null;
/** 滑鼠目前停在哪台機體上（行動步驟顯示命中率） */
let hoverUnit: string | null = null;
interface LogLine {
  text: string;
  cls: string;
  at: number;
}
const logs: [LogLine[], LogLine[]] = [[], []];
let logOpen = false;

/** 開房模式：還沒開打時的房間狀態 */
let lobby: Extract<ServerMessage, { t: 'lobby' }> | null = null;
/** 這一場（game 編號）已經打開過選隊畫面 */
let lineupOpenedFor = -1;

/** 開房模式：選自己的隊伍加入；已經加入就等對手 */
function showLobby() {
  if (!lobby) return;
  const cover = document.getElementById('cover')!;
  if (watching) {
    $('lineup').hidden = true;
    cover.innerHTML = `<div><p>觀戰房間 <b>${esc(room)}</b></p><p class="muted">等待雙方選好隊伍加入（A：${lobby.joined[0] ? '已加入' : '選隊中'}、B：${lobby.joined[1] ? '已加入' : '選隊中'}）…</p></div>`;
    cover.hidden = false;
    return;
  }
  lobbyUpdate(lobby.seats ?? [], lobby.mates ?? {});
  if (lobbyJoined()) {
    $('lineup').hidden = true;
    const many = (lobby.seats?.length ?? 0) > 2;
    // 分小隊：列出還沒加入的席位
    const waiting = many ? (lobby.seats ?? []).filter((s) => !s.joined).map((s) => seatLabel(s.key)) : [];
    cover.innerHTML = `<div><p>已加入房間 <b>${esc(room)}</b>，你是 <b style="color:${color(seat)}">${SIDE(seat)} 方</b>${many ? `（${seatLabel(seatName)}）` : ''}</p><p class="muted">${many ? `等待其他席位加入：${waiting.join('、') || '—'}` : `等待對手選好隊伍加入${lobby.connected[seat === 0 ? 1 : 0] ? '' : '（對手還沒連線）'}`}…</p></div>`;
    cover.hidden = false;
    return;
  }
  cover.hidden = true;
  // 客人：房主的條件出來了就照它重開選隊畫面
  const key = lobby.game * 2 + (lobby.terms ? 1 : 0);
  if (lineupOpenedFor === key) return;
  lineupOpenedFor = key;
  openLineup(
    'hotseat',
    () => {},
    {
      side: seat,
      seat: seatName,
      roomUrl: `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`,
      hostPrefs: seatName !== '0' ? ((lobby.terms?.prefs as LineupSettings | undefined) ?? null) : null,
      onJoin: (roster, settings, scale, prefs, ai) =>
        sendMsg({ t: 'join', roster, ...(seatName === '0' ? { terms: { settings, scale, prefs, squads: prefs.squads ?? [1, 1], ai } } : {}) }),
    },
  );
}

function onMessage(msg: ServerMessage) {
  if (msg.t === 'lobby') {
    lobby = msg;
    connected = msg.connected;
    view = null;
    renderStatus();
    showLobby();
    return;
  }
  if (msg.t === 'state') {
    if (lobby) {
      // 開打了：收起選隊與等待畫面
      lobby = null;
      $('lineup').hidden = true;
      document.getElementById('cover')!.hidden = true;
    }
    connected = msg.connected;
    deadline = msg.deadline;
    if (show) pendingView = msg.view;
    else applyView(msg.view);
  } else if (msg.t === 'resolved') {
    errors = [];
    startShow(msg.events);
  } else if (msg.t === 'error') {
    errors = msg.errors;
    // 還沒開打：多半是加入房間被退回，重開選隊畫面並把原因寫在狀態列
    if (lobby && !lobbyJoined()) {
      lineupOpenedFor = -1;
      showLobby();
      $('status').textContent = msg.errors.join('；');
      return;
    }
    renderPanel();
  }
}

// ---------- 結算演出：一拍一拍播放 ----------

/** 每次結算的演出都記下來，對戰結束後可以整場重播（各席位只記自己看得到的內容） */
interface ReplayItem {
  turn: number;
  phase: TurnPhase;
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
  const display = new Map<string, Disp>(prevUnits.map((u) => [u.id, { x: u.pos.x, y: u.pos.y, f: u.facing, status: u.status, z: u.z }]));
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
    if (e.type === 'move') {
      const last = e.samples[e.samples.length - 1];
      if (last) [d.x, d.y, d.f] = last;
    }
    else if (e.type === 'reposition' || e.type === 'knockback') Object.assign(d, e.to);
    else if (e.type === 'status') d.status = e.status;
    else if (e.type === 'elevate') d.z = e.z;
  }
}

function stopShow() {
  if (show) clearTimeout(show.timer);
  show = null;
}

function finishShow() {
  if (replayQueue && show) {
    // 重播段落之間：停在這段結算完的畫面，不要退回目前（最終）的戰場
    clearTimeout(show.timer);
    for (let i = Math.max(0, show.index); i < show.beats.length; i++) settleBeat(show, show.beats[i]);
    show.index = show.beats.length;
    const current = show;
    window.setTimeout(() => replayQueue && show === current && playNextReplay(), 500);
    renderPanel();
    return;
  }
  stopShow();
  if (pendingView) applyView(pendingView);
  pendingView = null;
  renderPanel();
  scheduleAuto();
}

function skipShow() {
  if (!show) return;
  // 重播中這段已經播完、正在等下一段：直接跳到下一段
  if (replayQueue && show.index >= show.beats.length) return playNextReplay();
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
    podPick = null;
    pursuitDrafts = {};
    deployDrafts = {};
    for (const u of ownUnits()) {
      if (u.status !== 'active') continue;
      if (v.phase === 'deploy') {
        const [lo, hi] = momentumRange(u);
        deployDrafts[u.id] = { x: u.pos.x, y: u.pos.y, facing: snapFacing(u.facing), momentum: Math.max(lo, Math.min(hi, u.momentum)) };
      }
      if (v.phase === 'move' || (v.phase === 'ace' && v.aceUnits?.includes(u.id))) moveDrafts[u.id] = initialMove(u);
      if (v.phase === 'action') actionDrafts[u.id] = { action: { type: 'none' }, ...(inGrapple(u.id) ? { grapple: normalizeChoice(u as unknown as UnitState, undefined) } : {}) };
      // 追擊：先幫忙選好估計傷害最高的一槍，玩家可以改或放棄
      const opts = v.pursuit?.[u.id];
      if (v.phase === 'pursuit' && opts?.length) {
        const best = [...opts].sort((a, b) => b.chance * weaponPower(u, b.weapon) - a.chance * weaponPower(u, a.weapon))[0];
        pursuitDrafts[u.id] = { target: best.target, weapon: best.weapon };
        touched.add(u.id);
      }
    }
  }
  if (!show) scheduleAuto();
  if (!selected || !v.state.units.some((u) => u.id === selected)) selected = ownUnits().find((u) => u.status === 'active')?.id ?? null;
  // 王牌移動、追擊：自動選第一台要下指令的機體
  const sel = selected ? unitView(selected) : undefined;
  if ((v.phase === 'ace' || v.phase === 'pursuit') && (!sel || !commands(sel) || !needsOrder(sel))) selected = ownUnits().find((u) => needsOrder(u))?.id ?? selected;
  renderAll();
}

/** 這個席位指揮的機體（分小隊時隊友的機體看得到、不能下令） */
const commands = (u: UnitView) => !!view && u.owner === view.you && (view.squad === undefined || (u.squad ?? 0) === view.squad);
const ownUnits = () => (view ? view.state.units.filter(commands) : []);
/** 開房模式：自己這個席位加入了沒 */
const lobbyJoined = () => (lobby?.seats ? !!lobby.seats.find((s) => s.key === seatName)?.joined : !!lobby?.joined[seat]);
const unitView = (id: string) => view?.state.units.find((u) => u.id === id);
const labelOf = (id: string) => unitView(id)?.label ?? show?.prevUnits.find((u) => u.id === id)?.label ?? podLabel(id) ?? (buildingOf(id) || id.startsWith('b') ? `建築 ${id}` : id);
/** 地圖上還在的建築 */
const buildingOf = (id: string) => view?.state.obstacles.find((o) => o.id === id && o.kind === 'building');
/** 打這棟建築的估計（武器、射手照現在的） */
function buildingEstimate(u: UnitView, weaponId: string | undefined, o: Obstacle): string {
  const w = u.equipment.find((x) => x.id === weaponId);
  const def = w && EQUIPMENT[w.defId];
  if (!def) return '';
  const h = buildingHitChance(u, PILOTS[u.pilotId!]?.skill ?? 0, def, o, view!.state.obstacles, CHASSIS[u.chassisId].aim, view!.state.stance[u.id] === 'melee');
  const hp = `剩 ${o.levels} 層，頂層耐久 ${topHp(o)}/${levelHp(o)}`;
  if (!h) return `${def.fire ? '導引武器打不了建築' : '打不到（射程、射界或射擊線）'}（${hp}）`;
  return `${chanceText(h.chance)}，每發 ${Math.round((def.damage ?? 0) * BUILDING_TYPE_MULT[def.damageType ?? 'kinetic'])} 點（${hp}）`;
}

// ---- 感應武器（炮群） ----

const podGear = (u: UnitView) => u.equipment.filter((e) => !!psycommuOf(e));
/** 找炮群（id 是那件感應武器的 id）：先找現在的，再找動畫開始前的 */
function podById(id: string, includeDocked = false): { u: UnitView; e: EquipState } | null {
  for (const list of [view?.state.units ?? [], show?.prevUnits ?? []])
    for (const u of list) {
      const e = u.equipment.find((x) => x.id === id && (includeDocked || !!x.pod));
      if (e) return { u, e };
    }
  return null;
}
/** 炮群的名稱：有線臂寫手臂部位（右臂），無線寫武器名 */
const podName = (u: UnitView, e: EquipState) => (psycommuOf(e)?.wired && e.host ? `有線臂（${u.parts[e.host]?.name ?? e.host}）` : EQUIPMENT[e.defId].name);
/** 看得到的敵方炮群（母機可能看不到） */
const enemyPod = (id: string) => view?.state.enemyPods?.find((p) => p.id === id);
const enemyPodName = (p: NonNullable<ReturnType<typeof enemyPod>>) => (p.wired ? `有線臂（${p.part ?? ''}）` : EQUIPMENT[p.defId].name);
function podLabel(id: string): string | undefined {
  const f = podById(id, true);
  if (f) return `${f.u.label.split(' ')[0]} ${podName(f.u, f.e)}`;
  const p = enemyPod(id);
  return p ? `${p.label.split(' ')[0]} ${enemyPodName(p)}` : undefined;
}
/** 炮群現在能不能指揮（客戶端估計，和規則同一套條件） */
function podIssue(u: UnitView, e: EquipState): string | null {
  const ps = psycommuOf(e)!;
  if (!e.pod) return '沒有放出去';
  if (u.blackout) return '駕駛黑視，無法指揮';
  if (Math.hypot(u.pos.x - e.pod.pos.x, u.pos.y - e.pod.pos.y) > ps.range + 1e-6) return '離母機太遠，失去控制';
  if (e.pod.charge !== undefined && e.pod.charge <= 0) return '能量用完，要收回充能';
  return null;
}
const inGrapple = (id: string) => !!view?.state.grapples.some((g) => g.a === id || g.b === id);
const equipName = (u: UnitView | undefined, eqId: string | null) => {
  if (!eqId) return '空手';
  const e = u?.equipment.find((x) => x.id === eqId);
  return e ? EQUIPMENT[e.defId].name : eqId;
};

/** 一次射擊的期望傷害係數（傷害 × 發數），挑追擊預設武器用 */
function weaponPower(u: UnitView, eqId: string): number {
  const e = u.equipment.find((x) => x.id === eqId);
  const d = e ? EQUIPMENT[e.defId] : undefined;
  return (d?.damage ?? 1) * (d?.shots ?? 1);
}

function initialMove(u: UnitView): MovePlan {
  return { maneuver: cruiseManeuver(u), stance: 'shoot', facingOffset: 0, limiter: false };
}

/** 套用規劃中的換武器後，手上會拿著什麼 */
function equipmentAfterSwap(u: UnitView, plan: ActionPlan | undefined): EquipState[] {
  const eq = structuredClone(u.equipment);
  if (!plan) return eq;
  for (const [hand, equip] of swapOrders(plan)) {
    for (const e of eq) if (e.location === hand) e.location = e.home ?? 'stowed';
    const next = eq.find((e) => e.id === equip);
    if (next) next.location = hand;
  }
  return eq;
}

function heldAfter(u: UnitView, plan: ActionPlan | undefined, hand: Hand): EquipState | null {
  if (!handUsable(u, hand)) return null;
  return equipmentAfterSwap(u, plan).find((e) => e.location === hand && equipAlive(u, e)) ?? null;
}

// ---------- 畫面：地圖（透視相機） ----------

const canvas = document.getElementById('map') as HTMLCanvasElement;
const g = canvas.getContext('2d')!;
const cam = new Camera(config.MAP_SIZE);
/** 畫布的 CSS 像素尺寸 */
let W = 800;
let H = 600;
/** 機體浮在地面上的視覺高度（規則上不存在，只用來表現） */
/** 效果與連線的高度：雷達式畫在地面上 */
const UNIT_Z = 0;
/** 一層樓畫多高（世界座標；規則上 1 層約等於一台機體的高度） */
const LEVEL_H = 0.8;
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

/** 要在地圖上點位置的道具：煙霧彈、氣球、地雷、路障 */
type PlacedKind = 'smoke' | 'decoy' | 'mine' | 'barricade';
const PLACED: string[] = ['smoke', 'decoy', 'mine', 'barricade'];
const placed = (a: ActionPlan['action'] | undefined): a is Extract<ActionPlan['action'], { type: PlacedKind }> => !!a && PLACED.includes(a.type);

/** 依世界座標畫折線（看不到的點會斷開） */
function polyWorld(points: ([number, number, number] | null)[]) {
  g.beginPath();
  let open = false;
  for (const pt of points) {
    if (!pt) {
      open = false;
      continue;
    }
    const [x, y, z] = pt;
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
    const at = shownPose(u).pos;
    const top = pr(at.x, at.y, UNIT_Z);
    const base = pr(at.x, at.y, 0);
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
  grab(sx, sy) {
    // 面向把手：選取中的機體前方的小圓點，拖曳轉向
    const sel = selected ? unitView(selected) : undefined;
    const h = sel ? facingHandle(sel) : null;
    if (sel && h) {
      const p = pr(h.knob.x, h.knob.y, UNIT_Z);
      if (p.visible && Math.hypot(p.x - sx, p.y - sy) < 14) {
        faceDrag = sel.id;
        return true;
      }
    }
    // 噴射：在落點範圍裡按下＝選落點，接著拖曳＝面向
    const jp = sel ? moveDrafts[sel.id] : undefined;
    if (sel && jp?.jump && commands(sel) && !view?.submitted[view.you]) {
      const w = cam.unproject(sx, sy);
      const from = coastEnd(sel);
      if (w && Math.hypot(w.x - from.x, w.y - from.y) <= config.JUMP_RANGE) {
        jp.jump.to = { x: Math.round(w.x * 10) / 10, y: Math.round(w.y * 10) / 10 };
        faceDrag = sel.id;
        touched.add(sel.id);
        renderPanel();
        return true;
      }
    }
    if (!view || show || view.phase !== 'deploy' || view.submitted[view.you]) return false;
    const hit = unitAt(sx, sy);
    if (!hit || !commands(hit) || !deployDrafts[hit.id]) return false;
    dragging = hit.id;
    selected = hit.id;
    renderAll();
    return true;
  },
  dragTo(sx, sy) {
    if (faceDrag) {
      const u = unitView(faceDrag);
      const h = u ? facingHandle(u) : null;
      const w = cam.unproject(sx, sy);
      if (h && w && Math.hypot(w.x - h.center.x, w.y - h.center.y) > 0.05) {
        h.set(Math.round(Math.atan2(w.y - h.center.y, w.x - h.center.x) / DEG));
        touched.add(faceDrag);
        renderPanel();
      }
      return;
    }
    const d = dragging ? deployDrafts[dragging] : undefined;
    const w = cam.unproject(sx, sy);
    if (!d || !w) return;
    const z = deployZone(view!.you);
    d.x = Math.round(Math.max(z.x0, Math.min(z.x1, w.x)) * 10) / 10;
    d.y = Math.round(Math.max(z.y0, Math.min(z.y1, w.y)) * 10) / 10;
  },
  drop() {
    if (dragging) touched.add(dragging);
    dragging = null;
    faceDrag = null;
    renderAll();
  },
  onClick(sx, sy) {
    const hit = unitAt(sx, sy);
    const sel = selected ? unitView(selected) : undefined;
    const plan = sel ? actionDrafts[sel.id] : undefined;
    // 炮群：點地圖（或點機體）選移動目標點
    if (view && !show && (view.phase === 'move' || view.phase === 'ace') && podPick && sel?.id === podPick.unit && moveDrafts[sel.id] && !view.submitted[view.you]) {
      const w = hit ? hit.pos : cam.unproject(sx, sy);
      if (w) {
        const m = moveDrafts[sel.id];
        m.pods = { ...m.pods, [podPick.equip]: { to: { x: Math.round(w.x * 10) / 10, y: Math.round(w.y * 10) / 10 } } };
        podPick = null;
        touched.add(sel.id);
        renderPanel();
      }
      return;
    }
    // 煙霧彈、氣球、地雷、路障：點地圖（或點機體）選位置
    if (view && !show && view.phase === 'action' && sel && commands(sel) && plan && placed(plan.action) && !view.submitted[view.you]) {
      const w = hit ? hit.pos : cam.unproject(sx, sy);
      if (w) {
        plan.action.at = { x: Math.round(w.x * 10) / 10, y: Math.round(w.y * 10) / 10 };
        touched.add(sel.id);
        renderPanel();
      }
      return;
    }
    // 點到看得到的敵方炮群、或建築：當射擊目標
    if (view && !show && view.phase === 'action' && sel && commands(sel) && plan?.action.type === 'shoot' && !view.submitted[view.you]) {
      const w = cam.unproject(sx, sy);
      const p = w && (view.state.enemyPods ?? []).find((x) => Math.hypot(x.pos.x - w.x, x.pos.y - w.y) < 0.8);
      if (p && !hit) {
        setTarget(sel.id, p.id);
        return;
      }
      const b = w && !hit && view.state.obstacles.find((o) => o.kind === 'building' && o.levels && inFootprint(o, w, 0.2));
      if (b) {
        setTarget(sel.id, b.id);
        return;
      }
    }
    if (!view || !hit || show) return;
    if (view.phase === 'action' && sel && commands(sel) && plan && plan.action.type !== 'none' && hit.owner !== view.you && hit.status === 'active' && !hit.hidden && !view.submitted[view.you]) {
      setTarget(sel.id, hit.id);
      return;
    }
    selected = hit.id;
    renderAll();
  },
  onHover(sx, sy) {
    mouseScreen = { x: sx, y: sy };
    const hit = unitAt(sx, sy);
    hoverUnit = hit?.id ?? null;
    canvas.style.cursor = hit ? 'pointer' : 'grab';
  },
  onLeave() {
    mouseScreen = null;
    hoverUnit = null;
  },
});

function drawFrame(now: number) {
  requestAnimationFrame(drawFrame);
  g.clearRect(0, 0, W, H);
  drawGround();
  updateHoverCard();
  if (!view) return;
  drawObjectives();
  if (!show) {
    if (view.phase === 'deploy') {
      drawDeployZones();
      drawFacingHandle();
    }
    else {
      drawBarrages();
      drawRanges();
      drawReach();
      drawPreviews();
    }
    drawUnits(view.state.units.map((u) => ({ u, ...shownPose(u) })));
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
      // 移動中爬上樓頂、從樓頂落下：照時間點改高度
      const lift = beat.events.filter((x): x is Extract<GameEvent, { type: 'elevate' }> => x.type === 'elevate' && x.unit === e.unit && x.t <= mp.t).pop();
      if (p) over.set(e.unit, { ...show.display.get(e.unit)!, x: p.x, y: p.y, f: p.f, ...(lift ? { z: lift.z } : {}) });
      g.strokeStyle = 'rgba(255,255,255,0.14)';
      polyWorld(e.samples.map((smp) => (smp ? [smp[0], smp[1], 0] : null)));
      g.stroke();
    }
    drawShowUnits(over);
    if (mp.pause !== null) drawContact(beat, mp.pause, mp.pauseP, over);
    else drawBanner('同時移動中…');
    return;
  }
  if (beat?.kind === 'grapple' || beat?.kind === 'lunge') {
    const k = Math.min(1, elapsed / (beat.kind === 'lunge' ? LUNGE_DASH_MS : 700));
    for (const e of beat.events) {
      if (e.type !== 'reposition') continue;
      const d = show.display.get(e.unit)!;
      const drop = beat.events.find((x): x is Extract<GameEvent, { type: 'elevate' }> => x.type === 'elevate' && x.unit === e.unit);
      over.set(e.unit, { ...d, x: d.x + (e.to.x - d.x) * k, y: d.y + (e.to.y - d.y) * k, ...(drop ? { z: (d.z ?? 0) + (drop.z - (d.z ?? 0)) * k * k } : {}) });
    }
  }
  drawShowUnits(over);
  if (beat) drawBeatEffect(beat, elapsed, over);
}

const posOf = (id: string, over: Map<string, Disp>): Disp | undefined => {
  const d = over.get(id) ?? show?.display.get(id);
  if (d) return d;
  const pos = podById(id)?.e.pod?.pos ?? enemyPod(id)?.pos;
  return pos ? { x: pos.x, y: pos.y, f: 0, status: 'active' } : undefined;
};
/** 效果用的位置：機體浮空標記的高度 */
const fx = (v: Vec) => pr(v.x, v.y, UNIT_Z);

function drawShowUnits(over: Map<string, Disp>) {
  drawUnits(
    show!.prevUnits.map((u) => {
      const d = posOf(u.id, over)!;
      // 看不到的敵機：移動中被看到的那幾段照常畫，其餘時間是殘影
      return { u: { ...u, status: d.status, z: d.z, hidden: u.hidden && !over.has(u.id) }, pos: d, f: d.f };
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
  const tag = e.exposed ? ' 外露！' : e.typed === 'weak' ? ' 弱點！' : e.typed === 'resist' ? ' 抵抗' : '';
  return [`-${e.amount} ${part}${tag}${e.destroyed ? ' 破壞！' : ''}`, e.destroyed ? '#ff5d5d' : e.typed === 'weak' ? '#ff7a3d' : e.typed === 'resist' ? '#a8c8e8' : '#ffb347'];
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
    if (e.type === 'contact' || e.type === 'obstacle') current = e.t;
    if (e.type !== 'contact' && current === pause) related.push(e);
  }
  // 撞上隕石：橘色衝擊圈
  for (const e of related) {
    if (e.type !== 'obstacle') continue;
    const at = posOf(e.unit, over);
    if (!at) continue;
    g.strokeStyle = `rgba(255,138,61,${1 - p})`;
    g.lineWidth = 4;
    ringWorld(at.x, at.y, 0.4 + p * 1.2, UNIT_Z);
    g.stroke();
    g.lineWidth = 1;
    drawBanner(describe(e) ?? '');
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
        if (cl.caught) drawFloat(def, '拖住！', '#c9a8ff', p, 3);
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

/** 突進衝過去的時間 */
const LUNGE_DASH_MS = 400;

function drawBeatEffect(beat: Beat, elapsed: number, over: Map<string, Disp>) {
  const head = beat.events[0];
  const text = describe(head);
  if (text && beat.kind !== 'note') drawBanner(text);
  if (head.type === 'buildingShot') {
    // 射擊建築：從射手拉一條火線到建築，打中的話建築那頭閃一下
    const a = head.attacker ? posOf(head.attacker, over) : null;
    const o = view?.state.obstacles.find((x) => x.id === head.obstacle);
    if (a && o) {
      const p = Math.min(1, elapsed / 500);
      const at = buildingAim(o, a);
      g.strokeStyle = `rgba(255,170,80,${1 - p * 0.6})`;
      g.lineWidth = 2;
      polyWorld([
        [a.x, a.y, UNIT_Z],
        [at.x, at.y, UNIT_Z * 0.8],
      ]);
      g.stroke();
      g.lineWidth = 1;
      if (head.hits) dotAt(pr(at.x, at.y, UNIT_Z * 0.8), 6 + p * 12, `rgba(255,150,60,${1 - p})`);
    }
  }
  if (head.type === 'shot') {
    const a = head.from ?? posOf(head.attacker, over)!;
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
    for (const b of beat.events) {
      if (b.type !== 'blast') continue;
      const k = (elapsed - shotLandTime(head.shots - 1)) / 700;
      if (k < 0 || k > 1) continue;
      g.strokeStyle = `rgba(255,150,60,${1 - k})`;
      g.lineWidth = 3;
      ringWorld(b.at.x, b.at.y, 0.3 + k * config.MORTAR_SPLASH_RADIUS, UNIT_Z * 0.3);
      g.stroke();
      g.lineWidth = 1;
      drawFloat(b.at, '散布', '#ffb070', k, 1);
    }
    drawDamageFloats(beat.events.slice(1), shotLandTime(head.shots - 1), elapsed, over);
  } else if (head.type === 'mark' && !posOf(head.unit, over)) {
    // 看不到是誰標定的：只在目標身上閃一下
    drawFloat(posOf(head.target, over)!, '被標定！', '#ffb060', elapsed / 900);
  } else if (head.type === 'launch') {
    const a = posOf(head.attacker, over);
    const t = posOf(head.target, over);
    if (a && t) {
      const k = Math.min(1, elapsed / 600);
      g.strokeStyle = 'rgba(255,190,90,0.9)';
      g.setLineDash([7, 5]);
      polyWorld([
        [a.x, a.y, UNIT_Z],
        [a.x + (t.x - a.x) * k, a.y + (t.y - a.y) * k, UNIT_Z],
      ]);
      g.stroke();
      g.setLineDash([]);
      if (k >= 1) drawFloat(t, '下回合命中', '#ffbe5a', (elapsed - 600) / 300);
    }
  } else if (head.type === 'lock' || head.type === 'mark') {
    const a = posOf(head.unit, over)!;
    const t = posOf(head.target, over)!;
    const k = Math.min(1, elapsed / 500);
    g.strokeStyle = head.type === 'mark' ? 'rgba(255,170,80,0.9)' : 'rgba(120,220,255,0.8)';
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
  } else if (head.type === 'lunge') {
    const end = posOf(head.unit, over)!;
    g.strokeStyle = head.jump ? 'rgba(255,200,90,0.85)' : 'rgba(255,120,120,0.85)';
    g.setLineDash([4, 4]);
    polyWorld([
      [head.from.x, head.from.y, UNIT_Z],
      [end.x, end.y, UNIT_Z],
    ]);
    g.stroke();
    g.setLineDash([]);
    const p = (elapsed - LUNGE_DASH_MS) / 900;
    const cl = beat.events.find((e): e is Extract<GameEvent, { type: 'clash' }> => e.type === 'clash');
    if (cl && p >= 0) {
      const att = posOf(cl.attacker, over)!;
      const def = posOf(cl.defender, over)!;
      if (cl.winner === cl.attacker) drawSlash(def, att, Math.min(1, p), 'hit');
      else if (cl.winner && cl.damage) drawSlash(att, def, Math.min(1, p), 'counter');
      else drawSlash(def, att, Math.min(1, p), cl.winner ? (cl.defense === 'shield' ? 'blocked' : 'dodged') : 'tie');
      if (p > 0.25) drawBanner(clashText(cl));
    }
    drawDamageFloats(beat.events.slice(1), LUNGE_DASH_MS + 250, elapsed, over);
  } else if (head.type === 'deploy') {
    drawFloat(posOf(head.unit, over)!, head.up ? '展開盾牆' : '收起盾牌', '#f2e27a', elapsed / 800);
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

function sampleAt(samples: ([number, number, number] | null)[] | undefined, t: number): (Vec & { f: number }) | null {
  if (!samples) return null;
  const idx = Math.min(samples.length - 1, t * (samples.length - 1));
  const i = Math.floor(idx);
  const j = Math.min(samples.length - 1, i + 1);
  const k = idx - i;
  const a = samples[i];
  const b = samples[j];
  // 這一刻看不到這台敵機
  if (!a || !b) return null;
  const [x0, y0, f0] = a;
  const [x1, y1, f1] = b;
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
  for (const o of view?.state.obstacles ?? []) if (o.kind === 'field') drawField(o);
  // 由遠到近畫，近的蓋在遠的上面（旋轉視角後順序才不會錯）
  (view?.state.obstacles ?? [])
    .filter((o) => o.kind === 'rock')
    .map((o) => ({ o, k: pr(o.x, o.y, 0).k }))
    .sort((a, b) => a.k - b.k)
    .forEach(({ o }) => drawRock(o));
  for (const o of view?.state.obstacles ?? []) if (o.kind === 'smoke') drawSmoke(o);
  drawBalloons();
  drawMines();
  drawJamming();
}

/** 知道的地雷：自己埋的，加上我方機體附近發現的敵方地雷 */
function drawMines() {
  for (const m of view?.state.mines ?? []) {
    const c = pr(m.x, m.y, 0);
    if (!c.visible) continue;
    g.strokeStyle = color(m.owner, 0.9);
    g.lineWidth = 2;
    const k = 5;
    g.beginPath();
    g.moveTo(c.x - k, c.y - k);
    g.lineTo(c.x + k, c.y + k);
    g.moveTo(c.x + k, c.y - k);
    g.lineTo(c.x - k, c.y + k);
    g.stroke();
    g.lineWidth = 1;
    g.fillStyle = color(m.owner, 0.9);
    g.font = '11px sans-serif';
    g.textAlign = 'center';
    g.fillText(m.owner === view!.you ? '我方地雷' : '地雷', c.x, c.y - 8);
  }
}

/** 開著電子干擾的機體：畫出干擾範圍 */
function drawJamming() {
  for (const u of view?.state.units ?? []) {
    if (u.hidden || !ecmOf(u as never)) continue;
    g.strokeStyle = color(u.owner, 0.35);
    g.setLineDash([2, 4]);
    ringWorld(u.pos.x, u.pos.y, config.ECM_RADIUS, 0, 0, Math.PI * 2, 72);
    g.stroke();
    g.setLineDash([]);
  }
}

/** 凸包（Andrew 演算法），畫隕石的側面輪廓用 */
function hull(pts: Vec[]): Vec[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Vec, a: Vec, b: Vec) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec[] = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** 大隕石：有高度的岩塊，側面用上下兩圈的凸包填起來 */
/** 煙霧：灰色的圓，標示還剩幾回合 */
function drawSmoke(o: Obstacle) {
  g.fillStyle = 'rgba(150,150,145,0.32)';
  g.strokeStyle = 'rgba(200,200,195,0.5)';
  ringWorld(o.x, o.y, o.r, 0.6, 0, Math.PI * 2, 40);
  g.fill();
  g.stroke();
  const c = pr(o.x, o.y - o.r - 0.3, 0.6);
  if (!c.visible || !view) return;
  g.fillStyle = 'rgba(220,220,215,0.85)';
  g.font = '11px sans-serif';
  g.textAlign = 'center';
  g.fillText(`煙霧（剩 ${Math.max(1, (o.until ?? view.state.turn) - view.state.turn + 1)} 回合）`, c.x, c.y);
}

/** 欺敵氣球：看得出是氣球的（自己的全部看得到） */
function drawBalloons() {
  for (const b of view?.state.balloons ?? []) {
    const top = pr(b.pos.x, b.pos.y, UNIT_Z + 0.5);
    const base = pr(b.pos.x, b.pos.y, 0);
    if (!top.visible) continue;
    g.strokeStyle = color(b.owner, 0.7);
    g.setLineDash([2, 2]);
    g.beginPath();
    g.ellipse(top.x, top.y, Math.max(5, top.k * 0.25), Math.max(6, top.k * 0.32), 0, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.beginPath();
    g.moveTo(top.x, top.y + Math.max(6, top.k * 0.32));
    g.lineTo(base.x, base.y);
    g.stroke();
    g.fillStyle = color(b.owner, 0.85);
    g.font = '11px sans-serif';
    g.textAlign = 'center';
    g.fillText(b.owner === view!.you ? '我方氣球' : '氣球', top.x, top.y - 10);
  }
}

/** 煙霧彈、氣球、地雷、路障的預覽：可放的範圍與位置 */
function drawUtilityPreview(u: UnitView, kind: PlacedKind, at: Vec) {
  const reach = { smoke: config.SMOKE_THROW_RANGE, decoy: config.DECOY_PLACE_RANGE, mine: config.MINE_LAY_RANGE, barricade: config.BARRICADE_RANGE }[kind] + radiusOf(u);
  g.strokeStyle = 'rgba(255,207,74,0.45)';
  g.setLineDash([3, 5]);
  ringWorld(u.pos.x, u.pos.y, reach, 0, 0, Math.PI * 2, 64);
  g.stroke();
  g.setLineDash([]);
  if (!Number.isFinite(at.x)) return;
  g.strokeStyle = 'rgba(255,207,74,0.95)';
  g.lineWidth = 2;
  if (kind === 'barricade') {
    // 路障：長方形的矮牆
    const w = barricadeWall(u.pos, at, '');
    polyWorld([
      [w.x - w.hx, w.y - w.hy, 0],
      [w.x + w.hx, w.y - w.hy, 0],
      [w.x + w.hx, w.y + w.hy, 0],
      [w.x - w.hx, w.y + w.hy, 0],
      [w.x - w.hx, w.y - w.hy, 0],
    ]);
  } else ringWorld(at.x, at.y, kind === 'smoke' ? config.SMOKE_RADIUS : kind === 'mine' ? config.MINE_RADIUS : 0.5, 0, 0, Math.PI * 2, 40);
  g.stroke();
  g.lineWidth = 1;
}

function drawRock(o: Obstacle) {
  const height = 1.2 + o.r * 0.4;
  const ring = (z: number) => Array.from({ length: 28 }, (_, i) => pr(o.x + Math.cos((i / 28) * Math.PI * 2) * o.r, o.y + Math.sin((i / 28) * Math.PI * 2) * o.r, z)).filter((q) => q.visible);
  const body = hull([...ring(0), ...ring(height)]);
  if (body.length < 3) return;
  const town = view?.state.settings.terrain === 'town';
  g.fillStyle = town ? '#3a3f46' : '#3d3630';
  g.strokeStyle = town ? '#59616b' : '#5c5048';
  g.beginPath();
  body.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = town ? '#5a626c' : '#5e544b';
  ringWorld(o.x, o.y, o.r * 0.92, height, 0, Math.PI * 2, 28);
  g.fill();
}

/** 建築：長方體，側面由遠到近畫，樓頂比較亮並標出層數 */
function drawBuilding(o: Obstacle) {
  const top = o.levels! * LEVEL_H;
  const x0 = o.x - o.hx!;
  const x1 = o.x + o.hx!;
  const y0 = o.y - o.hy!;
  const y1 = o.y + o.hy!;
  const sides: [number, number, number, number][] = [
    [x0, y0, x1, y0],
    [x1, y0, x1, y1],
    [x1, y1, x0, y1],
    [x0, y1, x0, y0],
  ];
  const face = (pts: [number, number, number][]) => {
    const q = pts.map(([x, y, z]) => pr(x, y, z));
    if (q.some((p) => !p.visible)) return false;
    g.beginPath();
    q.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    return true;
  };
  g.strokeStyle = '#59616b';
  sides
    .map((sd) => ({ sd, k: pr((sd[0] + sd[2]) / 2, (sd[1] + sd[3]) / 2, top / 2).k }))
    .sort((a, b) => a.k - b.k)
    .forEach(({ sd: [ax, ay, bx, by] }, i) => {
      if (!face([[ax, ay, 0], [bx, by, 0], [bx, by, top], [ax, ay, top]])) return;
      g.fillStyle = i < 2 ? '#2a2f35' : '#343a41';
      g.fill();
      g.stroke();
    });
  if (face([[x0, y0, top], [x1, y0, top], [x1, y1, top], [x0, y1, top]])) {
    g.fillStyle = '#4c545d';
    g.fill();
    g.strokeStyle = '#7a848f';
    g.stroke();
  }
  const c = pr(o.x, o.y, top);
  if (!c.visible) return;
  g.fillStyle = 'rgba(205,212,220,0.85)';
  g.font = `${Math.round(Math.max(10, Math.min(13, c.k * 0.3)))}px sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // 被打過的建築：標出頂層剩的耐久
  g.fillText(`${o.levels} 層${o.hp !== undefined ? `（${o.hp}/${levelHp(o)}）` : ''}`, c.x, c.y);
  g.textBaseline = 'alphabetic';
}

/** 隕石群：地上一圈虛線，加上散在空中的碎石點（位置由 id 固定） */
function drawField(o: Obstacle) {
  g.strokeStyle = 'rgba(180,160,130,0.35)';
  g.setLineDash([4, 4]);
  ringWorld(o.x, o.y, o.r, 0, 0, Math.PI * 2, 48);
  g.stroke();
  g.setLineDash([]);
  let seed = [...o.id].reduce((h, c) => h * 31 + c.charCodeAt(0), 7);
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  g.fillStyle = view?.state.settings.terrain === 'forest' ? 'rgba(90,150,90,0.8)' : 'rgba(170,150,125,0.75)';
  for (let i = 0; i < Math.round(o.r * 9); i++) {
    const a = rnd() * Math.PI * 2;
    const d = Math.sqrt(rnd()) * o.r;
    const q = pr(o.x + Math.cos(a) * d, o.y + Math.sin(a) * d, 0.2 + rnd() * 1.1);
    if (!q.visible) continue;
    g.beginPath();
    g.arc(q.x, q.y, Math.max(1, q.k * (0.04 + rnd() * 0.06)), 0, Math.PI * 2);
    g.fill();
  }
}

/** 由遠到近畫，近的蓋在遠的上面 */
function drawUnits(list: { u: UnitView; pos: Vec; f: number }[]) {
  // 建築和機體一起由遠到近畫：建築後面的機體會被擋住，樓頂上的機體畫在那棟樓之後
  const blds = (view?.state.obstacles ?? []).filter((o) => o.kind === 'building').map((o) => ({ o, k: pr(o.x, o.y, 0).k }));
  const items: { k: number; draw: () => void }[] = blds.map(({ o, k }) => ({ k, draw: () => drawBuilding(o) }));
  for (const x of list) {
    let k = pr(x.pos.x, x.pos.y, 0).k;
    const z = x.u.z ?? 0;
    if (z) for (const b of blds) if (b.o.levels! <= z && wallPenetration(b.o, x.pos, radiusOf(x.u)) > 0) k = Math.max(k, b.k + 1e-6);
    items.push({ k, draw: () => drawUnit(x.u, x.pos, x.f) });
  }
  items.sort((a, b) => a.k - b.k).forEach((x) => x.draw());
  drawPods(list);
  if (!show) drawEnemyPods();
}

/** 看得到的敵方炮群：畫法和自己的一樣，母機看不到就不畫連回母機的線 */
function drawEnemyPods() {
  for (const p of view?.state.enemyPods ?? []) {
    const mother = unitView(p.mother);
    const ghost: UnitView = {
      ...(mother ?? { id: p.mother, owner: p.owner, label: p.label, chassisId: '', parts: {}, status: 'active', momentum: 0, vague: null }),
      equipment: [{ id: p.id, defId: p.defId, location: 'builtin', pod: { pos: p.pos }, bits: p.bits }],
    } as UnitView;
    drawPods([{ u: ghost, pos: mother && !mother.hidden ? mother.pos : p.pos }]);
  }
}

/** 炮群：無線的是一簇光點（支數）加能量格，線控臂是小方塊加連回母機的虛線 */
function drawPods(list: { u: UnitView; pos: Vec }[]) {
  for (const { u, pos } of list) {
    if (u.status !== 'active') continue;
    for (const e of u.equipment) {
      if (!e.pod) continue;
      const ps = psycommuOf(e);
      if (!ps) continue;
      const at = e.pod.pos;
      const c = pr(at.x, at.y, 0);
      if (!c.visible) continue;
      const k = Math.max(1, c.k * 0.06);
      const rgb = u.owner === 0 ? '133,183,235' : '240,149,149';
      const light = u.owner === 0 ? '#b5d4f4' : '#f7c1c1';
      g.font = '11px sans-serif';
      g.textAlign = 'center';
      if (ps.wired) {
        g.strokeStyle = `rgba(${rgb},0.7)`;
        g.setLineDash([3, 3]);
        polyWorld([
          [pos.x, pos.y, 0],
          [at.x, at.y, 0],
        ]);
        g.stroke();
        g.setLineDash([]);
        const w = 9 * k;
        const h = 5 * k;
        g.fillStyle = `rgba(${rgb},0.35)`;
        g.strokeStyle = light;
        g.beginPath();
        g.rect(c.x - w, c.y - h, w * 2, h * 2);
        g.fill();
        g.stroke();
        g.fillStyle = light;
        g.fillText(podName(u, e).replace(/^有線臂（(.*)）$/, '$1'), c.x, c.y - h - 5);
        continue;
      }
      const n = Math.min(12, bitsLeft(e));
      g.fillStyle = u.owner === 0 ? '#e6f1fb' : '#fcebeb';
      for (let i = 0; i < n; i++) {
        const r = 0.12 + 0.42 * Math.sqrt((i + 0.5) / n);
        const p = pr(at.x + Math.cos(i * 2.4) * r, at.y + Math.sin(i * 2.4) * r, 0);
        g.beginPath();
        g.arc(p.x, p.y, 1.8 * k, 0, Math.PI * 2);
        g.fill();
      }
      g.strokeStyle = `rgba(${rgb},0.5)`;
      ringWorld(at.x, at.y, 0.65);
      g.stroke();
      const top = pr(at.x, at.y - 0.65, 0).y - 8 * k;
      g.fillStyle = light;
      g.fillText(`${EQUIPMENT[e.defId].name} ×${bitsLeft(e)}`, c.x, top - 6 * k);
      if (ps.charge !== undefined) {
        const left = e.pod.charge ?? ps.charge;
        const pw = 8 * k;
        for (let i = 0; i < ps.charge; i++) {
          const x = c.x - (ps.charge * (pw + 3)) / 2 + i * (pw + 3);
          g.fillStyle = i < left ? `rgba(${rgb},0.9)` : `rgba(${rgb},0.2)`;
          g.fillRect(x, top - 2, pw, 3);
        }
      }
    }
  }
}

/** 戰艦的防禦彈幕範圍（艦首與兩舷；艦尾沒有） */
function drawBarrages() {
  for (const sh of view?.state.units ?? []) {
    if (!isShip(sh) || sh.status !== 'active' || sh.hidden) continue;
    const def = CHASSIS[sh.chassisId].barrage;
    if (!def || !barrageStrength(sh as never)) continue;
    const active = barrageActive(view!.state.units as never, sh as never);
    const r = radiusOf(sh) + def.range;
    const rear = (config.BARRAGE_REAR_DEG * Math.PI) / 180;
    g.fillStyle = color(sh.owner, active ? 0.1 : 0.03);
    g.strokeStyle = color(sh.owner, active ? 0.6 : 0.25);
    g.setLineDash(active ? [] : [3, 6]);
    g.beginPath();
    const c = pr(sh.pos.x, sh.pos.y, 0);
    g.moveTo(c.x, c.y);
    for (let i = 0; i <= 40; i++) {
      const a = sh.facing - (Math.PI - rear) + (2 * (Math.PI - rear) * i) / 40;
      const q = pr(sh.pos.x + Math.cos(a) * r, sh.pos.y + Math.sin(a) * r, 0);
      g.lineTo(q.x, q.y);
    }
    g.closePath();
    g.fill();
    g.stroke();
    g.setLineDash([]);
  }
}

/** 移動預測：照目前選的機動，會撞牆、撞隕石、開出地圖或和隊友擦撞的地方畫紅圈 */
function moveWarnings(): MoveWarning[] {
  if (!view || (view.phase !== 'move' && view.phase !== 'ace') || view.submitted[view.you]) return [];
  const mine = ownUnits().filter((u) => u.status === 'active' && !inGrapple(u.id));
  return forecastMoves(mine, moveDrafts, view.state.obstacles);
}

function drawMoveWarnings() {
  for (const w of moveWarnings()) {
    const c = pr(w.at.x, w.at.y, 0);
    if (!c.visible) continue;
    g.strokeStyle = w.kind === 'ally' ? 'rgba(255,93,93,0.95)' : 'rgba(255,150,60,0.95)';
    g.lineWidth = 2;
    ringWorld(w.at.x, w.at.y, 0.6, 0, 0, Math.PI * 2, 24);
    g.stroke();
    g.lineWidth = 1;
    g.fillStyle = g.strokeStyle;
    g.font = '11px sans-serif';
    g.textAlign = 'center';
    g.fillText(w.kind === 'ally' ? '擦撞' : w.kind === 'offmap' ? '出界' : '撞牆', c.x, c.y - 10);
  }
}

/** 炮群的指令預覽：選取母機時畫控制距離（以移動後位置為中心）、炮群的移動範圍；已下的移動指令畫黃色虛線 */
function drawPodPlans() {
  if (view?.phase === 'move' || view?.phase === 'ace') {
    for (const [id, plan] of Object.entries(moveDrafts)) {
      const u = unitView(id);
      if (!u || !podGear(u).length) continue;
      const end = plan.defer || inGrapple(id) ? u.pos : worldPose(buildPath(u, plan), 1).pos;
      const sel = id === selected;
      for (const e of podGear(u)) {
        const ps = psycommuOf(e)!;
        const order = plan.pods?.[e.id];
        const from = e.pod?.pos ?? end;
        if (sel && (e.pod || podPick?.equip === e.id || (order && 'to' in order))) {
          g.strokeStyle = 'rgba(133,183,235,0.35)';
          g.setLineDash([4, 5]);
          ringWorld(end.x, end.y, ps.range, 0, 0, Math.PI * 2, 72);
          g.stroke();
          g.setLineDash([2, 4]);
          g.strokeStyle = 'rgba(133,183,235,0.25)';
          ringWorld(from.x, from.y, ps.move, 0, 0, Math.PI * 2, 64);
          g.stroke();
          g.setLineDash([]);
        }
        if (!order) continue;
        g.strokeStyle = sel ? 'rgba(255,207,74,0.9)' : 'rgba(255,207,74,0.45)';
        g.setLineDash([4, 3]);
        if ('recall' in order) {
          if (e.pod)
            polyWorld([
              [e.pod.pos.x, e.pod.pos.y, 0],
              [end.x, end.y, 0],
            ]);
          g.stroke();
          g.setLineDash([]);
          continue;
        }
        const dest = podDestination(from, order.to, end, ps);
        polyWorld([
          [from.x, from.y, 0],
          [dest.x, dest.y, 0],
        ]);
        g.stroke();
        g.setLineDash([]);
        ringWorld(dest.x, dest.y, 0.3);
        g.stroke();
      }
    }
  } else if (view?.phase === 'action') {
    for (const [id, plan] of Object.entries(actionDrafts)) {
      const u = unitView(id);
      if (!u) continue;
      for (const tid of Object.values(plan.salvo ?? {})) {
        const t = unitView(tid);
        if (!t) continue;
        g.strokeStyle = 'rgba(255,170,90,0.75)';
        g.setLineDash([3, 5]);
        polyWorld([
          [u.pos.x, u.pos.y, 0],
          [t.pos.x, t.pos.y, 0],
        ]);
        g.stroke();
        g.setLineDash([]);
      }
      for (const [eid, targets] of Object.entries(plan.pods ?? {})) {
        const pod = u.equipment.find((e) => e.id === eid)?.pod;
        if (!pod) continue;
        for (const tid of targets) {
          const t = unitView(tid);
          if (!t) continue;
          g.strokeStyle = 'rgba(255,207,74,0.8)';
          g.setLineDash([6, 4]);
          polyWorld([
            [pod.pos.x, pod.pos.y, 0],
            [t.pos.x, t.pos.y, 0],
          ]);
          g.stroke();
          g.setLineDash([]);
        }
      }
    }
  }
}

/** 機體名稱拆成型號與名稱：「RX-78-2 鋼彈」→ 型號 RX-78-2、名稱 鋼彈 */
function modelAndName(u: UnitView): { model: string; name: string } {
  const full = CHASSIS[u.chassisId]?.name ?? u.chassisId;
  const i = full.indexOf(' ');
  return i > 0 ? { model: full.slice(0, i), name: full.slice(i + 1) } : { model: u.chassisId, name: full };
}

/** 雷達式：地面上的光點、占用半徑外框、朝向線與盾弧，光點上方兩行標籤（編號＋名稱、型號） */
function drawUnit(u: UnitView, pos: Vec, facing: number) {
  const out = u.status !== 'active';
  const R = radiusOf(u);
  // 站在樓頂上：整個標記畫在那個高度，再拉一條虛線到地面
  const zw = (u.z ?? 0) * LEVEL_H;
  const c = pr(pos.x, pos.y, zw);
  if (!c.visible) return;
  if (zw) {
    const ground = pr(pos.x, pos.y, 0);
    g.strokeStyle = color(u.owner, 0.35);
    g.setLineDash([2, 3]);
    g.beginPath();
    g.moveTo(ground.x, ground.y);
    g.lineTo(c.x, c.y);
    g.stroke();
    g.setLineDash([]);
  }
  // 看不到的敵機：在最後目擊的位置畫成虛線殘影
  if (u.hidden) {
    g.globalAlpha = 0.45;
    g.setLineDash([3, 3]);
  }
  // 占用半徑與朝向
  g.strokeStyle = out ? '#555' : color(u.owner, 0.7);
  ringWorld(pos.x, pos.y, R, zw);
  g.stroke();
  if (!out) {
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    polyWorld([
      [pos.x, pos.y, zw],
      [pos.x + Math.cos(facing) * R * 1.5, pos.y + Math.sin(facing) * R * 1.5, zw],
    ]);
    g.stroke();
  }
  g.setLineDash([]);
  // 展開的盾牆
  const wall = !out && !u.hidden ? barrierOf({ ...u, pos, facing }) : null;
  if (wall) {
    g.strokeStyle = '#f2e27a';
    g.lineWidth = 5;
    polyWorld([
      [wall.a.x, wall.a.y, zw],
      [wall.b.x, wall.b.y, zw],
    ]);
    g.stroke();
    g.lineWidth = 1;
  }
  // 盾弧
  if (!out && !u.hidden) {
    for (const s of shieldArcs(u, facing)) {
      g.strokeStyle = '#e6e6a0';
      g.lineWidth = 3;
      ringWorld(pos.x, pos.y, R + 0.12, zw, s.center - s.half, s.center + s.half, 16);
      g.stroke();
      g.lineWidth = 1;
    }
  }
  // 光點：亮核心加兩圈淡光暈（陣營色；煙霧中的不明機體琥珀色；退場是灰色 ×）
  const k = Math.max(1, c.k * 0.06);
  const rgb = u.unknown ? '239,159,39' : u.owner === 0 ? '133,183,235' : '240,149,149';
  if (out) {
    g.strokeStyle = '#6a6a66';
    g.lineWidth = 2;
    const d = 4 * k;
    g.beginPath();
    g.moveTo(c.x - d, c.y - d);
    g.lineTo(c.x + d, c.y + d);
    g.moveTo(c.x + d, c.y - d);
    g.lineTo(c.x - d, c.y + d);
    g.stroke();
    g.lineWidth = 1;
  } else if (u.hidden) {
    g.strokeStyle = `rgba(${rgb},0.9)`;
    g.setLineDash([2, 2]);
    g.beginPath();
    g.arc(c.x, c.y, 5 * k, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
  } else {
    for (const [r, a] of [
      [11, 0.12],
      [6, 0.35],
    ] as const) {
      g.fillStyle = `rgba(${rgb},${a})`;
      g.beginPath();
      g.arc(c.x, c.y, r * k, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = u.unknown ? '#faeeda' : u.owner === 0 ? '#e6f1fb' : '#fcebeb';
    g.beginPath();
    g.arc(c.x, c.y, 2.8 * k, 0, Math.PI * 2);
    g.fill();
  }
  // 選取：四角括號
  if (u.id === selected) {
    const h = 13 * k;
    const l = 5 * k;
    g.strokeStyle = '#ffcf4a';
    g.lineWidth = 1.5;
    g.beginPath();
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      g.moveTo(c.x + sx * h, c.y + sy * (h - l));
      g.lineTo(c.x + sx * h, c.y + sy * h);
      g.lineTo(c.x + sx * (h - l), c.y + sy * h);
    }
    g.stroke();
    g.lineWidth = 1;
  }
  // 標籤
  g.textAlign = 'center';
  const flag = view?.state.settings.decapitation && view.state.flagship.includes(u.id) ? '♛' : '';
  const { model, name } = modelAndName(u);
  const id = u.label.split(' ')[0];
  const top = c.y - 14 * k;
  const light = out ? '#888780' : u.unknown ? '#fac775' : u.owner === 0 ? '#b5d4f4' : '#f7c1c1';
  const dim = out ? '#6a6a66' : u.unknown ? '#ef9f27' : u.owner === 0 ? '#85b7eb' : '#f09595';
  if (u.unknown) {
    g.font = 'bold 12px sans-serif';
    g.fillStyle = light;
    g.fillText('？不明', c.x, top);
  } else {
    g.font = 'bold 12px sans-serif';
    g.fillStyle = light;
    g.fillText(`${flag}${id} ${name}${u.z ? ` ▲${u.z}` : ''}${u.mark ? ' ◎' : ''}${u.vague === 'sluggish' ? ' ⚠' : ''}`, c.x, top - 13);
    g.font = '11px sans-serif';
    g.fillStyle = dim;
    g.fillText(out ? ({ destroyed: '擊毀', withdrawn: '脫離戰場', unconscious: '駕駛昏迷' } as Record<string, string>)[u.status] ?? '停止動作' : u.hidden ? `${model}・最後目擊 T${u.seenTurn}` : model, c.x, top);
  }
  g.globalAlpha = 1;
}

/** 地圖目標：達陣圈（畫在要攻佔它的一方的顏色）與據點（目前誰在裡面） */
function drawObjectives() {
  const set = view!.state.settings;
  g.font = '11px sans-serif';
  g.textAlign = 'center';
  const label = (x: number, y: number, text: string, colour: string) => {
    const p = pr(x, y, 0);
    if (!p.visible) return;
    g.fillStyle = colour;
    g.fillText(text, p.x, p.y + 4);
  };
  if (set.goal) {
    for (const p of [0, 1] as PlayerId[]) {
      const z = goalZone(p);
      const attacker = (1 - p) as PlayerId;
      g.strokeStyle = color(attacker, 0.85);
      g.fillStyle = color(attacker, 0.1);
      g.lineWidth = 2;
      g.setLineDash([6, 4]);
      ringWorld(z.x, z.y, GOAL_RADIUS, 0, 0, Math.PI * 2, 40);
      g.fill();
      g.stroke();
      g.setLineDash([]);
      g.lineWidth = 1;
      label(z.x, z.y, `${SIDE(attacker)} 方達陣點`, color(attacker, 0.9));
    }
  }
  if (set.supply) {
    for (const p of [0, 1] as PlayerId[]) {
      const c = supplyPoint(p);
      g.strokeStyle = color(p, 0.85);
      g.fillStyle = color(p, 0.12);
      g.lineWidth = 2;
      ringWorld(c.x, c.y, config.SUPPLY_RADIUS, 0, 0, Math.PI * 2, 40);
      g.fill();
      g.stroke();
      g.lineWidth = 1;
      label(c.x, c.y, `${SIDE(p)} 方補給點`, color(p, 0.9));
    }
  }
  if (set.control) {
    for (const c of controlPoints()) {
      const sides = new Set(view!.state.units.filter((u) => u.status === 'active' && !u.hidden && Math.hypot(u.pos.x - c.x, u.pos.y - c.y) <= CONTROL_RADIUS).map((u) => u.owner));
      const colour = sides.size === 1 ? color([...sides][0] as PlayerId, 0.85) : sides.size === 2 ? 'rgba(255,207,74,0.85)' : 'rgba(200,210,220,0.6)';
      g.strokeStyle = colour;
      g.lineWidth = 2;
      ringWorld(c.x, c.y, CONTROL_RADIUS, 0, 0, Math.PI * 2, 40);
      g.stroke();
      g.lineWidth = 1;
      label(c.x, c.y, '據點', colour);
    }
  }
}

function drawRanges() {
  const u = selected ? unitView(selected) : null;
  if (!u || u.status !== 'active') return;
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  for (const lim of [config.RANGE_LIMITS.r1, config.RANGE_LIMITS.r2, config.RANGE_LIMITS.r3]) {
    ringWorld(u.pos.x, u.pos.y, lim + radiusOf(u) + config.BASE_RADIUS, 0, 0, Math.PI * 2, 64);
    g.stroke();
  }
  if (u.owner === view!.you) {
    g.strokeStyle = 'rgba(120,200,255,0.35)';
    g.setLineDash([2, 6]);
    ringWorld(u.pos.x, u.pos.y, sensorRange(u) + radiusOf(u) + config.BASE_RADIUS, 0, 0, Math.PI * 2, 72);
    g.stroke();
    g.setLineDash([]);
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
  const R = radiusOf(u);
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

/** 勾了放煙幕的機體：在出發點畫煙幕的範圍 */
function drawSmokePreview() {
  if (!view || (view.phase !== 'move' && view.phase !== 'ace') || view.submitted[view.you]) return;
  for (const [id, plan] of Object.entries(moveDrafts)) {
    const u = plan.smoke ? unitView(id) : undefined;
    if (!u) continue;
    g.strokeStyle = 'rgba(200,200,190,0.9)';
    g.fillStyle = 'rgba(200,200,190,0.12)';
    g.setLineDash([5, 5]);
    ringWorld(u.pos.x, u.pos.y, config.SMOKE_RADIUS);
    g.fill();
    g.stroke();
    g.setLineDash([]);
    const c = pr(u.pos.x, u.pos.y + config.SMOKE_RADIUS, 0);
    if (!c.visible) continue;
    g.fillStyle = 'rgba(220,220,210,0.95)';
    g.font = '11px sans-serif';
    g.textAlign = 'center';
    g.fillText('煙幕預覽', c.x, c.y + 14);
  }
}

/** 飛行中的彈藥：我方發射的畫藍色虛線，飛向我方的畫紅色虛線並圈出目標；曲射的畫成拋物線 */
function drawInbound() {
  if (!view || show) return;
  for (const x of view.state.inbound) {
    const t = unitView(x.target);
    const a = unitView(x.attacker);
    const def = EQUIPMENT[x.defId];
    if (!t || t.hidden) continue;
    const atgm = def?.fire === 'atgm';
    const from = atgm && a && !a.hidden ? a.pos : x.from;
    const mine = x.owner === view.you;
    const color = mine ? 'rgba(80,160,240,0.95)' : 'rgba(240,80,80,0.95)';
    const lift = atgm ? 0 : Math.max(2, Math.hypot(t.pos.x - from.x, t.pos.y - from.y) * 0.25);
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= 24; i++) {
      const k = i / 24;
      pts.push([from.x + (t.pos.x - from.x) * k, from.y + (t.pos.y - from.y) * k, UNIT_Z + 4 * lift * k * (1 - k)]);
    }
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.setLineDash([7, 5]);
    polyWorld(pts);
    g.stroke();
    g.setLineDash([]);
    if (!mine) {
      ringWorld(t.pos.x, t.pos.y, radiusOf(t) + 0.45, UNIT_Z);
      g.stroke();
    }
    g.lineWidth = 1;
    const mid = pr(pts[12][0], pts[12][1], pts[12][2]);
    if (!mid.visible) continue;
    const text = `${mine ? '' : '來襲 '}${def?.name ?? x.defId}×${x.shots} 下回合${atgm ? '命中' : '落下'}`;
    g.font = '11px sans-serif';
    g.textAlign = 'center';
    const w = g.measureText(text).width + 10;
    g.fillStyle = mine ? 'rgba(16,40,70,0.9)' : 'rgba(70,16,16,0.9)';
    g.fillRect(mid.x - w / 2, mid.y - 18, w, 16);
    g.fillStyle = color;
    g.fillText(text, mid.x, mid.y - 6);
  }
}

const DEG = Math.PI / 180;

/** 選取中的機體能不能拖曳轉向：部署、懸停原地轉身、噴射的落點；回傳中心、目前面向、把手位置與設定函式（度） */
function facingHandle(u: UnitView): { center: Vec; facing: number; knob: Vec; set: (deg: number) => void } | null {
  if (!view || show || view.submitted[view.you] || !commands(u)) return null;
  const knobAt = (c: Vec, f: number) => ({ x: c.x + Math.cos(f) * (radiusOf(u) * 1.5 + 0.5), y: c.y + Math.sin(f) * (radiusOf(u) * 1.5 + 0.5) });
  if (view.phase === 'deploy') {
    const d = deployDrafts[u.id];
    if (!d) return null;
    return { center: { x: d.x, y: d.y }, facing: d.facing, knob: knobAt(d, d.facing), set: (deg) => (d.facing = deg * DEG) };
  }
  if (view.phase !== 'move' && view.phase !== 'ace') return null;
  const plan = moveDrafts[u.id];
  if (!plan || plan.defer || inGrapple(u.id) || immobile(u)) return null;
  if (plan.jump) {
    const j = plan.jump;
    return { center: j.to, facing: j.facing * DEG, knob: knobAt(j.to, j.facing * DEG), set: (deg) => (j.facing = deg) };
  }
  if (parseManeuver(plan.maneuver).kind !== 'hover') return null;
  const f = u.facing + plan.facingOffset * DEG;
  const limit = isShip(u) ? config.SHIP_TURN_MAX_DEG : 180;
  return {
    center: u.pos,
    facing: f,
    knob: knobAt(u.pos, f),
    set: (deg) => (plan.facingOffset = Math.max(-limit, Math.min(limit, Math.round(Math.atan2(Math.sin(deg * DEG - u.facing), Math.cos(deg * DEG - u.facing)) / DEG)))),
  };
}

// 開發時方便從主控台檢查把手的位置
if (import.meta.env.DEV) (window as unknown as { __mw: unknown }).__mw = { facingHandle: (id: string) => { const u = unitView(id); return u ? facingHandle(u) : null; }, project: (x: number, y: number, z = 0) => pr(x, y, z), drafts: () => ({ moveDrafts, deployDrafts }) };

function drawFacingHandle() {
  const u = selected ? unitView(selected) : undefined;
  const h = u ? facingHandle(u) : null;
  if (!h) return;
  g.strokeStyle = 'rgba(255,214,120,0.95)';
  g.lineWidth = 2;
  polyWorld([
    [h.center.x, h.center.y, UNIT_Z],
    [h.knob.x, h.knob.y, UNIT_Z],
  ]);
  g.stroke();
  g.lineWidth = 1;
  const p = pr(h.knob.x, h.knob.y, UNIT_Z);
  if (p.visible) dotAt(p, faceDrag ? 8 : 6, 'rgba(255,214,120,0.95)');
}

/** 噴射：滑完動能的軌跡、落點範圍（選取中的才畫）、落點與面向 */
function drawJumpPlans() {
  if (!view || show || (view.phase !== 'move' && view.phase !== 'ace')) return;
  for (const [id, plan] of Object.entries(moveDrafts)) {
    const u = unitView(id);
    if (!u || !plan.jump) continue;
    const from = coastEnd(u);
    const sel = id === selected;
    g.strokeStyle = color(u.owner, sel ? 0.9 : 0.45);
    g.lineWidth = 2;
    polyWorld([
      [u.pos.x, u.pos.y, UNIT_Z],
      [from.x, from.y, UNIT_Z],
    ]);
    g.stroke();
    if (sel) {
      g.strokeStyle = 'rgba(239,159,39,0.9)';
      g.setLineDash([5, 4]);
      ringWorld(from.x, from.y, config.JUMP_RANGE, UNIT_Z);
      g.stroke();
      g.setLineDash([]);
    }
    const to = plan.jump.to;
    const z = landingHeight(view.state.obstacles, u, to);
    const ok = z !== null && Math.hypot(to.x - from.x, to.y - from.y) <= config.JUMP_RANGE + 1e-6;
    g.strokeStyle = ok ? 'rgba(239,159,39,0.95)' : 'rgba(240,80,80,0.95)';
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= 12; i++) {
      const k = i / 12;
      pts.push([from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, UNIT_Z + (z ?? 0) * k + 1.2 * 4 * k * (1 - k)]);
    }
    g.setLineDash([6, 4]);
    polyWorld(pts);
    g.stroke();
    g.setLineDash([]);
    ringWorld(to.x, to.y, radiusOf(u), z ?? 0);
    g.stroke();
    g.lineWidth = 1;
    if (z) {
      const c = pr(to.x, to.y, z);
      if (c.visible) {
        g.fillStyle = 'rgba(239,159,39,0.95)';
        g.font = '11px sans-serif';
        g.textAlign = 'center';
        g.fillText(`樓頂 ${z} 層`, c.x, c.y - 12);
      }
    }
  }
}

function drawPreviews() {
  drawPodPlans();
  drawJumpPlans();
  drawFacingHandle();
  drawMoveWarnings();
  drawSmokePreview();
  drawInbound();
  drawDeferRings();
  drawRearArc();
  if (view?.phase === 'pursuit') {
    for (const [id, plan] of Object.entries(pursuitDrafts)) {
      const a = unitView(id);
      const t = plan ? unitView(plan.target) : null;
      if (!a || !t) continue;
      g.strokeStyle = 'rgba(216,90,48,0.9)';
      g.lineWidth = 2.5;
      polyWorld([
        [a.pos.x, a.pos.y, UNIT_Z],
        [t.pos.x, t.pos.y, UNIT_Z],
      ]);
      g.stroke();
      g.lineWidth = 1;
    }
  }
  if (view?.phase === 'move' || view?.phase === 'ace') {
    for (const [id, plan] of Object.entries(moveDrafts)) {
      const u = unitView(id);
      if (!u || inGrapple(id) || plan.defer || plan.jump) continue;
      if (hoverManeuver?.unit === id) drawPath(u, { ...plan, maneuver: hoverManeuver.maneuver, facingOffset: 0 }, 'rgba(255,255,255,0.95)', true);
      else drawPath(u, plan, color(u.owner, id === selected ? 0.9 : 0.45), id === selected);
    }
  } else if (view?.phase === 'action') {
    // 已選的射擊／鎖定目標
    for (const [id, plan] of Object.entries(actionDrafts)) {
      const a = unitView(id);
      if (a && placed(plan.action)) {
        drawUtilityPreview(a, plan.action.type, plan.action.at);
        continue;
      }
      const bt = aimsAt(plan.action) && plan.action.target && a ? buildingOf(plan.action.target) : undefined;
      const t = (aimsAt(plan.action)) && plan.action.target ? (unitView(plan.action.target) ?? (enemyPod(plan.action.target) ? { pos: enemyPod(plan.action.target)!.pos } : bt ? { pos: buildingAim(bt, a!.pos) } : null)) : null;
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

/** 部署：自己的部署區反白，對方的部署區標示看不到 */
function drawDeployZones() {
  for (const p of [0, 1] as PlayerId[]) {
    const z = deployZone(p);
    const mine = p === view!.you;
    polyWorld([
      [z.x0, z.y0, 0],
      [z.x1, z.y0, 0],
      [z.x1, z.y1, 0],
      [z.x0, z.y1, 0],
      [z.x0, z.y0, 0],
    ]);
    g.fillStyle = color(p, mine ? 0.12 : 0.05);
    g.fill();
    g.strokeStyle = color(p, mine ? 0.7 : 0.25);
    g.setLineDash([6, 4]);
    g.stroke();
    g.setLineDash([]);
    // 標在左側，避開中央的達陣圈
    const c = pr(z.x0 + 4, (z.y0 + z.y1) / 2, 0);
    if (!c.visible) continue;
    g.fillStyle = color(p, 0.9);
    g.font = '12px sans-serif';
    g.textAlign = 'center';
    g.fillText(mine ? '你的部署區' : '對方部署區（看不到）', c.x, c.y);
  }
}

/** 擱置移動的機體：虛線圈（自己這一步選了擱置的、王牌移動步驟裡還在等的） */
function drawDeferRings() {
  if (!view || show || replayNow) return;
  const ids = new Set(view.phase === 'ace' ? view.state.deferred : view.phase === 'move' ? Object.keys(moveDrafts).filter((id) => moveDrafts[id].defer) : []);
  for (const id of ids) {
    const u = unitView(id);
    if (!u || u.status !== 'active') continue;
    g.strokeStyle = u.owner === view.you ? 'rgba(175,169,236,0.95)' : 'rgba(240,149,149,0.95)';
    g.lineWidth = 2;
    g.setLineDash([5, 4]);
    ringWorld(u.pos.x, u.pos.y, radiusOf(u) + 0.35, UNIT_Z, 0, Math.PI * 2, 36);
    g.stroke();
    g.setLineDash([]);
    g.lineWidth = 1;
  }
}

/** 選取機體背後的危險扇形：敵機在這裡面又面向它，就能追擊 */
function drawRearArc() {
  const u = selected ? unitView(selected) : null;
  if (!u || u.status !== 'active' || show || replayNow) return;
  const half = (config.PURSUIT_ARC_DEG * Math.PI) / 180;
  const back = u.facing + Math.PI;
  const r = config.RANGE_LIMITS.r2 + radiusOf(u) + config.BASE_RADIUS;
  const pts: [number, number, number][] = [[u.pos.x, u.pos.y, 0]];
  for (let i = 0; i <= 16; i++) {
    const a = back - half + (2 * half * i) / 16;
    pts.push([u.pos.x + Math.cos(a) * r, u.pos.y + Math.sin(a) * r, 0]);
  }
  pts.push([u.pos.x, u.pos.y, 0]);
  polyWorld(pts);
  g.fillStyle = 'rgba(226,75,74,0.10)';
  g.fill();
  g.strokeStyle = 'rgba(226,75,74,0.45)';
  g.setLineDash([3, 4]);
  g.stroke();
  g.setLineDash([]);
}

/** 行動步驟：滑鼠停在敵機上時顯示所選機體對它的估計命中率 */
function drawHoverHint() {
  if (view?.phase !== 'action') return;
  const sel = selected ? unitView(selected) : undefined;
  const hov = hoverUnit ? unitView(hoverUnit) : undefined;
  const plan = sel ? actionDrafts[sel.id] : undefined;
  if (!sel || !hov || !plan || plan.action.type === 'none' || hov.owner === view.you || hov.status !== 'active' || hov.hidden) return;
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
    else if (v === 'reach') toggleReach();
    else resetCamera();
  };
});

// ---------- 敵機可能落點（可開關，預設關閉；記住上次的選擇） ----------

const REACH_KEY = 'mech-wing-reach';
let showReach = (() => {
  try {
    return localStorage.getItem(REACH_KEY) === '1';
  } catch {
    return false;
  }
})();
function toggleReach() {
  showReach = !showReach;
  try {
    localStorage.setItem(REACH_KEY, showReach ? '1' : '0');
  } catch {}
  syncReachButton();
}
function syncReachButton() {
  document.querySelector('#viewCtl button[data-view="reach"]')?.classList.toggle('on', showReach);
}
syncReachButton();
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key.toLowerCase() === 'n') toggleReach();
});
/** 滑鼠在畫面上的位置（落點的正面射界提示用） */
let mouseScreen: { x: number; y: number } | null = null;

/** 每台看得到的敵機：下一步所有機動的終點（推進劑不明就當作夠用；背包壞了之類看得到的損傷照算） */
function drawReach() {
  if (!showReach || !view || show || view.phase === 'deploy' || view.phase === 'over') return;
  const grappled = new Set(view.state.grapples.flatMap((x) => [x.a, x.b]));
  let near: { x: number; y: number; d: number; pos: Vec; facing: number; owner: PlayerId } | null = null;
  for (const e of view.state.units) {
    if (e.owner === view.you || e.status !== 'active' || e.hidden || e.unknown || grappled.has(e.id)) continue;
    const limits = { ...e, propellant: 99 } as unknown as Parameters<typeof availableManeuvers>[0];
    const ends = availableManeuvers(limits).map((m) => worldPose(buildPath(limits as unknown as UnitState, { maneuver: m.id, limiter: false }), 1));
    if (!ends.length) continue;
    const pts = ends.map((p) => pr(p.pos.x, p.pos.y, 0)).filter((q) => q.visible);
    const shape = hull(pts.map((q) => ({ x: q.x, y: q.y })));
    if (shape.length >= 3) {
      g.fillStyle = color(e.owner, 0.08);
      g.strokeStyle = color(e.owner, 0.45);
      g.setLineDash([4, 4]);
      g.beginPath();
      shape.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
      g.closePath();
      g.fill();
      g.stroke();
      g.setLineDash([]);
    }
    ends.forEach((p) => {
      const q = pr(p.pos.x, p.pos.y, 0);
      if (!q.visible) return;
      g.fillStyle = color(e.owner, 0.75);
      g.beginPath();
      g.arc(q.x, q.y, 2.5, 0, Math.PI * 2);
      g.fill();
      if (mouseScreen) {
        const d = Math.hypot(q.x - mouseScreen.x, q.y - mouseScreen.y);
        if (d < 10 && (!near || d < near.d)) near = { x: q.x, y: q.y, d, pos: p.pos, facing: p.facing, owner: e.owner };
      }
    });
  }
  // 滑鼠停在某個落點：畫出它從那裡的正面射界（±45°）
  const n = near as { pos: Vec; facing: number; owner: PlayerId } | null;
  if (n) {
    const half = (config.OFF_FRONT_DEG * Math.PI) / 180;
    g.fillStyle = color(n.owner, 0.12);
    g.beginPath();
    const c = pr(n.pos.x, n.pos.y, 0);
    g.moveTo(c.x, c.y);
    for (let i = 0; i <= 16; i++) {
      const a = n.facing - half + (2 * half * i) / 16;
      const q = pr(n.pos.x + Math.cos(a) * config.RANGE_LIMITS.r2, n.pos.y + Math.sin(a) * config.RANGE_LIMITS.r2, 0);
      g.lineTo(q.x, q.y);
    }
    g.closePath();
    g.fill();
  }
}

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
  $('seatLinks').innerHTML = recordId
    ? `重播紀錄 <b>#${recordId}</b>（雙方都看得到）`
    : local
    ? local.opponent === 'aivai'
      ? '觀戰中（從 A 方視角）'
      : local.opponent === 'ai' || local.opponent === 'aiA'
        ? `你是 <b style="color:${color(seat)}">${SIDE(seat)} 方</b>，${SIDE((1 - seat) as PlayerId)} 方由電腦操作`
        : `同機輪流　現在是 <b style="color:${color(seat)}">${SIDE(seat)} 方</b>`
    : `房間 <b>${esc(room)}</b>　你是 <b style="color:${color(seat)}">${SIDE(seat)} 方</b>${view?.squad !== undefined ? `第 ${view.squad} 小隊（只指揮自己小隊的機體）` : ''} <a href="?room=${encodeURIComponent(room)}&seat=${other}" target="_blank">開啟${SIDE(other)} 方視窗</a>`;
  if (!view) {
    $('status').textContent = lobby ? '開房：雙方各自選好隊伍加入，到齊就開打' : '連線中…';
    return;
  }
  const phase = { deploy: '部署', move: '步驟 1：移動', ace: '步驟 1b：王牌移動', pursuit: '追擊', action: '步驟 2：行動', over: '對戰結束' }[view.phase];
  const opp = connected[seat === 0 ? 1 : 0] ? '' : '（對手未連線）';
  const timer = deadline ? `　剩 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))} 秒` : '';
  const goals = objectiveStatus();
  $('status').textContent = `第 ${view.state.turn} 回合 · ${phase}${opp}${timer}${goals ? ` · ${goals}` : ''}`;
}
setInterval(() => deadline && renderStatus(), 1000);

/** 狀態列：擊墜分、據點分、達陣進度 */
function objectiveStatus(): string {
  const st = view!.state;
  const set = st.settings;
  const me = view!.you;
  const pair = (x: [number, number]) => (local?.opponent === 'aivai' ? `A ${x[0]} : ${x[1]} B` : `我 ${x[me]} : ${x[1 - me]} 敵`);
  const parts: string[] = [`擊墜分 ${pair(st.score)}${set.killScore ? `（${set.killScore} 勝）` : ''}`];
  if (set.control) parts.push(`據點 ${pair(st.objectives.control)}（${set.control} 勝）`);
  if (set.goal)
    for (const p of [0, 1] as PlayerId[]) {
      const h = st.objectives.goalHold[p];
      if (h) parts.push(`${labelOf(h.unit).split(' ')[0]} 達陣中`);
    }
  return parts.join('　');
}

const REASON_TEXT: Record<WinReason, string> = { annihilation: '全滅', decapitation: '斬首', killScore: '擊墜分', goal: '達陣', control: '據點', turnLimit: '回合上限' };

const PHASE_HINT = {
  deploy: '把機體擺在自己的部署區',
  move: '替每台機體選機動和姿態，全部選好後按「送出指令」',
  ace: '其他機體已經動完：替擱置的機體選機動',
  pursuit: '有機體咬住敵機背後：選追擊的目標與武器，或放棄',
  action: '移動已結算：勾選要開火的武器（全部打同一個目標），再點地圖上的敵機',
  over: '',
};
const PHASE_NAME: Record<TurnPhase, string> = { deploy: '部署', move: '移動', ace: '王牌移動', pursuit: '追擊', action: '行動' };
const NT_SENSE_NAME = { numb: '麻木', strong: '堅強', sensitive: '敏感', fragile: '纖細' };

/** 這一步需要下指令的機體：擦撞的機體行動步驟不用；王牌移動只有擱置的；追擊只有咬住敵機背後的 */
const needsOrder = (u: UnitView) => {
  if (u.status !== 'active') return false;
  const ph = view!.phase;
  if (ph === 'action') return !view!.state.bumped.includes(u.id);
  if (ph === 'ace') return !!view!.aceUnits?.includes(u.id);
  if (ph === 'pursuit') return !!view!.pursuit?.[u.id]?.length;
  if (ph === 'deploy') return !!deployDrafts[u.id];
  return true;
}

/** 已經點過選項；射擊和鎖定還要選好目標才算完成 */
function orderDone(u: UnitView): boolean {
  if (!touched.has(u.id)) return false;
  if (view!.phase !== 'action') return true;
  const a = actionDrafts[u.id]?.action;
  if (placed(a)) return Number.isFinite(a.at.x);
  return !a || a.type === 'none' || a.type === 'mark' || a.type === 'deploy' || a.type === 'resupply' || !!a.target;
}

function unitStatusText(u: UnitView): [string, boolean] {
  if (u.status !== 'active') return [{ destroyed: '已擊毀', withdrawn: '已脫離戰場', unconscious: '駕駛昏迷', disabled: '停止動作' }[u.status], false];
  if (!view || view.phase === 'over' || show) return ['', false];
  if (view.submitted[view.you]) return ['已送出', true];
  if (!needsOrder(u)) return [view.phase === 'ace' ? '已移動' : view.phase === 'pursuit' ? '不能追擊' : '擦撞，本回合不能行動', false];
  if (view.phase === 'move' && moveDrafts[u.id]?.defer && touched.has(u.id)) return ['擱置', true];
  if (view.phase === 'pursuit') return pursuitDrafts[u.id] ? ['可追擊', true] : ['放棄追擊', true];
  if (view.phase === 'deploy') {
    const bad = deployProblem(u);
    if (bad) return [bad, false];
    return touched.has(u.id) ? ['✓ 已部署', true] : ['預設位置', false];
  }
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
    .join('') +
    (view.state.reserves ?? []).map((r) => `<div class="ucard reserve"><b>${esc(r.label)}</b><div class="st">第 ${r.turn} 回合進場</div></div>`).join('');
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
    ? `重播中：第 ${replayNow.turn} 回合・${PHASE_NAME[replayNow.phase]}（剩 ${replayQueue?.length ?? 0} 段）`
    : local?.opponent === 'aivai' && view.phase !== 'over'
      ? '觀戰中：雙方都由電腦操作，會自動進行到分出勝負'
      : show || view.submitted[view.you]
        ? ''
        : PHASE_HINT[view.phase];
  const incoming = view.state.inbound.filter((x) => x.owner !== view!.you && unitView(x.target)?.owner === view!.you);
  $('alertBar').textContent = show || watching || view.phase === 'over' ? '' : incoming.map((x) => `⚠ 來襲警告：${labelOf(x.attacker).split(' ')[0]} 的${EQUIPMENT[x.defId]?.name ?? x.defId} ×${x.shots} 飛向 ${labelOf(x.target).split(' ')[0]}，下回合移動結束後${EQUIPMENT[x.defId]?.fire === 'atgm' ? '命中；發射端看不到、瞄不住就落空' : '落下；標定失效就落空'}`).join('\n');
  const u = selected ? unitView(selected) : undefined;
  $('info').innerHTML = u ? infoHtml(u) : '';
  $('infoCard').hidden = !u;
  const ctrl = controlsHtml(u);
  $('controls').innerHTML = ctrl;
  $('cmdCard').hidden = !ctrl;
  if (ctrl && u) {
    $('cmdTitle').textContent = `${u.label.split(' ')[0]}・${view.phase === 'move' && inGrapple(u.id) ? '纏鬥' : PHASE_NAME[view.phase as TurnPhase]}`;
    $('cmdPin').textContent = cardPinned ? '已固定・雙擊還原' : '';
    defaultTip = defaultTipFor(u);
    setTip(defaultTip);
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
  if (view!.phase === 'deploy') return '在地圖上拖曳機體擺位置：只能放在自己的部署區，不能和隊友重疊或壓到大隕石。再選機頭朝向與起始動能。';
  if (view!.phase === 'pursuit') return '選一個追擊目標與武器，或放棄。追擊是額外的一槍，不佔行動步驟的動作。';
  if (view!.phase === 'move' || view!.phase === 'ace') {
    if (inGrapple(u.id)) return '纏鬥中：本回合不移動。滑鼠停在選項上看說明。';
    if (moveDrafts[u.id].defer) return '已擱置：其他機體（包括對方）都動完後，再替這台下移動指令。';
    const m = parseManeuver(moveDrafts[u.id].maneuver);
    const c = planCost(u, moveDrafts[u.id]);
    return `已選 ${m.name}：推進劑 −${c.propellant}、壓力 +${c.stress}。滑鼠停在按鈕上可預覽路徑與看說明；紅字會加壓力，黃底線會耗推進劑。`;
  }
  const plan = actionDrafts[u.id];
  const a = plan?.action;
  if (!a || a.type === 'none') return plan && swapOrders(plan).length ? '換武器（那一側這回合不能開火）。' : '勾選要開火的武器（可以多選），再點地圖上的敵機當目標。';
  if (a.type === 'smoke') return Number.isFinite(a.at.x) ? `煙霧彈丟到選好的位置：半徑 ${config.SMOKE_RADIUS}，射擊穿過或打裡面的目標 −${config.SMOKE_SHOT_PENALTY}，裡面的機體敵方認不出是什麼。` : `點地圖選煙霧彈的落點（${config.SMOKE_THROW_RANGE} 格內）。`;
  if (a.type === 'decoy') return Number.isFinite(a.at.x) ? '欺敵氣球放在選好的位置：在煙霧裡敵方分不出真假，出了煙霧就是一顆氣球。' : `點地圖選氣球的位置（${config.DECOY_PLACE_RANGE} 格內，放在煙霧裡才騙得到人）。`;
  if (a.type === 'mine') return Number.isFinite(a.at.x) ? MINE_TEXT : `點地圖選埋雷的位置（${config.MINE_LAY_RANGE} 格內的地上）。`;
  if (a.type === 'barricade') return Number.isFinite(a.at.x) ? BARRICADE_TEXT : `點地圖選路障的位置（${config.BARRICADE_RANGE} 格內；會橫擋在你往那裡的方向上）。`;
  if (a.type === 'mark') return markText(u);
  if (a.type === 'deploy') return DEPLOY_TEXT;
  if (a.type === 'resupply') return SUPPLY_TEXT;
  if (a.type === 'lunge' && !a.target) return `${LUNGE_TEXT} 點地圖上的敵機當目標。`;
  if (!a.target) return '點地圖上的敵機當目標（滑鼠移上去會顯示估計命中率）。也可以點建築，把它當目標打。';
  const bt = buildingOf(a.target);
  if (bt && a.type === 'shoot') return `射擊建築 ${bt.id}：${buildingEstimate(u, a.weapon, bt)}。化學能 ×${BUILDING_TYPE_MULT.chemical}、動能 ×${BUILDING_TYPE_MULT.kinetic}、能量 ×${BUILDING_TYPE_MULT.energy}；打光一層就少一層，而且下面那層有 ${config.COLLAPSE_CHAIN * 100}% 機率跟著塌（可以一路塌下去）；樓頂上的機體跟著掉下來，每掉一層受 ${config.COLLAPSE_DAMAGE} 點（大多打在腳上）；打平變成瓦礫。`;
  const t = unitView(a.target);
  if (a.type === 'lunge') return `${t ? lungeTip(u, t) : `突進 ${labelOf(a.target)}`}`;
  return a.type === 'lock' ? `鎖定 ${labelOf(a.target)}，下次對它射擊命中率 +${config.LOCK_BONUS}%。` : `射擊 ${labelOf(a.target)}${t ? `：${estimate(u, plan, t)}` : ''}。估計值已經算進距離、相對速度、射擊線、射界、鎖定等駕駛以外的因素；對方駕駛的閃避（技能 × ${config.EVADE_PER_SKILL}）看不到，所以沒算。`;
}

function bindTips() {
  $('cmdCard')
    .querySelectorAll<HTMLElement>('[data-tip]')
    .forEach((el) => {
      el.addEventListener('mouseenter', () => setTip(el.dataset.tip!));
      el.addEventListener('mouseleave', () => setTip(defaultTip));
    });
}

/**
 * 說明區固定高度，不會撐開卡片讓按鈕跑掉；放不下的文字自動上下捲動
 * （游標停在按鈕上才會顯示說明，沒辦法用滾輪捲）
 */
function setTip(text: string) {
  const box = $('tipBox');
  box.innerHTML = `<div class="tipInner">${esc(text)}</div>`;
  const inner = box.firstElementChild as HTMLElement;
  const room = box.clientHeight - parseFloat(getComputedStyle(box).paddingTop || '0');
  const over = inner.offsetHeight - room;
  if (over > 1) {
    inner.style.setProperty('--tip-shift', `${-Math.ceil(over)}px`);
    inner.style.setProperty('--tip-dur', `${(2 + over / 14).toFixed(1)}s`);
    inner.classList.add('scroll');
  }
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
    const p = fx(shownPose(u).pos);
    const gap = 34;
    const cands = [
      { x: p.x + gap, y: p.y - h / 2 },
      { x: p.x - gap - w, y: p.y - h / 2 },
      { x: p.x - w / 2, y: p.y - gap - h },
      { x: p.x - w / 2, y: p.y + gap },
    ];
    const blockers = [$('leftCol'), $('submitBox'), $('viewCtl'), $('log')].map((el) => relRect(el, stage));
      if (!$('infoCard').hidden) blockers.push(relRect($('infoCard'), stage));
    const others = view!.state.units.filter((x) => x.id !== u.id).map((x) => fx(shownPose(x).pos));
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

/** 滑鼠停在機體標記上：旁邊浮出受損圖小卡片（敵我都看得到，只有外觀） */
let hoverCardKey = '';

function updateHoverCard() {
  const el = $('hoverCard');
  const u = view && !show && hoverUnit ? unitView(hoverUnit) : undefined;
  if (!u) {
    el.hidden = true;
    hoverCardKey = '';
    return;
  }
  const key = `${u.id}:${JSON.stringify(u.parts)}:${u.status}`;
  if (key !== hoverCardKey) {
    hoverCardKey = key;
    const ch = CHASSIS[u.chassisId];
    const status = u.hidden ? `<div class="small muted">殘影 T${u.seenTurn}</div>` : u.status !== 'active' ? `<div class="small err">${{ destroyed: '擊毀', withdrawn: '脫離', unconscious: '昏迷', disabled: '停止' }[u.status]}</div>` : u.vague === 'sluggish' ? '<div class="small warn">動作遲鈍</div>' : '';
    el.innerHTML = `<div class="hname" style="color:${color(u.owner)}" title="${esc(ch.name)}">${esc(u.label.split(' ')[0])}</div>${mechSilhouette(u)}${status}`;
  }
  el.hidden = false;
  const p = fx(shownPose(u).pos);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const x = p.x + 16 + w > W ? p.x - 16 - w : p.x + 16;
  el.style.left = `${Math.max(4, x)}px`;
  el.style.top = `${Math.max(4, Math.min(H - h - 4, p.y - h / 2))}px`;
}

/** 指令卡與地圖上所選機體之間的細線 */
function drawCardLink() {
  const u = selected ? unitView(selected) : undefined;
  if (!cardRect || show || !u) return;
  const p = fx(shownPose(u).pos);
  if (!p.visible) return;
  const a = { x: Math.max(cardRect.x, Math.min(cardRect.x + cardRect.w, p.x)), y: Math.max(cardRect.y, Math.min(cardRect.y + cardRect.h, p.y)) };
  const b = { x: p.x, y: p.y };
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

/** 裝備：有自己部位的顯示耐久；內建與內藏的跟著宿主（宿主壞了就失效） */
function gearCell(u: UnitView, e: EquipState): string {
  if (u.parts[e.id]) return partCell(u, e.id) + (e.ammo !== undefined && !u.parts[e.id].destroyed ? `<span class="muted">彈${e.ammo}</span>` : '');
  const host = e.host ? u.parts[e.host] : undefined;
  const ok = equipAlive(u, e);
  return `<span class="${ok ? '' : 'dead'}">${esc(EQUIPMENT[e.defId].name)}${host ? `(${esc(host.name)})` : ''}${ok ? '' : ' 失效'}</span>`;
}

function partCell(u: UnitView, id: string): string {
  const p = u.parts[id];
  if (!p) return '<span></span>';
  const cls = p.destroyed ? 'dead' : exposed(p) ? 'bare' : p.damage ? 'hurt' : '';
  return `<span class="${cls}">${esc(p.name)}(${p.durability - p.damage}/${p.durability})</span>`;
}

function infoHtml(u: UnitView): string {
  if (u.unknown) return `<div class="uname" style="color:#b4b2a9">不明機體</div><div class="small muted">隔著煙霧認不出是什麼，可能是真的機體，也可能是欺敵氣球。靠近 ${config.SMOKE_ID_RANGE} 格內、或它開火時才認得出來。</div>`;
  const ch = CHASSIS[u.chassisId];
  const mine = u.owner === view!.you;
  let html = `<div class="uname" style="color:${color(u.owner)}">${esc(u.label)} <span class="muted small">${esc(ch.name.replace(/^X-\d+ /, ''))}・重量級 ${ch.weightClass}${ch.armorType ? `・${ARMOR_NAMES[ch.armorType]}` : ''}</span></div>`;
  if (mine && u.pilotId) {
    const p = PILOTS[u.pilotId];
    const tags = [p.abilities.includes('quick_draw') ? '快速拔刀' : '', p.abilities.includes('ace_move') ? '王牌移動' : '', p.abilities.includes('called_shot') ? '瞄準要害' : '', p.abilities.includes('brawler') ? '擅長肉搏' : '', p.abilities.includes('newtype') ? `新人類・${NT_SENSE_NAME[p.ntSense ?? 'sensitive']}` : ''].filter(Boolean);
    html += `<div class="small">${esc(p.name)}（技能 ${p.skill}${tags.map((t) => `・${t}`).join('')}）　壓力 <b>${u.stress}</b>/${u.maxStress}　推進劑 <b>${u.propellant}</b>/${u.maxPropellant}</div>`;
    const flags = [u.blackout ? '<span class="warn">黑視中</span>' : '', u.mark ? '<span class="warn">被標定</span>' : '', u.lockOn ? `鎖定 ${esc(labelOf(u.lockOn))}` : '', inGrapple(u.id) ? '<span class="warn">纏鬥中</span>' : ''].filter(Boolean);
    if (flags.length) html += `<div class="small">${flags.join('　')}</div>`;
  } else {
    html += `<div class="small muted">駕駛：不明${u.vague === 'sluggish' ? '　<span class="warn">動作遲鈍</span>' : ''}</div>`;
  }
  if (u.hidden) html += `<div class="small warn">目前看不到：以下是第 ${u.seenTurn} 回合最後目擊時的樣子</div>`;
  const v = view!.state.velocity[u.id];
  html += `<div class="small muted">動能 ${signed(u.momentum)}${v ? `　本回合移動 ${Math.hypot(v.x, v.y).toFixed(1)}` : ''}</div>`;
  if (isHumanoid(u)) {
    const body = [
      ['', 'head', ''],
      ['larm', 'torso', 'rarm'],
      ['', 'pack', ''],
      ['', 'legs', ''],
    ];
    html += `<div class="body">${body.flat().map((id) => (id ? partCell(u, id) : '<span></span>')).join('')}</div>`;
  } else {
    // 非人形：依序列出所有機體部位
    html += `<div class="body">${Object.values(u.parts).filter((p) => p.kind === 'body').map((p) => partCell(u, p.id)).join('')}</div>`;
  }
  const where = { right: '右手', left: '左手', stowed: '收納', mount: '外掛', builtin: '內建', housed: '內藏' };
  html += `<div class="equip">${u.equipment.map((e) => `<span>${where[e.location]} ${gearCell(u, e)}</span>`).join('')}</div>`;
  if (u.status !== 'active') html += `<div class="err">${{ destroyed: '已擊毀', withdrawn: '已脫離戰場', unconscious: '駕駛昏迷', disabled: '停止動作' }[u.status]}</div>`;
  return html;
}

// ---- 中欄：機動盤／行動 ----

function resultText(): string {
  const w = view!.state.winner;
  const why = view!.state.winReason ? `（${REASON_TEXT[view!.state.winReason]}）` : '';
  if (w === 'draw') return `平手${why}`;
  if (local?.opponent === 'aivai') return `${SIDE(w as PlayerId)} 方勝利${why}`;
  return `${w === view!.you ? '勝利' : '敗北'}${why}`;
}

function controlsHtml(u: UnitView | undefined): string {
  if (watching) return '';
  if (replayNow || show || !u || view!.phase === 'over' || local?.opponent === 'aivai') return '';
  if (!commands(u) || u.status !== 'active' || view!.submitted[view!.you] || !needsOrder(u)) return '';
  if (view!.phase === 'pursuit') return pursuitControls(u);
  if (view!.phase === 'deploy') return deployControls(u);
  return view!.phase === 'move' || view!.phase === 'ace' ? moveControls(u, moveDrafts[u.id]) : actionControls(u, actionDrafts[u.id]);
}

const DIAL_COLUMNS = ['turn-L', 'bank-L', 'straight-S', 'bank-R', 'turn-R'];
const GLYPH: Record<string, string> = { 'turn-L': '↰', 'bank-L': '↖', 'straight-S': '↑', 'bank-R': '↗', 'turn-R': '↱', 'arc-L': '⤺', 'arc-R': '⤻', 'kturn-S': '⥁', 'hover-S': '◎', 'reverse-S': '↓', 'rbank-L': '↙', 'rbank-R': '↘', 'slide-L': '⇠', 'slide-R': '⇢' };
/** 後退那一排對齊前進的欄位：斜後退放在緩轉的位置 */
const REVERSE_COLUMNS: Record<string, string> = { 'bank-L': 'rbank-L', 'straight-S': 'reverse-S', 'bank-R': 'rbank-R' };
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const dialKey = (m: ManeuverSpec) => `${m.kind}-${m.dir === -1 ? 'L' : m.dir === 1 ? 'R' : 'S'}`;

/** 機動盤：每個機動一顆按鈕，滑鼠停上去會在地圖預覽 */
function dialHtml(u: UnitView, plan: MovePlan): string {
  const dial = dialOf(u).map(parseManeuver);
  const button = (m: ManeuverSpec) => {
    const c = maneuverCost(u, m, plan.limiter);
    const ok = c.blocked === null;
    const cls = ['mv', m.id === plan.maneuver ? 'on' : '', c.stress - (plan.limiter ? config.LIMITER_STRESS : 0) > 0 ? 'hard' : '', c.propellant > 0 ? 'fuel' : '', ok ? '' : 'dis'].join(' ');
    const title = `${m.name}：動能 ${signed(u.momentum)} → ${signed(m.endMomentum)}（速度變化 ${c.dv}），推進劑 −${c.propellant}、壓力 +${c.stress}。${ok ? '' : `不能用：${c.blocked}。`}`;
    // 不用 disabled：停用的按鈕收不到滑鼠事件，說明區就看不到原因
    return `<button class="${cls}" data-m="${m.id}" data-tip="${esc(title)}" ${ok ? '' : 'data-off="1"'}>${GLYPH[dialKey(m)]}<small>${m.kind === 'hover' ? '' : m.speed}</small></button>`;
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
  // 後退：速度由慢到快往下排
  const back = dial.filter((m) => m.kind === 'reverse' || m.kind === 'rbank');
  for (const sp of [...new Set(back.map((m) => m.speed))].sort((a, b) => a - b)) {
    for (const col of DIAL_COLUMNS) {
      const key = REVERSE_COLUMNS[col];
      const m = key ? back.find((x) => x.speed === sp && dialKey(x) === key) : undefined;
      html += m ? button(m) : '<span></span>';
    }
  }
  html += '</div><div class="dialExtra">';
  for (const key of ['slide-L', 'arc-L', 'kturn-S', 'hover-S', 'arc-R', 'slide-R']) for (const m of dial.filter((x) => dialKey(x) === key)) html += button(m);
  return html + '</div>';
}

const speedTable = () =>
  config.RELATIVE_SPEED_HIT.map(([max, mod], k) => {
    const lo = k === 0 ? 0 : config.RELATIVE_SPEED_HIT[k - 1][0] + 1;
    const range = max === Infinity ? `${lo} 以上` : lo === max ? `${max}` : `${lo}–${max}`;
    return `${range}：${mod >= 0 ? '+' : ''}${mod}`;
  }).join('、');

const STANCE_TIPS: Record<Stance, string> = {
  shoot: `射擊姿態：撞到其他機體只是擦撞（雙方停住、本回合不能行動，不受傷）。射擊命中看雙方本回合移動的相對速度，並行或一起慢下來最好打（相對速度 ${speedTable()}）。`,
  melee: `近戰姿態：撞到就出手。相對速度 ${config.CLINCH_MAX_VC} 以下咬住對方進入纏鬥；自己速度 ${config.SLOW_MAX_SPEED + 1} 以上且相對速度更高時一擊脫離，雙方擲骰比近戰（手上沒近戰武器則是撞擊）。自己慢速（${config.SLOW_MAX_SPEED} 以下）時不主動出刀，被高速衝進來就承受衝擊：骰數 +${config.BRACE_DIE} 再加重量差，贏或平手把對方拖住。這回合射擊命中 −${config.MELEE_STANCE_SHOT_PENALTY}（發數多的武器比較划算）。`,
};
const STANCE_NAMES: Record<Stance, string> = { shoot: '射擊', melee: '近戰' };
const TECH_TIPS: Record<GrappleChoice, string> = {
  cleave: '劈砍：剋穿刺，被纏繞剋。',
  thrust: '穿刺：剋纏繞，被劈砍剋。',
  entangle: '纏繞（抓、摔、壓制）：剋劈砍，被穿刺剋；得手把對方摔出 2 格、壓力 +2。',
  disengage: '脫離：永遠等於被剋（對手多骰）；贏了就乾淨脫身，輸了吃對方一擊並被擊退（一樣會分開）。',
};

/** 纏鬥選項的說明：這台用哪件武器、擲幾顆骰、得手造成多少傷害 */
function grappleTip(u: UnitView, c: GrappleChoice): string {
  const base = `${TECH_TIPS[c]}被剋的一方對手多 ${config.COUNTER_DICE} 顆骰。所有射擊結算完才交手：雙方擲近戰骰比成功數，得手的一方一律把對方擊退、結束纏鬥；平手就繼續纏，雙方壓力 +1。`;
  if (c === 'disengage') return base;
  const use = techniqueUse(u as unknown as UnitState, c);
  if (!use) return base;
  const how = use.weapon ? EQUIPMENT[use.weapon.defId].name : `徒手${PILOTS[u.pilotId!]?.abilities.includes('brawler') ? '（擅長肉搏）' : '（不擅長肉搏：等於被剋）'}`;
  return `${how}：骰數 ${use.dice >= 0 ? '+' : ''}${use.dice}，得手造成 ${use.damage} 點傷害。${base}`;
}

/** 在按鈕上掛說明文字，滑鼠停留時顯示在卡片下方的說明區 */
const tip = (button: string, text: string) => button.replace(/^<button /, `<button data-tip="${esc(text)}" `);

function moveControls(u: UnitView, plan: MovePlan): string {
  if (inGrapple(u.id)) return '<div class="muted small">纏鬥中，不移動。手法在動作步驟選。</div>';
  // 王牌移動：移動步驟可以擱置（王牌移動步驟裡就不能再擱置）
  const pilot = PILOTS[u.pilotId!];
  const canDefer = view!.phase === 'move' && pilot?.abilities.includes('ace_move');
  const deferTip = `王牌移動：這一步先不動，等所有機體（包括對方）動完、看到結果後再替這台下移動指令。這一步被碰撞就失去王牌移動。${pilot?.abilities.includes('newtype') ? `新人類：對方有新人類在場時，擱置會讓壓力 +${config.ACE_DEFER_STRESS}。` : ''}`;
  const deferBtn = canDefer ? tip(`<button class="${plan.defer ? 'on' : ''}" data-defer="1">擱置</button>`, deferTip) : '';
  if (planCost(u, plan).blocked) plan.maneuver = cruiseManeuver(u);
  const m = parseManeuver(plan.maneuver);
  const cost = planCost(u, plan);
  // 擱置時版面不變、只把機動與姿態淡掉，按鈕才不會跑離游標
  let html = `<div class="ctrlRow${plan.defer ? ' deferred' : ''}"><div>`;
  const jet = jumpJetOf(u as unknown as UnitState);
  if (jet) html += `<div class="row"><button class="${plan.jump ? '' : 'on'}" data-jump="0">機動盤</button><button class="${plan.jump ? 'on' : ''}" data-jump="1">噴射</button></div>`;
  if (plan.jump) {
    const env = view!.state.settings.environment ?? 'space';
    html += `<div class="sec">噴射：推 −${jumpCost(u, env)}　壓 +${env === 'space' ? config.JUMP_STRESS_SPACE : config.JUMP_STRESS_GRAVITY}${env === 'space' ? '　動能保留' : `　落地射擊 −${config.JUMP_LANDING_PENALTY}`}</div>`;
    html += `<div class="small muted">點落點範圍選落點、拖曳決定面向（${Math.round(plan.jump.facing)}°）</div>`;
  } else {
    html += `<div class="sec">動能 ${signed(u.momentum)} → ${signed(m.endMomentum)}：<b style="color:var(--text)">${m.name}</b>　推 −${cost.propellant}　壓 +${cost.stress}</div>`;
    html += dialHtml(u, plan);
  }
  html += '</div><div>';
  html += '<div class="sec">姿態</div><div class="row">';
  const slow = moveSpeed(plan) <= config.SLOW_MAX_SPEED;
  html += (closeCombatOf(u) ? (['shoot', 'melee'] as Stance[]) : (['shoot'] as Stance[]))
    .map((s) => {
      const now = s === 'melee' ? (slow ? '（目前的機動是慢速：撞上就咬住，被高速衝進來會承受衝擊）' : '（目前的機動是高速：撞上就出刀一擊脫離）') : '';
      return tip(`<button class="${plan.stance === s ? 'on' : ''}" data-stance="${s}">${STANCE_NAMES[s]}</button>`, STANCE_TIPS[s] + now);
    })
    .join('');
  html += '</div>';
  if (immobile(u)) html += '<div class="row"><span class="small warn">重力圈裡腳部損壞：不能移動也不能轉向，只能原地不動</span></div>';
  else if (m.kind === 'hover' && !plan.jump) {
    html += `<div class="row"><span class="small muted">原地轉身 ${plan.facingOffset === 0 ? '不轉' : `${plan.facingOffset > 0 ? '右' : '左'} ${Math.abs(plan.facingOffset)}°`}・拖曳把手調整</span></div>`;
  }
  // 預測：這個機動會撞到什麼（敵機怎麼走看不到，不算）
  for (const w of moveWarnings().filter((x) => x.unit === u.id)) html += `<div class="row"><span class="small warn">⚠ 預測${esc(warningText(w, (id) => labelOf(id).split(' ')[0]))}</span></div>`;
  const limiterTip = `限制器解除：這回合最大加減速 +1，壓力 +${config.LIMITER_STRESS}。${m.kind === 'hover' ? '懸停時不能用。' : ''}`;
  const purgeBtn = armorOf(u)
    ? tip(`<button class="${plan.purge ? 'on' : ''}" data-purge="1">拋棄外裝甲</button>`, `拋棄外裝甲（免費）：${EQUIPMENT[u.equipment.find((e) => EQUIPMENT[e.defId].kind === 'armor')!.defId].name}還能再擋 ${(() => { const e = u.equipment.find((x) => EQUIPMENT[x.defId].kind === 'armor')!; return u.parts[e.id].durability - u.parts[e.id].damage; })()} 點傷害。穿著時只能用頭部武器、迴避 −${armorOf(u)!.evasionPenalty ?? 0}、最大加減速 −${armorOf(u)!.accelPenalty ?? 0}；拋棄後恢復，這回合就生效。`)
    : '';
  // 攀升：只有有建築的地圖才有
  const climbWhy = climbBlocked(u as unknown as UnitState, plan);
  const climbBtn = view!.state.obstacles.some((o) => o.kind === 'building')
    ? tip(
        `<button class="${plan.climb ? 'on' : ''}" data-climb="1" ${climbWhy && !plan.climb ? 'data-off="1"' : ''}>攀升</button>`,
        `攀升（跳躍、蹬牆）：這回合撞到 ${climbLimits(u as unknown as UnitState).levels} 層以內的牆就爬上樓頂（在空中跳得過街道，移動結束才落下），每爬一次推進劑 −${config.CLIMB_PROPELLANT}。速度 ${climbLimits(u as unknown as UnitState).speed} 以下才能用（太快蹬不了牆）。走出樓頂邊緣會自己掉下去，不用攀升。${climbWhy ? `
現在不能用：${climbWhy}` : ''}`,
      )
    : '';
  // 煙幕：有發射器才有；速度太快、用過了就淡掉
  const screens = screenLaunchers(u as unknown as UnitState);
  const screenWhy = screens.length ? screenBlocked(u as unknown as UnitState, { maneuver: plan.maneuver, smoke: screens[0].id }) : null;
  const smokeBtn = screens.length
    ? tip(
        `<button class="${plan.smoke ? 'on' : ''}" data-smoke="${screens[0].id}" ${screenWhy && !plan.smoke ? 'data-off="1"' : ''}>放煙幕（剩 ${screens.length}）</button>`,
        `煙幕彈：移動開始時在原地放出半徑 ${config.SMOKE_RADIUS} 的煙幕，留到這回合結束。射擊線穿過或目標在裡面命中 −${config.SMOKE_SHOT_PENALTY}（自己往外打也一樣）；煙裡有金屬粉，煙裡或隔著煙的機體標定、鎖定都會失效，飛過來的迫擊砲、飛彈會因此落空。速度 ${config.SCREEN_MAX_SPEED} 以下才能放，一個發射器一場一次。${screenWhy ? `
現在不能用：${screenWhy}` : ''}`,
      )
    : '';
  html += plan.jump
    ? `<div class="row">${smokeBtn}${purgeBtn}</div>`
    : `<div class="row">${tip(`<button class="${plan.limiter ? 'on' : ''}" data-limiter="1" ${m.kind === 'hover' ? 'data-off="1"' : ''}>限制器解除</button>`, limiterTip)}${climbBtn}${smokeBtn}${purgeBtn}${deferBtn}</div>`;
  if (view!.state.inbound.some((x) => x.target === u.id)) html += `<div class="row"><span class="small warn">⚠ 有彈藥飛向這台，下回合移動結束後命中${screens.length ? '（可以放煙幕甩掉）' : ''}</span></div>`;
  const guiding = view!.state.inbound.find((x) => x.attacker === u.id && EQUIPMENT[x.defId]?.fire === 'atgm');
  if (guiding) html += `<div class="row"><span class="small warn">導引反戰車飛彈中：這回合速度 ${config.ATGM_GUIDE_MAX_SPEED} 以下、${labelOf(guiding.target).split(' ')[0]} 要留在正面射界、看得到，不然落空</span></div>`;
  return html + '</div></div>' + (plan.defer ? '' : podMoveControls(u, plan));
}

/** 移動卡的感應武器區：放出／移動（再點地圖選目標點）、不動、收回 */
function podMoveControls(u: UnitView, plan: MovePlan): string {
  const gear = podGear(u);
  if (!gear.length) return '';
  if (!canPsycommu(u as unknown as UnitState)) return '<div class="muted small">感應武器：駕駛不是新人類或強化人，不能用。</div>';
  if ((view!.state.settings.environment ?? 'space') !== 'space') return '<div class="muted small">感應武器只能在宇宙使用。</div>';
  let html = '';
  for (const e of gear) {
    const ps = psycommuOf(e)!;
    const order = plan.pods?.[e.id];
    const charge = e.pod?.charge ?? ps.charge;
    html += `<div class="sec">${esc(podName(u, e))}${ps.wired ? '' : ` ×${bitsLeft(e)}`}${ps.charge !== undefined ? `　能量 ${charge}/${ps.charge}` : ''}　控制 ${ps.range}・移動 ${ps.move}</div>`;
    if (!equipAlive(u, e) || bitsLeft(e) <= 0) {
      html += '<div class="muted small">已經沒了。</div>';
      continue;
    }
    if (!e.pod && (e.readyTurn ?? 0) > view!.state.turn) {
      html += `<div class="muted small">充能中，第 ${e.readyTurn} 回合可以再放出。</div>`;
      continue;
    }
    const picking = podPick?.unit === u.id && podPick.equip === e.id;
    const go = picking || (!!order && 'to' in order);
    const goTip = ps.wired
      ? `${e.pod ? '移動' : '放出'}有線臂：直接移到點選的位置（最多 ${ps.move} 格、離母機 ${ps.range} 格內，超出會自動拉回），不會碰撞。指揮攻擊不佔行動；本體也開火時壓力再 +${config.PSYCOMMU_DUAL_STRESS}。放出時這隻手不能用。炮群在場上每回合壓力 +${config.PSYCOMMU_STRESS}。`
      : `${e.pod ? '移動' : '放出'}${EQUIPMENT[e.defId].name}：直接移到點選的位置（最多 ${ps.move} 格、離母機 ${ps.range} 格內，超出會自動拉回），不會碰撞。指揮攻擊會用掉這回合的行動，每次用掉 1 點能量；用完要收回，充能 ${config.PSYCOMMU_RECHARGE_TURNS} 個完整回合。炮群在場上每回合壓力 +${config.PSYCOMMU_STRESS}。`;
    html += '<div class="row">';
    html += tip(`<button class="${go ? 'on' : ''}" data-pod-go="${e.id}">${e.pod ? '移動' : '放出'}</button>`, goTip);
    html += tip(`<button class="${!order && !picking ? 'on' : ''}" data-pod-stay="${e.id}">${e.pod ? '不動' : '不放出'}</button>`, e.pod ? '炮群留在原地（母機移動後超出控制距離就會失控）。' : '這回合不放出。');
    if (e.pod) html += tip(`<button class="${order && 'recall' in order ? 'on' : ''}" data-pod-recall="${e.id}">收回</button>`, ps.wired ? '收回有線臂：裝回去就是一般的手臂，手指炮照常能直接開火。' : `收回${EQUIPMENT[e.defId].name}：充能 ${config.PSYCOMMU_RECHARGE_TURNS} 個完整回合後才能再放出。`);
    html += '</div>';
    if (picking) html += '<div class="small" style="color:#ffcf4a">點地圖選目標點（超出範圍會自動拉回）。</div>';
  }
  return html;
}

/** 戰艦的齊射：每座砲塔各自選一個目標（照它自己的射界） */
function salvoControls(u: UnitView, plan: ActionPlan): string {
  if (!isShip(u)) return '';
  const turrets = readyRanged(u).filter((e) => EQUIPMENT[e.defId].tags?.includes('turret'));
  if (!turrets.length) return '';
  const enemies = view!.state.units.filter((x) => x.owner !== view!.you && x.status === 'active' && !x.hidden);
  let html = '<div class="sec">砲塔齊射（每座各自選目標，不佔本體動作）</div>';
  for (const w of turrets) {
    const def = EQUIPMENT[w.defId];
    const cur = plan.salvo?.[w.id];
    html += `<div class="row"><span class="small muted">${esc(def.name)}</span>`;
    for (const t of enemies) {
      const h = hitChance({ attacker: u, attackerSkill: PILOTS[u.pilotId!].skill, weapon: def, target: t, targetSkill: null, relSpeed: relativeSpeed(view!.state.velocity, u.id, t.id), shooterMelee: false, cover: coverOf(view!.state.obstacles, u.pos, t.pos, u.z, t.z) });
      if (!h) continue;
      html += tip(`<button class="${cur === t.id ? 'on' : ''}" data-salvo="${w.id}|${t.id}">${esc(t.label.split(' ')[0])}</button>`, `${def.name} → ${t.label}：${bandName(h.band)}・${chanceText(h.chance)}`);
    }
    html += tip(`<button class="${cur ? '' : 'on'}" data-salvo="${w.id}|">不開火</button>`, '這座砲塔這回合不開火（射界內沒有目標時也只能這樣）。') + '</div>';
  }
  return html;
}

/** 行動卡的指揮炮群區：每個炮群選 1–2 個目標 */
function podActionControls(u: UnitView, plan: ActionPlan): string {
  const out = podGear(u).filter((e) => e.pod);
  if (!out.length) return '';
  const enemies = view!.state.units.filter((x) => x.owner !== view!.you && x.status === 'active' && !x.hidden);
  let html = '';
  for (const e of out) {
    const ps = psycommuOf(e)!;
    const def = EQUIPMENT[e.defId];
    html += `<div class="sec">指揮${esc(podName(u, e))}${ps.wired ? '' : `（${bitsLeft(e)} 支）`}</div>`;
    const issue = podIssue(u, e);
    if (issue) {
      html += `<div class="muted small">${esc(issue)}。</div>`;
      continue;
    }
    const chosen = plan.pods?.[e.id] ?? [];
    html += '<div class="row">';
    for (const t of enemies) {
      const at = e.pod!.pos;
      // 炮群本身當作不動（和結算一樣），相對速度就是目標的速度
      const h = hitChance({ attacker: { ...u, pos: at, facing: Math.atan2(t.pos.y - at.y, t.pos.x - at.x) }, attackerSkill: PILOTS[u.pilotId!].skill, weapon: def, target: t, targetSkill: null, relSpeed: relativeSpeed({ ...view!.state.velocity, [u.id]: { x: 0, y: 0 } }, u.id, t.id), shooterMelee: false, cover: coverOf(view!.state.obstacles, at, t.pos) });
      const est = h ? `${bandName(h.band)}・${chanceText(h.chance)}${dangerClose(view!.state, t.id) ? '・Danger Close／誤擊風險' : ''}` : '炮群射程外';
      html += tip(`<button class="${chosen.includes(t.id) ? 'on' : ''}${dangerClose(view!.state, t.id) ? ' danger' : ''}" data-pod-t="${e.id}|${t.id}">${esc(t.label.split(' ')[0])}</button>`, `${t.label}：${est}`);
    }
    html += tip(`<button class="${chosen.length ? '' : 'on'}" data-pod-t="${e.id}|">不指揮</button>`, '這回合不指揮這個炮群。');
    html += '</div>';
    const n = bitsLeft(e);
    if (chosen.length === 2) html += `<div class="muted small">分給兩個目標（${Math.ceil(n / 2)}／${Math.floor(n / 2)} 支）。</div>`;
    html += ps.wired ? `<div class="muted small">線控不佔行動；本體也開火時壓力 +${config.PSYCOMMU_DUAL_STRESS}。</div>` : '<div class="warn small">會用掉這回合的行動（本體不能開火）。再點一台就分給兩個目標。</div>';
  }
  return html;
}

/** 部署：朝向（以你面對敵方的方向為上）與起始動能 */
function deployControls(u: UnitView): string {
  const d = deployDrafts[u.id];
  const [lo, hi] = momentumRange(u);
  const moms = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
    .map((m) => tip(`<button class="${d.momentum === m ? 'on' : ''}" data-mom="${m}">${m}</button>`, `起始動能 ${m}：開戰第一回合的速度。快一點衝得快，但要停下來比較費推進劑。${lo > 0 ? '戰機不能低於最低速度。' : ''}`))
    .join('');
  return `<div class="sec">朝向 ${Math.round(d.facing / DEG)}°・拖曳把手調整</div><div class="sec">起始動能</div><div class="row">${moms}</div>`;
}

/** 追擊步驟：列出能追擊的目標 × 武器，或放棄 */
function pursuitControls(u: UnitView): string {
  const opts = view!.pursuit?.[u.id] ?? [];
  const cur = pursuitDrafts[u.id];
  const buttons = opts.map((o, i) => {
    const on = cur?.target === o.target && cur?.weapon === o.weapon;
    const w = equipName(u, o.weapon);
    return tip(
      `<button class="${on ? 'on' : ''}" data-pursue="${i}">${esc(labelOf(o.target).split(' ')[0])}・${esc(w)}　${o.chance > 100 ? `爆擊 ${Math.min(100, o.chance - 100)}%` : `${o.chance}%`}</button>`,
      `用${w}追擊 ${labelOf(o.target)}：${bandName(o.band as 0 | 1 | 2 | 3 | 4)}，估計${chanceText(o.chance)}。`,
    );
  });
  buttons.push(tip(`<button class="${cur === null ? 'on' : ''}" data-pursue="-1">放棄</button>`, '這台不追擊。'));
  return `<div class="sec">追擊</div><div class="optList">${buttons.join('')}</div>`;
}

interface EquipOption {
  key: string;
  label: string;
  kind: 'shoot' | 'lock' | 'none' | PlacedKind | 'mark' | 'lunge' | 'deploy' | 'resupply';
  equip?: string;
}

/** 行動卡「其他」區：鎖定、戰術道具、不行動 */
function otherOptions(u: UnitView): EquipOption[] {
  const out: EquipOption[] = [];
  for (const e of u.equipment) {
    const def = EQUIPMENT[e.defId];
    if (def.kind !== 'utility' || !def.utility || !equipAlive(u, e) || (e.ammo !== undefined && e.ammo <= 0)) continue;
    if (def.utility === 'mark') {
      if (!roleLost(u, 'sensor')) out.push({ key: `mark:${e.id}`, label: `${def.name}・標定${jammed(view!.state.units, u) ? '（我方干擾中，標定不了）' : ''}`, kind: 'mark', equip: e.id });
      continue;
    }
    // 電子干擾器一直開著、煙幕彈在移動時放，不用在行動下指令
    if (def.utility === 'ecm' || def.utility === 'screen') continue;
    // 地雷、路障在樓頂上放不了
    if ((def.utility === 'mine' || def.utility === 'barricade') && u.z) continue;
    const verb = { smoke: '丟出', decoy: '放置', mine: '埋設', barricade: '架設' }[def.utility];
    out.push({ key: `${def.utility}:${e.id}`, label: `${def.name}・${verb}（剩 ${e.ammo ?? '∞'}）`, kind: def.utility, equip: e.id });
  }
  for (const e of u.equipment) {
    const def = EQUIPMENT[e.defId];
    if (def.deployable && equipAlive(u, e) && (e.location === 'right' || e.location === 'left')) out.push({ key: `deploy:${e.id}`, label: `${def.name}・${e.deployed ? '收起' : '展開'}`, kind: 'deploy', equip: e.id });
  }
  // 補給：停在自己的補給點上
  if (view!.state.settings.supply && !u.z && u.momentum === 0 && Math.hypot(u.pos.x - supplyPoint(u.owner).x, u.pos.y - supplyPoint(u.owner).y) <= config.SUPPLY_RADIUS)
    out.push({ key: 'resupply', label: '補給點・補滿彈藥與推進劑', kind: 'resupply' });
  const blade = readyMelee(u as unknown as UnitState);
  if (blade && view!.state.stance[u.id] === 'melee') out.push({ key: 'lunge', label: `${EQUIPMENT[blade.defId].name}・突進／跳劈`, kind: 'lunge', equip: blade.id });
  if (!roleLost(u, 'sensor')) out.push({ key: 'lock', label: '感測器・鎖定', kind: 'lock' });
  out.push({ key: 'none', label: '不行動', kind: 'none' });
  return out;
}

function optionOn(o: EquipOption, plan: ActionPlan, u: UnitView): boolean {
  if (!touched.has(u.id)) return false;
  const a = plan.action;
  if (o.kind === 'lock') return a.type === 'lock';
  if (o.kind === 'lunge') return a.type === 'lunge';
  if (PLACED.includes(o.kind) || o.kind === 'mark' || o.kind === 'deploy') return a.type === o.kind && (a as { weapon?: string }).weapon === o.equip;
  return a.type === 'none' && !swapOrders(plan).length;
}

const DEPLOY_TEXT = `展開盾：在機體正面展開成寬 ${config.BARRIER_WIDTH} 格、高 ${config.BARRIER_LEVELS} 層的矮牆（再按一次收起）。穿過盾牆的射擊（敵我都算，自己開火不受影響）算半掩護 −${config.BUILDING_COVER_PENALTY}，命中一律打在盾上；躲在後面的隊友也受保護。比盾牆高 ${config.BARRIER_LEVELS} 層以上、或迫擊砲與垂直飛彈這種從上面來的擋不到。展開中只能用速度 ${config.DEPLOYED_MAX_SPEED} 以下的機動，選更快的機動會自動收起。用掉這回合的動作，不會暴露位置。`;
const SUPPLY_TEXT = `補給：停在自己的補給點上（動能 0），用掉這回合的動作，所有武器的彈藥、道具與推進劑補滿。不會暴露位置。`;
const MINE_TEXT = `埋地雷（底板邊緣 ${config.MINE_LAY_RANGE} 格內的地上）：對手看不到，靠近 ${config.MINE_DETECT_RANGE} 格才發現。敵方地面機體走過就引爆，腳受 ${config.MINE_DAMAGE} 點傷害；樓頂上、會飛的踩不到，自己人不會觸發。`;
const BARRICADE_TEXT = `架路障（${config.BARRICADE_RANGE} 格內）：長 ${config.BARRICADE_HALF_LENGTH * 2}、高 1 層的矮牆，橫擋在你往那裡的方向上；和建築一樣擋移動、射擊與視線。`;

const LUNGE_TEXT = `突進：衝到正面 ±${config.LUNGE_ARC_DEG}°、底板邊緣 ${config.LUNGE_RANGE} 格內、同一個高度的敵機身邊砍一刀（照近戰對決結算，對方可以盾擋、閃避、反擊）。目標比自己低就是跳劈：距離放寬到 ${config.JUMP_SLASH_RANGE} 格，每落下 1 層傷害 +1（最多 +${config.JUMP_SLASH_MAX_BONUS}），對方不能反擊，打中的部位多半在頭、軀幹、背包，很少打到腿；落差 ${config.JUMP_SLASH_LEG_FROM} 層以上自己腿部受 1 點傷害。比自己高的要先攀升。推進劑 −${config.LUNGE_PROPELLANT}、壓力 +${config.LUNGE_STRESS}，要近戰姿態。突進就不能開火。`;

/** 突進某台敵機的提示：可以就說是突進還是跳劈，不行就說原因 */
function lungeTip(u: UnitView, t: UnitView): string {
  const r = lungeCheck(view!.state.obstacles, u as unknown as UnitState, t as unknown as UnitState, view!.state.stance[u.id]);
  if (typeof r === 'string') return `${t.label}：不能突進（${r}）`;
  return r.jump > 0 ? `${t.label}：跳劈（落差 ${r.jump} 層，傷害 +${Math.min(r.jump, config.JUMP_SLASH_MAX_BONUS)}，對方不能反擊）` : `${t.label}：突進，砍得到`;
}

/** 標定的說明 */
function markText(u: UnitView, equip?: string): string {
  const id = equip ?? (u.equipment.find((e) => EQUIPMENT[e.defId].utility === 'mark')?.id ?? '');
  const def = EQUIPMENT[u.equipment.find((e) => e.id === id)?.defId ?? ''];
  const n = def?.markCount ?? config.MARK_COUNT;
  const jam = jammed(view!.state.units, u) ? '【注意：這台在我方電子干擾範圍內，現在標定不了；要離開干擾機中心 ' + config.ECM_RADIUS + ' 格以外】' : '';
  return `${jam}掃描正面 ±${config.MARK_ARC_DEG}°、感測距離 ${sensorRange(u)} 格內的敵機（不用視線，建築擋不住；在對方電子干擾範圍內的標定不到），隨機標定 ${n} 台：我方一直看得到它們，射擊命中 +${config.MARK_BONUS}%（自己也算）。持續到超出這台的感測距離、或這台的頭部或標定器被破壞為止，回合和攻擊都不會消耗。已經被標定的不會重複；再標定一次，原本標的會全部解除重挑。不會暴露自己的位置，但對方知道自己被標定了。標定就不能開火。標定在行動步驟最先結算，隊友這回合就能用導引武器打。`;
}

/** 有目標的動作：射擊、鎖定 */
const aimsAt = (a: ActionPlan['action']): a is Extract<ActionPlan['action'], { target: string }> => a.type === 'shoot' || a.type === 'lock' || a.type === 'lunge';

/** 這回合勾選開火的武器 */
const tickedOf = (plan: ActionPlan): string[] => (plan.action.type === 'shoot' ? shotWeapons(plan.action) : []);
/** 武器全部取消勾選時，記住原本選好的目標 */
const aimMemo: Record<string, string> = {};

function setShot(u: UnitView, plan: ActionPlan, ids: string[]) {
  const t = aimsAt(plan.action) ? plan.action.target : (aimMemo[u.id] ?? '');
  if (t) aimMemo[u.id] = t;
  plan.action = ids.length ? { type: 'shoot', weapon: ids[0], target: t, ...(ids.length > 1 ? { also: ids.slice(1) } : {}) } : { type: 'none' };
}

const HAND_NAME = { right: '右手', left: '左手' } as const;

interface FireOption {
  e: EquipState;
  /** 在哪裡：右手、左手、外掛或內建的部位 */
  slot: string;
  /** 在換武器那一側，這回合不能開火 */
  benched: boolean;
}

/** 能勾的武器：現在能開火的（戰艦砲塔除外），加上這回合拔出不佔行動、馬上能開火的；換武器那一側的不能勾 */
function fireOptions(u: UnitView, plan: ActionPlan): FireOption[] {
  const busy = busyHands(u as unknown as UnitState, plan);
  const out: FireOption[] = [];
  for (const e of readyRanged(u)) {
    if (EQUIPMENT[e.defId].tags?.includes('turret')) continue;
    const hand = e.location === 'right' || e.location === 'left' ? e.location : null;
    const slot = hand ? HAND_NAME[hand] : e.host ? (u.parts[e.host]?.name ?? '機體') : '機體';
    out.push({ e, slot, benched: !!hand && busy.has(hand) });
  }
  for (const [hand, id] of swapOrders(plan)) {
    const e = id ? u.equipment.find((x) => x.id === id) : undefined;
    if (e && !busy.has(hand) && EQUIPMENT[e.defId].kind === 'ranged' && !out.some((o) => o.e.id === e.id)) out.push({ e, slot: `${HAND_NAME[hand]}（拔出）`, benched: false });
  }
  return out;
}

/** 換武器：每一側的手可以換成同側（或背上）武器架的武器，或收起來 */
function swapChoices(u: UnitView, hand: Hand): EquipState[] {
  return u.equipment.filter((e) => {
    const def = EQUIPMENT[e.defId];
    if ((e.location !== 'stowed' && e.location !== 'housed') || !equipAlive(u, e) || (def.kind !== 'melee' && def.kind !== 'ranged')) return false;
    const side = rackSide(u, e);
    return !side || side === hand;
  });
}

function swapControls(u: UnitView, plan: ActionPlan): string {
  const orders = new Map(swapOrders(plan));
  let html = '';
  for (const hand of ['right', 'left'] as Hand[]) {
    if (!handUsable(u, hand)) continue;
    const held = heldItem(u as unknown as UnitState, hand);
    // 另一隻手已經選了要拿的不能再選
    const other = orders.get(hand === 'right' ? 'left' : 'right');
    const choices = swapChoices(u, hand).filter((e) => e.id !== other);
    if (!choices.length && !held) continue;
    const cur = orders.has(hand) ? (orders.get(hand) ?? '__holster') : '';
    html += `<div class="row"><span class="small muted">${HAND_NAME[hand]}${held ? `（${esc(EQUIPMENT[held.defId].name)}）` : '（空手）'}</span>`;
    html += tip(`<button class="${cur === '' ? 'on' : ''}" data-swap="${hand}|">不換</button>`, '這一側不換武器，照常開火。');
    for (const e of choices) {
      const free = freeDraw(u as unknown as UnitState, e);
      html += tip(
        `<button class="${cur === e.id ? 'on' : ''}" data-swap="${hand}|${e.id}">→ ${esc(EQUIPMENT[e.defId].name)}${free ? '・快拔' : ''}</button>`,
        `把${EQUIPMENT[e.defId].name}換到${HAND_NAME[hand]}${held ? `，${EQUIPMENT[held.defId].name}收回武器架` : ''}。${free ? '快速拔出：拔出來這回合就能開火。' : `${HAND_NAME[hand]}這回合不能開火，另一側照常。`}`,
      );
    }
    if (held) html += tip(`<button class="${cur === '__holster' ? 'on' : ''}" data-swap="${hand}|__holster">收起</button>`, `把${EQUIPMENT[held.defId].name}收回去，空出${HAND_NAME[hand]}（這一側這回合不能開火）。`);
    html += '</div>';
  }
  return html ? `<div class="sec">換武器（和同側的武器架交換；換的那一側這回合不能開火）</div>${html}` : '';
}

/** 一件武器打這個目標的估計（null：打不到，附原因） */
function weaponShot(u: UnitView, w: EquipState, t: UnitView): { h: NonNullable<ReturnType<typeof hitChance>> | null; why: string } {
  const def = EQUIPMENT[w.defId];
  const indirect = indirectFire(def);
  const wall = indirect ? null : barrierBetween(view!.state.units as never[] as (UnitView & { status: string })[], u.id, u.pos, u.z, t.pos);
  const cover = { ...coverOf(view!.state.obstacles, u.pos, t.pos, u.z, t.z), barrier: !!wall };
  if (def.fire === 'antiRadiation') {
    if (!ecmOf(t as never)) return { h: null, why: '反輻射飛彈只能打開著電子干擾的機體' };
  } else if (needsMark(def) && !t.mark) return { h: null, why: '飛彈、迫擊砲只能打被標定的目標' };
  if (cover.blocked && !indirect) return { h: null, why: '射擊線被擋住' };
  if (w.ammo !== undefined && w.ammo <= 0) return { h: null, why: '彈藥耗盡' };
  if (!indirect && def.arc !== undefined && relativeAngle(u, t.pos) > (def.arc * Math.PI) / 180) return { h: null, why: '射界外' };
  if (def.pointBlank === false && rangeBand(u, t) === 0) return { h: null, why: '太近' };
  const barrage = isShip(u) ? 0 : barragePenalty(view!.state.units as never, t as never);
  const h = hitChance({ attacker: u, attackerSkill: PILOTS[u.pilotId!].skill, weapon: def, target: t, targetSkill: null, relSpeed: relativeSpeed(view!.state.velocity, u.id, t.id), shooterMelee: view!.state.stance[u.id] === 'melee', cover, barrage, landing: view!.state.jumped.includes(u.id) });
  return { h, why: h ? '' : '射程外' };
}

function estimate(u: UnitView, plan: ActionPlan, t: UnitView): string {
  const ws = tickedOf(plan)
    .map((id) => u.equipment.find((e) => e.id === id))
    .filter((e): e is EquipState => !!e);
  if (!ws.length) return '';
  const wall = barrierBetween(view!.state.units as never[] as (UnitView & { status: string })[], u.id, u.pos, u.z, t.pos);
  const cover = { ...coverOf(view!.state.obstacles, u.pos, t.pos, u.z, t.z), barrier: !!wall };
  if (cover.blocked && !ws.some((w) => indirectFire(EQUIPMENT[w.defId]))) return '射擊線被擋住';
  const shots = ws.map((w) => ({ w, ...weaponShot(u, w, t) }));
  const first = shots.find((s) => s.h)?.h;
  if (!first) return shots.map((s) => `${EQUIPMENT[s.w.defId].name}：${s.why}`).join('／');
  const relSpeed = relativeSpeed(view!.state.velocity, u.id, t.id);
  const barrage = isShip(u) ? 0 : barragePenalty(view!.state.units as never, t as never);
  // 只勾了曲射越頂的武器：掩護、高低差都不算
  const direct = ws.some((w) => !indirectFire(EQUIPMENT[w.defId]));
  const mods = [
    `${bandName(first.band)}`,
    u.blackout && direct ? `黑視中 −${config.BLACKOUT_SHOT_PENALTY}` : '',
    view!.state.stance[u.id] === 'melee' ? `近戰姿態 −${config.MELEE_STANCE_SHOT_PENALTY}` : '',
    view!.state.jumped.includes(u.id) ? `落地 −${config.JUMP_LANDING_PENALTY}` : '',
    `相對速度 ${relSpeed.toFixed(1)}`,
    ...(direct ? coverParts(cover).map((c) => `${c.label} −${c.penalty}${c.label === '盾牆' ? '（命中都打在盾上）' : ''}`) : []),
    direct && first.high ? `高打低 +${first.high * config.HIGH_GROUND_HIT}${first.high >= config.HIGH_GROUND_DAMAGE_FROM ? `・傷害 +${config.HIGH_GROUND_DAMAGE_PCT * 100}%` : ''}` : '',
    t.mark ? `已標定 +${config.MARK_BONUS}` : '',
    barrage ? `目標在防禦彈幕裡 −${barrage}` : '',
    direct && coveringShield(t as unknown as UnitState, u.pos) ? '對方盾弧內（可能被盾擋）' : '',
    ...[...new Set(ws.map((w) => matchupText(CHASSIS[t.chassisId]?.armorType, EQUIPMENT[w.defId].damageType ?? 'kinetic')).filter(Boolean))],
  ].filter(Boolean);
  const flightNote = (d: (typeof EQUIPMENT)[string]) => (!flightFire(d) ? '' : d.fire === 'atgm' ? `（下回合命中，那時自己要速度 ${config.ATGM_GUIDE_MAX_SPEED} 以下、目標留在正面射界、看得到）` : '（下回合落下，那時標定失效就落空）');
  const each = shots.map((s) => `${EQUIPMENT[s.w.defId].name} ${s.h ? `約 ${s.h.chance}%${s.h.chance > 100 ? `（爆擊約 ${Math.min(100, s.h.chance - 100)}%）` : ''}${flightNote(EQUIPMENT[s.w.defId])}` : s.why}`).join('／');
  const danger = dangerClose(view!.state, t.id) ? '・Danger Close／誤擊風險：目標在纏鬥中，可能打到纏住它的機體' : '';
  return `${mods.join('・')}・${each}・未計對方駕駛閃避${danger}`;
}

const BAND_SHORT = { 1: '近', 2: '中', 3: '遠', 4: '超遠' } as const;
/**
 * 命中率文字：駕駛以外的因素（距離、相對速度、射擊線、射界、鎖定、外裝甲、頭部、高度）都算進去了；
 * 對方的駕駛看不到，閃避（技能 × 3）沒算，所以不說「必中」。超過 100 的部分是爆擊率
 */
const chanceText = (c: number) => (c > 100 ? `約 ${c}%（爆擊約 ${Math.min(100, c - 100)}%）・未計對方駕駛閃避` : `約 ${c}%・未計對方駕駛閃避`);
const BAND_LONG = { 1: '近距離', 2: '中距離', 3: '遠距離', 4: '超遠距離' } as const;

function optionTip(u: UnitView, o: EquipOption): string {
  if (o.kind === 'lock') return `鎖定一台敵機，下次對它射擊命中率 +${config.LOCK_BONUS}%。頭部被破壞就不能鎖定。鎖定就不能開火。`;
  if (o.kind === 'none') return '這回合不行動（也不換武器）。';
  if (o.kind === 'mark') return markText(u, o.equip);
  if (o.kind === 'resupply') return SUPPLY_TEXT;
  if (o.kind === 'lunge') return LUNGE_TEXT;
  if (o.kind === 'deploy') return DEPLOY_TEXT;
  if (o.kind === 'smoke') return `丟出煙霧彈（${config.SMOKE_THROW_RANGE} 格內）：半徑 ${config.SMOKE_RADIUS}，持續 ${config.SMOKE_TURNS_GRAVITY} 回合（宇宙 ${config.SMOKE_TURNS_SPACE}）。射擊穿過或打裡面的目標 −${config.SMOKE_SHOT_PENALTY}；隔著煙霧敵方只看得到「不明機體」。`;
  if (o.kind === 'mine') return MINE_TEXT;
  if (o.kind === 'barricade') return BARRICADE_TEXT;
  if (o.kind === 'decoy') return `放出欺敵氣球（${config.DECOY_PLACE_RANGE} 格內）：放在煙霧裡，敵方看起來就是一台不明機體；出了煙霧一眼就是氣球。被打中、鎖定或敵機靠近就破。`;
  const eq = u.equipment.find((e) => e.id === o.equip)!;
  const def = EQUIPMENT[eq.defId];
  const ranges = ([1, 2, 3, 4] as const)
    .filter((b) => def.ranges?.[b] !== undefined)
    .map((b) => `${BAND_SHORT[b]} ${def.ranges![b]! >= 0 ? '+' : ''}${def.ranges![b]}`)
    .join('／');
  const best = ([1, 2, 3, 4] as const).filter((b) => def.ranges?.[b] !== undefined).sort((x, y) => def.ranges![y]! - def.ranges![x]!)[0];
  const melee = view!.state.stance[u.id] === 'melee' ? `本回合是近戰姿態，命中 −${config.MELEE_STANCE_SHOT_PENALTY}。` : '';
  const mountText = { hand: '手持', mounted: '外掛（不用拿；本身會被擊中）', integrated: '內建（不用拿；和所在部位共存亡）', housed: '內藏' }[def.mount ?? 'hand'];
  const extra = [
    def.arc !== undefined ? `固定射界：前方 ±${def.arc}°，射界外打不到` : '',
    def.pointBlank === false ? '不能零距離開火' : '',
    eq.ammo !== undefined ? `剩 ${eq.ammo} 次` : '',
    def.tags?.includes('volatile') ? '被打壞可能引爆' : '',
  ].filter(Boolean).join('；');
  return `${def.name}（${mountText}）：每發 ${def.damage} ${DAMAGE_TYPE_NAMES[def.damageType ?? 'kinetic']}傷害${(def.shots ?? 1) > 1 ? `，一次 ${def.shots} 發` : ''}。適性距離：${best ? BAND_LONG[best] : '—'}（距離修正 ${ranges}）。${extra ? extra + '。' : ''}${melee}勾選的武器全部打同一個目標。`;
}

function actionControls(u: UnitView, plan: ActionPlan): string {
  if (view!.state.bumped.includes(u.id)) return '<div class="warn">這台機體在移動時擦撞，本回合不能行動。</div>';

  const grappled = inGrapple(u.id);
  let html = '';
  if (grappled) {
    const opts = grappleOptions(u as unknown as UnitState);
    html += `<div class="sec">纏鬥手法</div><div class="row">${opts
      .map((o) => tip(`<button class="${plan.grapple === o && touched.has(u.id) ? 'on' : ''}" data-grapple="${o}">${GRAPPLE_NAMES[o]}</button>`, grappleTip(u, o)))
      .join('')}</div><div class="warn small">纏鬥中不能射擊、鎖定或用道具，可以換武器。</div>`;
    return html + swapControls(u, plan);
  }
  html += podActionControls(u, plan) + salvoControls(u, plan);
  const ticked = new Set(tickedOf(plan));
  const fire = fireOptions(u, plan);
  if (fire.length) {
    html += '<div class="sec">開火（勾選的武器全部打同一個目標）</div><div class="optList">';
    html += fire
      .map(({ e, slot, benched }) => {
        const def = EQUIPMENT[e.defId];
        const notes = [def.arc !== undefined ? `前方±${def.arc}°` : '', e.ammo !== undefined ? `彈${e.ammo}` : ''].filter(Boolean).join('・');
        const label = `${ticked.has(e.id) ? '☑' : '☐'} ${slot}・${def.name}${notes ? `（${notes}）` : ''}${benched ? '・換武器中' : ''}`;
        return tip(`<button class="${ticked.has(e.id) ? 'on' : ''}" data-fire="${e.id}" ${benched ? 'data-off="1"' : ''}>${esc(label)}</button>`, benched ? '這一側在換武器，這回合不能開火。' : optionTip(u, { key: e.id, label, kind: 'shoot', equip: e.id }));
      })
      .join('');
    html += '</div>';
  }
  const a = plan.action;
  if (aimsAt(a)) {
    const enemies = view!.state.units.filter((x) => x.owner !== view!.you && x.status === 'active' && !x.hidden);
    html += `<div class="sec">目標（也可以直接點地圖上的敵機）</div><div class="row">`;
    html += enemies
      .map((t) => tip(`<button class="${a.target === t.id ? 'on' : ''}${a.type === 'shoot' && dangerClose(view!.state, t.id) ? ' danger' : ''}" data-target="${t.id}">${esc(t.label.split(' ')[0])}</button>`, a.type === 'shoot' ? `${t.label}：${estimate(u, plan, t)}` : a.type === 'lunge' ? lungeTip(u, t) : `鎖定 ${t.label}`))
      .join('');
    // 看得到的敵方炮群也可以當射擊目標
    if (a.type === 'shoot')
      for (const p of view!.state.enemyPods ?? []) {
        const w = u.equipment.find((x) => x.id === a.weapon);
        const ps = EQUIPMENT[p.defId].psycommu!;
        const h = w ? hitChance({ attacker: u, attackerSkill: PILOTS[u.pilotId!].skill, weapon: EQUIPMENT[w.defId], target: { id: p.id, chassisId: '', pos: p.pos, facing: 0, parts: {}, equipment: [] }, targetSkill: null, relSpeed: null, shooterMelee: view!.state.stance[u.id] === 'melee', cover: coverOf(view!.state.obstacles, u.pos, p.pos), targetEvasion: ps.evasion ?? 0 }) : null;
        html += tip(`<button class="${a.target === p.id ? 'on' : ''}" data-target="${p.id}">${esc(p.label.split(' ')[0])} ${esc(enemyPodName(p))}</button>`, `射擊 ${p.label} 的${enemyPodName(p)}：${h ? chanceText(h.chance) : '射程外'}。${p.wired ? '打中就是打那隻手臂。' : '每發命中打掉一支。'}`);
      }
    // 有敵機站在上面的建築：列出來方便拆（其他建築直接點地圖）
    if (a.type === 'shoot')
      for (const o of view!.state.obstacles.filter((x) => x.kind === 'building' && x.levels && enemies.some((t) => t.z && inFootprint(x, t.pos))))
        html += tip(`<button class="${a.target === o.id ? 'on' : ''}" data-target="${o.id}">建築 ${esc(o.id)}</button>`, `射擊建築 ${o.id}（有敵機站在樓頂）：${buildingEstimate(u, a.weapon, o)}`);
    html += '</div>';
  }
  html += swapControls(u, plan);
  html += '<div class="sec">其他</div><div class="row">';
  html += otherOptions(u)
    .map((o) => tip(`<button class="${optionOn(o, plan, u) ? 'on' : ''}" data-opt="${o.key}">${esc(o.label)}</button>`, optionTip(u, o)))
    .join('');
  return html + '</div>';
}

function bindControls(u: UnitView | undefined) {
  if (!u || !commands(u)) return;
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
      if (b.dataset.off) return;
      move.maneuver = b.dataset.m!;
      delete move.jump;
      if (parseManeuver(move.maneuver).kind === 'hover') move.limiter = false;
      else move.facingOffset = 0;
      if (move.climb && climbBlocked(u as unknown as UnitState, move)) move.climb = false;
      if (move.smoke && screenBlocked(u as unknown as UnitState, move)) delete move.smoke;
      hoverManeuver = null;
      changed();
    };
  });
  ctr.querySelectorAll<HTMLButtonElement>('button[data-stance]').forEach(
    (b) =>
      (b.onclick = () => {
        if (b.dataset.off) return;
        move.stance = b.dataset.stance as Stance;
        changed();
      }),
  );
  ctr.querySelectorAll<HTMLButtonElement>('button[data-purge]').forEach((b) => (b.onclick = () => ((move.purge = !move.purge), changed())));
  ctr.querySelectorAll<HTMLButtonElement>('button[data-mom]').forEach((b) => (b.onclick = () => ((deployDrafts[u.id].momentum = Number(b.dataset.mom)), changed())));
  ctr.querySelectorAll<HTMLButtonElement>('button[data-limiter]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.off) return;
      move.limiter = !move.limiter;
      if (planCost(u, move).blocked) move.maneuver = cruiseManeuver(u);
      changed();
    };
  });
  ctr.querySelectorAll<HTMLButtonElement>('button[data-climb]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.off) return;
      move.climb = !move.climb || undefined;
      changed();
    };
  });
  ctr.querySelectorAll<HTMLButtonElement>('button[data-jump]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.jump === '1' && !move.jump) {
        move.jump = { to: coastEnd(u), facing: Math.round(u.facing / DEG) };
        move.facingOffset = 0;
        move.limiter = false;
        delete move.climb;
        move.defer = false;
      } else if (b.dataset.jump === '0') delete move.jump;
      changed();
    };
  });
  ctr.querySelectorAll<HTMLButtonElement>('button[data-smoke]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.off) return;
      if (move.smoke) delete move.smoke;
      else move.smoke = b.dataset.smoke!;
      changed();
    };
  });
  ctr.querySelectorAll<HTMLButtonElement>('button[data-defer]').forEach((b) => (b.onclick = () => ((move.defer = !move.defer), changed())));
  ctr.querySelectorAll<HTMLButtonElement>('button[data-pursue]').forEach((b) => {
    b.onclick = () => {
      const o = view!.pursuit?.[u.id]?.[Number(b.dataset.pursue)];
      pursuitDrafts[u.id] = o ? { target: o.target, weapon: o.weapon } : null;
      changed();
    };
  });
  ctr.querySelectorAll<HTMLButtonElement>('button[data-pod-go]').forEach(
    (b) =>
      (b.onclick = () => {
        podPick = { unit: u.id, equip: b.dataset.podGo! };
        changed();
      }),
  );
  ctr.querySelectorAll<HTMLButtonElement>('button[data-pod-stay]').forEach(
    (b) =>
      (b.onclick = () => {
        if (move?.pods) delete move.pods[b.dataset.podStay!];
        podPick = null;
        changed();
      }),
  );
  ctr.querySelectorAll<HTMLButtonElement>('button[data-pod-recall]').forEach(
    (b) =>
      (b.onclick = () => {
        move.pods = { ...move.pods, [b.dataset.podRecall!]: { recall: true } };
        podPick = null;
        changed();
      }),
  );
  ctr.querySelectorAll<HTMLButtonElement>('button[data-salvo]').forEach(
    (b) =>
      (b.onclick = () => {
        if (!plan) return;
        const [wid, tid] = b.dataset.salvo!.split('|');
        const salvo = { ...plan.salvo };
        if (tid) salvo[wid] = tid;
        else delete salvo[wid];
        plan.salvo = Object.keys(salvo).length ? salvo : undefined;
        changed();
      }),
  );
  ctr.querySelectorAll<HTMLButtonElement>('button[data-pod-t]').forEach(
    (b) =>
      (b.onclick = () => {
        if (!plan) return;
        const [eid, tid] = b.dataset.podT!.split('|');
        const list = (plan.pods?.[eid] ?? []).filter((x) => x !== tid);
        if (tid && list.length === (plan.pods?.[eid] ?? []).length) list.push(tid);
        while (list.length > 2) list.shift();
        const pods = { ...plan.pods };
        if (!tid || !list.length) delete pods[eid];
        else pods[eid] = list;
        plan.pods = Object.keys(pods).length ? pods : undefined;
        // 指揮無線炮群會用掉行動：本體的動作改成不行動
        const wireless = Object.keys(pods).some((id) => !psycommuOf(u.equipment.find((x) => x.id === id)!)?.wired);
        if (wireless) {
          plan.action = { type: 'none' };
        }
        changed();
      }),
  );
  ctr.querySelectorAll<HTMLButtonElement>('button[data-grapple]').forEach((b) => (b.onclick = () => plan && ((plan.grapple = b.dataset.grapple as GrappleChoice), changed())));
  ctr.querySelectorAll<HTMLSelectElement | HTMLInputElement>('[data-f]').forEach((el) => {
    el.onchange = () => {
      const v = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.f === 'facingOffset') move.facingOffset = Number(v);
      if (el.dataset.f === 'limiter') {
        move.limiter = v as boolean;
        if (planCost(u, move).blocked) move.maneuver = cruiseManeuver(u);
      }
      changed();
    };
  });
  if (!plan) return;
  // 本體開火：無線炮群的指揮取消（線控的不受影響）
  const dropWireless = () => {
    if (!plan.pods) return;
    for (const id of Object.keys(plan.pods)) if (!psycommuOf(u.equipment.find((x) => x.id === id)!)?.wired) delete plan.pods[id];
    if (!Object.keys(plan.pods).length) plan.pods = undefined;
  };
  ctr.querySelectorAll<HTMLButtonElement>('button[data-fire]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.off) return;
      const id = b.dataset.fire!;
      const now = tickedOf(plan);
      const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
      if (next.length) dropWireless();
      if (plan.action.type !== 'shoot' && plan.action.type !== 'none') plan.action = { type: 'none' };
      setShot(u, plan, next);
      changed();
    };
  });
  ctr.querySelectorAll<HTMLButtonElement>('button[data-swap]').forEach((b) => {
    b.onclick = () => {
      const [hand, id] = b.dataset.swap!.split('|') as [Hand, string];
      const swaps: Partial<Record<Hand, string | null>> = Object.fromEntries(swapOrders(plan));
      if (!id) delete swaps[hand];
      else swaps[hand] = id === '__holster' ? null : id;
      plan.swap = undefined;
      plan.swaps = Object.keys(swaps).length ? swaps : undefined;
      // 換武器那一側的武器不能開火：取消勾選
      const ok = new Set(fireOptions(u, plan).filter((o) => !o.benched).map((o) => o.e.id));
      if (plan.action.type === 'shoot') setShot(u, plan, tickedOf(plan).filter((x) => ok.has(x)));
      changed();
    };
  });
  const target = () => (aimsAt(plan.action) ? plan.action.target : (aimMemo[u.id] ?? ''));
  ctr.querySelectorAll<HTMLButtonElement>('button[data-opt]').forEach((b) => {
    b.onclick = () => {
      const o = otherOptions(u).find((x) => x.key === b.dataset.opt)!;
      if (o.kind !== 'none') dropWireless();
      if (PLACED.includes(o.kind)) plan.action = { type: o.kind as PlacedKind, weapon: o.equip!, at: { x: NaN, y: NaN } };
      else if (o.kind === 'lock') plan.action = { type: 'lock', target: target() };
      else if (o.kind === 'mark') plan.action = { type: 'mark', weapon: o.equip! };
      else if (o.kind === 'resupply') plan.action = { type: 'resupply' };
      else if (o.kind === 'lunge') plan.action = { type: 'lunge', target: target() };
      else if (o.kind === 'deploy') plan.action = { type: 'deploy', weapon: o.equip! };
      else {
        plan.action = { type: 'none' };
        plan.swap = undefined;
        plan.swaps = undefined;
      }
      changed();
    };
  });
  ctr.querySelectorAll<HTMLButtonElement>('button[data-target]').forEach((b) => (b.onclick = () => setTarget(u.id, b.dataset.target!)));
}

function setTarget(unitId: string, targetId: string) {
  const plan = actionDrafts[unitId];
  if (!plan || (plan.action.type !== 'shoot' && plan.action.type !== 'lock')) return;
  plan.action.target = targetId;
  aimMemo[unitId] = targetId;
  touched.add(unitId);
  renderPanel();
}

// ---- 右欄：送出指令 ----

function renderSubmit() {
  const col = $('submitCol');
  if (watching && !show && !replayNow && !replayQueue) {
    col.innerHTML = '<div class="muted small">觀戰中</div>';
    return;
  }
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
  const auto = view.phase === 'deploy' && !done ? '<button class="big" id="autoDeployBtn">自動部署</button>' : '';
  col.innerHTML = `${auto}${errors.length ? `<div class="err small">${errors.map(esc).join('<br>')}</div>` : ''}<button class="primary big" id="submitBtn" ${done ? 'disabled' : ''}>${done ? '等待對手…' : '送出指令'}</button>`;
  $('submitBtn').onclick = trySubmit;
  if (auto)
    $('autoDeployBtn').onclick = () => {
      deployDrafts = aiDeploy(view!, new Rng((Math.random() * 2 ** 32) >>> 0));
      for (const id of Object.keys(deployDrafts)) touched.add(id);
      renderAll();
    };
}

function trySubmit() {
  const missing = ownUnits().filter((u) => needsOrder(u) && !orderDone(u));
  if (!missing.length) return submitOrders();
  const fallback = view!.phase === 'deploy' ? '會留在預設位置' : view!.phase === 'move' || view!.phase === 'ace' ? '會用預設機動（直線 2）' : '行動步驟則是不行動（選了裝備但沒選目標的也一樣）';
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
  if (view!.phase === 'move' || view!.phase === 'ace') return sendMsg({ t: 'moves', moves: moveDrafts });
  if (view!.phase === 'pursuit') return sendMsg({ t: 'pursuits', pursuits: pursuitDrafts });
  if (view!.phase === 'deploy') return sendMsg({ t: 'deploy', deploy: deployDrafts });
  // 沒選目標的射擊／鎖定視為不行動
  const actions: Record<string, ActionPlan> = {};
  for (const [id, p] of Object.entries(actionDrafts)) actions[id] = (aimsAt(p.action)) && !p.action.target ? { ...p, action: { type: 'none' } } : placed(p.action) && !Number.isFinite(p.action.at.x) ? { ...p, action: { type: 'none' } } : p;
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
  if (e.caught) result += `，${labelOf(e.defender)} 承受衝擊拖住了對方，進入纏鬥`;
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
    case 'purge':
      return `${L(e.unit)} 拋棄外裝甲`;
    case 'smoke':
      return `${e.unit ? L(e.unit) : '看不到的敵機'} ${e.screen ? '放出煙幕（留到這回合結束）' : '丟出煙霧彈'}`;
    case 'jump':
      return `${L(e.unit)} 噴射到新位置`;
    case 'launch':
      return `${L(e.attacker)} 發射${EQUIPMENT[e.weapon]?.name ?? e.weapon} ×${e.shots} → ${L(e.target)}，下回合移動結束後命中`;
    case 'inboundLost':
      return `${L(e.attacker)} 的${EQUIPMENT[e.weapon]?.name ?? e.weapon}（→ ${L(e.target)}）落空：${e.reason}`;
    case 'decoy':
      return `${L(e.unit)} 放出欺敵氣球`;
    case 'mine':
      return `${L(e.unit)} 埋下地雷`;
    case 'mineBlast':
      return `${L(e.unit)} 踩到地雷！`;
    case 'buildingShot':
      return `${e.attacker ? L(e.attacker) : '看不到的敵機'} 以${EQUIPMENT[e.weapon]?.name ?? e.weapon}射擊建築 ${e.obstacle}：${e.hits}/${e.shots} 命中${e.amount ? `，${e.amount} 點` : ''}${e.chain ? `，連帶塌了 ${e.chain} 層` : ''}${e.collapsed ? '，整棟打平！' : e.amount ? `，剩 ${e.levels} 層` : ''}`;
    case 'resupply':
      return `${L(e.unit)} 在補給點補滿彈藥與推進劑`;
    case 'barricade':
      return `${L(e.unit)} 架起路障`;
    case 'decoyPop':
      return `欺敵氣球破了（${e.reason}）`;
    case 'arrive':
      return `${L(e.unit)} 增援進場`;
    case 'defer':
      return `${L(e.unit)} 擱置移動，等待王牌移動`;
    case 'phase':
      return e.phase === 'ace' ? '── 王牌移動 ──' : e.phase === 'pursuit' ? '── 追擊 ──' : null;
    case 'pod': {
      const f = podById(e.equip, true);
      const name = f ? podName(f.u, f.e) : '炮群';
      return `${L(e.unit)} ${{ launch: '放出', recall: '收回', lost: '失去控制：', destroyed: '的' }[e.what]}${name}${e.what === 'destroyed' ? '被擊毀' : ''}`;
    }
    case 'podHit':
      return `${L(e.unit)} 的${EQUIPMENT[podById(e.equip, true)?.e.defId ?? '']?.name ?? '炮群'}被擊落 1 支（剩 ${e.bits}）`;
    case 'shot':
      if (e.pod) return `${L(e.attacker)} 指揮${(() => { const f = podById(e.pod, true); return f ? podName(f.u, f.e) : '炮群'; })()}射擊 ${L(e.target)}（${bandName(e.band)}${e.chance !== undefined ? `，命中率 ${e.chance}%` : ''}）：${e.hits}/${e.shots} 命中${e.crits ? `（爆擊 ${e.crits}）` : ''}${e.blocked ? `，盾擋 ${e.blocked}` : ''}`;
      return `${e.pursuit ? '追擊！' : ''}${L(e.attacker)} 以${EQUIPMENT[e.weapon].name}射擊 ${L(e.target)}（${bandName(e.band)}${e.chance !== undefined ? `，命中率 ${e.chance}%` : ''}）：${e.hits}/${e.shots} 命中${e.crits ? `（爆擊 ${e.crits}）` : ''}${e.blocked ? `，盾擋 ${e.blocked}` : ''}${e.strays ? `，誤擊 ${e.strays}` : ''}`;
    case 'damage':
      return e.amount ? `${L(e.unit)} ${partName(e.unit, e.part)} 受 ${e.amount} 點傷害${e.exposed ? '（結構外露）' : e.typed === 'weak' ? '（打在弱點上）' : e.typed === 'resist' ? '（被裝甲抵抗）' : ''}${e.destroyed ? '，破壞！' : ''}` : `${L(e.unit)} ${partName(e.unit, e.part)} 失效`;
    case 'knockback':
      return `${L(e.unit)} 被撞開，姿勢失控`;
    case 'stress':
      return `${L(e.unit)} 壓力 ${e.amount > 0 ? '+' : ''}${e.amount}（${e.reason}）→ ${e.total}`;
    case 'propellant':
      return `${L(e.unit)} 推進劑 ${e.amount} → ${e.total}`;
    case 'pilot':
      return `${L(e.unit)} ${{ blackout: '駕駛黑視', injured: '駕駛負傷', unconscious: '駕駛昏迷', sluggish: '動作遲鈍' }[e.state]}`;
    case 'status':
      return `${L(e.unit)} ${{ destroyed: '被擊毀', withdrawn: '脫離戰場', disabled: '停止動作' }[e.status]}${e.by ? `（${L(e.by)} 擊墜）` : ''}`;
    case 'grapple':
      return `纏鬥 ${L(e.a)}「${GRAPPLE_NAMES[e.choiceA]}」 vs ${L(e.b)}「${GRAPPLE_NAMES[e.choiceB]}」：${e.summary}`;
    case 'swap':
      return `${L(e.unit)} ${e.hand === 'right' ? '右手' : '左手'}換成 ${equipName(unitView(e.unit), e.equip)}`;
    case 'lock':
      return `${L(e.unit)} 鎖定 ${L(e.target)}`;
    case 'blast':
      return `${L(e.by)} 的迫擊砲沒打中，砲彈落地爆炸${e.units.length ? `，炸到 ${e.units.map(L).join('、')}` : ''}`;
    case 'deploy':
      return `${L(e.unit)} ${e.up ? '展開' : '收起'}${equipName(unitView(e.unit), e.equip)}`;
    case 'lunge':
      return `${L(e.unit)} ${e.jump ? `從 ${e.jump} 層高跳劈` : '突進'} ${L(e.target)}`;
    case 'mark':
      return `${e.unit ? L(e.unit) : '看不到的敵機'} 標定 ${L(e.target)}：命中 +${config.MARK_BONUS}%，持續到標定的機體看不到它為止`;
    case 'dazzle':
      return `${L(e.unit)} 被 ${L(e.by)} 的眩光照到，本回合射擊命中 −${config.DAZZLE_PENALTY}`;
    case 'actionFail':
      return `${L(e.unit)} 動作落空：${e.reason}`;
    case 'shipExplode':
      return `${L(e.unit)} 引擎殉爆，擊沉！${e.by ? `（${L(e.by)}）` : ''}`;
    case 'barrage':
      return `${L(e.ship)} 的防禦彈幕打中 ${L(e.unit)}`;
    case 'fuelFire':
      return `${L(e.unit)} 燃料槽引燃！`;
    case 'obstacle': {
      const o = view?.state.obstacles.find((x) => x.id === e.obstacle);
      return `${L(e.unit)} 撞上${o?.kind === 'building' ? '建築' : '隕石'}${e.damage ? `，受 ${e.damage} 點衝擊` : ''}`;
    }
    case 'elevate':
      return e.how === 'climb' ? `${L(e.unit)} 攀升上 ${e.z} 層樓頂` : `${L(e.unit)} 從樓頂落下${e.z ? `到 ${e.z} 層` : '到地面'}`;
    case 'debris':
      return `${L(e.unit)} 高速穿越隕石群，被碎石擊中`;
    case 'gameOver':
      return `${e.winner === 'draw' ? '對戰結束：平手' : `對戰結束：${e.winner === 0 ? 'A' : 'B'} 方勝利`}${e.reason ? `（${REASON_TEXT[e.reason]}）` : ''}`;
    case 'objective':
      return `◎ ${e.text}`;
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
    logs[seat].push({ text, at, cls: e.type === 'turnStart' || e.type === 'gameOver' || e.type === 'phase' ? 'turn' : owner === null ? '' : owner === seat ? 'mine' : 'theirs' });
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
  // 本機模式：回到主選單
  if (local) return showMenu();
  // 連線房間：回到選隊，雙方各自選好隊伍加入
  clearAndReset();
}

/** 開一場本機對戰（第一次建立，之後重設同一個對局物件） */
function startLocal(rosters: LocalGame['rosters'], opponent: Opponent, settings: LocalGame['settings'], scenario: Scenario | undefined, startSeat: PlayerId) {
  if (!local) local = new LocalGame(onMessage, opponent, rosters, settings, scenario);
  else {
    local.rosters = rosters;
    local.opponent = opponent;
    local.settings = settings;
    local.scenario = scenario;
    clearAndReset();
  }
  switchSeat(startSeat);
}

/** 主選單：自由對戰走出擊準備；重演戰役直接照劇本開打 */
function showMenu() {
  openMenu({
    free: () =>
      openLineup(local?.opponent === 'aiA' ? 'ai' : (local?.opponent ?? initialOpponent()), (rosters, opponent, settings) => {
        saveOpponent(opponent);
        startLocal(rosters, opponent, settings, undefined, 0);
      }),
    scenario: (sc: Scenario, side: Side) => startLocal(sc.rosters(), side === 'watch' ? 'aivai' : side === 0 ? 'ai' : 'aiA', sc.settings(), sc, side === 1 ? 1 : 0),
    help: () => setHelp(true),
  });
}

function clearAndReset(reset = true) {
  logs[0].length = 0;
  logs[1].length = 0;
  replays[0].length = 0;
  replays[1].length = 0;
  replayQueue = null;
  replayNow = null;
  savedViews[0] = savedViews[1] = null;
  draftKey = '';
  renderLog();
  if (reset) sendMsg({ t: 'reset' });
}

$('resetBtn').onclick = () => {
  if (local) restart();
  else restart();
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
function saveOpponent(o: Opponent) {
  try {
    localStorage.setItem(OPPONENT_KEY, o);
  } catch {}
}
// 對手改在出擊準備畫面選
opponentSel.hidden = true;

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
  if (!localStorage.getItem(HELP_KEY) && !recordId && !recordList) setHelp(true);
} catch {
  if (!recordId && !recordList) setHelp(true);
}

// 開發用：在主控台用 __mech.local() 取得本機對戰（正式建置不會有）
if (import.meta.env.DEV) (window as unknown as { __mech: object }).__mech = { local: () => local };

// 關掉分頁時，打到一半的對局也上傳紀錄
addEventListener('pagehide', () => local?.upload());

// ---------- 對戰紀錄：清單與重播 ----------

let player: RecordPlayer | null = null;
let recordAuto = false;
const SIDE_NAME = ['A 方', 'B 方'];

/** 讀不到（沒有金鑰或金鑰不對）：在畫面中間請使用者輸入管理金鑰 */
function keyForm(message: string, retry: () => void) {
  const cover = $('cover');
  cover.hidden = false;
  cover.innerHTML = `<div class="recBox"><p>${esc(message)}</p><p class="muted small">對戰紀錄要用管理金鑰才看得到（和機庫編輯器同一把）。</p>
    <div class="row"><input id="recKey" type="password" placeholder="管理金鑰" style="flex:1"><button class="primary" id="recKeyBtn">確定</button></div>
    <p><a href="./">‹ 主選單</a></p></div>`;
  $('recKeyBtn').onclick = () => {
    const key = ($('recKey') as HTMLInputElement).value.trim();
    if (!key) return;
    setAdminKey(key);
    retry();
  };
}

async function showRecordList() {
  const cover = $('cover');
  cover.hidden = false;
  cover.innerHTML = '<div class="recBox"><p>讀取對戰紀錄…</p></div>';
  try {
    const rows = await listBattles();
    const win = (w: string | null) => (w === 'A' ? 'A 勝' : w === 'B' ? 'B 勝' : w === 'draw' ? '平手' : '未完');
    const body = rows
      .map((r) => `<tr><td><a href="?replay=${r.id}">#${r.id}</a></td><td>${esc(r.created_at)}</td><td>${esc(r.room ?? r.opponent)}</td><td>${win(r.winner)}</td><td>${r.turns}</td><td>${r.notes ?? 0}</td><td class="muted">${esc(r.content_version)}</td></tr>`)
      .join('');
    cover.innerHTML = `<div class="recBox recWide"><div class="mnHead"><a href="./">‹ 主選單</a><b>對戰紀錄（最近 ${rows.length} 場）</b></div>
      <table class="recTable"><tr><th>編號</th><th>時間（UTC）</th><th>房間／對手</th><th>結果</th><th>回合</th><th>留言</th><th>資料</th></tr>${body}</table></div>`;
  } catch (e) {
    keyForm((e as Error).message, () => void showRecordList());
  }
}

async function openRecord(id: number) {
  const cover = $('cover');
  cover.hidden = false;
  cover.innerHTML = '<div class="recBox"><p>讀取紀錄…</p></div>';
  try {
    const rec = await loadBattle(id);
    // 紀錄用的資料版本和現在的不一樣：發佈過的版本可以抓回來，內建的舊版就只能照現在的規則重播
    if (rec.contentVersion !== contentVersion() && !rec.contentVersion.startsWith('builtin')) await loadContent(rec.contentVersion);
    player = new RecordPlayer(rec, onMessage);
    cover.hidden = true;
    player.begin();
    mountRecordBar();
  } catch (e) {
    keyForm((e as Error).message, () => void openRecord(id));
  }
}

function recordStep(dir: 'first' | 'prev' | 'next') {
  if (!player) return;
  if (dir === 'next') {
    if (show) skipShow();
    player.next();
  } else {
    stopShow();
    pendingView = null;
    player.seek(dir === 'first' ? 0 : player.shown - 1);
  }
  renderRecordBar();
}

function mountRecordBar() {
  const bar = document.createElement('div');
  bar.id = 'recordBar';
  bar.innerHTML = `<a href="?replays">‹ 清單</a><button data-rec="first">⏮</button><button data-rec="prev">◀ 上一步</button><button data-rec="next">下一步 ▶</button><button data-rec="auto">自動播放</button><span id="recLabel"></span>`;
  const notes = document.createElement('div');
  notes.id = 'notesBox';
  $('stage').append(bar, notes);
  bar.onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest('button');
    if (!b) return;
    if (b.dataset.rec === 'auto') {
      recordAuto = !recordAuto;
      renderRecordBar();
    } else recordStep(b.dataset.rec as 'first' | 'prev' | 'next');
  };
  // 自動播放：演出播完就接下一步
  setInterval(() => {
    if (!player || !recordAuto || show) return;
    if (player.shown >= player.frames.length) recordAuto = false;
    else player.next();
    renderRecordBar();
  }, 700);
  renderRecordBar();
}

function noteHtml(n: { seat: PlayerId; squad?: number; text: string }) {
  return `<div class="note"><b class="${n.seat === 0 ? 'mine' : ''}">${SIDE_NAME[n.seat]}${n.squad ? `第 ${n.squad} 小隊` : ''}</b><div>${esc(n.text)}</div></div>`;
}

function renderRecordBar() {
  if (!player) return;
  const f = player.current;
  const total = player.frames.length;
  $('recLabel').textContent = `${f ? `第 ${f.turn} 回合・${PHASE_NAME[f.phase]}` : '開場'}（${player.shown}/${total}）${player.rec.room ? `・房間 ${player.rec.room}` : ''}`;
  const auto = document.querySelector<HTMLButtonElement>('#recordBar [data-rec="auto"]');
  if (auto) auto.classList.toggle('on', recordAuto);
  const now = player.notesNow();
  const next = player.notesNext();
  const nf = player.frames[player.shown];
  let html = player.errors.length ? `<div class="warn small">重播和紀錄對不上（規則可能改過）：${esc(player.errors.join('；'))}</div>` : '';
  html += `<div class="sec">${f ? `這一步（第 ${f.turn} 回合・${PHASE_NAME[f.phase]}）的想法` : '開場'}</div>${now.map(noteHtml).join('') || '<div class="muted small">沒有留言</div>'}`;
  const over = player.notesOver();
  if (over.length) html += `<div class="sec">結束後的感想</div>${over.map(noteHtml).join('')}`;
  if (nf) html += `<div class="sec">下一步（第 ${nf.turn} 回合・${PHASE_NAME[nf.phase]}）的打算</div>${next.map(noteHtml).join('') || '<div class="muted small">沒有留言</div>'}`;
  $('notesBox').innerHTML = html;
}

if (recordList || recordId) {
  void loadContent(null).then(({ version, note }) => {
    const tag = $('contentTag');
    tag.textContent = `資料 ${version}`;
    tag.title = note;
    if (recordId) void openRecord(recordId);
    else void showRecordList();
  });
} else if (mode === 'local') {
  // 預設用原創內建資料；?content=latest 抓線上最新版（封存的鋼彈資料），?content=0.1.4 指定版本
  void loadContent(params.get('content')).then(({ version, note }) => {
    const tag = $('contentTag');
    tag.textContent = `資料 ${version}`;
    tag.title = note;
    showMenu();
  });
} else {
  // 連線房間：用和伺服器相同的資料包（預設都是線上最新版）
  void loadContent(params.get('content')).then(({ version, note }) => {
    const tag = $('contentTag');
    tag.textContent = `資料 ${version}`;
    tag.title = note;
    connect();
  });
}
requestAnimationFrame(drawFrame);
