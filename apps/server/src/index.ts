// 本機替身伺服器：一個房間一個 Match，日後換成 Cloudflare Durable Object 時只換這層。
// 開場前讀資料包：預設是原創內建資料；PACK=檔案路徑讀那個檔案，PACK=latest 抓線上最新版（已封存的鋼彈資料）。
// 瀏覽器的出擊準備畫面送 setup 開新的一場。
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { CHASSIS, EQUIPMENT, Match, PILOTS, contentVersion, createGame, lineupProblems, useContent, type BattleSettings, type ClientMessage, type ContentPack, type PlayerId, type RoomTerms, type RosterEntry, type ServerMessage } from '@mech/rules';

const API = process.env.MECH_API ?? 'https://mech-wing-api.darkbearlab.workers.dev';
try {
  const src = process.env.PACK;
  if (src) useContent((src === 'latest' ? await (await fetch(`${API}/packs/latest`)).json() : JSON.parse(readFileSync(src, 'utf-8'))) as ContentPack);
} catch (e) {
  console.warn('資料包讀取失敗，改用內建資料', e);
}
console.log(`資料 ${contentVersion()}`);

const PORT = Number(process.env.MECH_SERVER_PORT ?? 8787);
const TURN_SECONDS = Number(process.env.TURN_SECONDS ?? 0); // 0 = 不計時

interface Room {
  /** 還沒開打（雙方選隊中）時是 null */
  match: Match | null;
  /** 開房模式：雙方加入的隊伍與房主的條件 */
  lobby: { rosters: [RosterEntry[] | null, RosterEntry[] | null]; terms: RoomTerms | null };
  /** 房間裡第幾場 */
  game: number;
  sockets: [WebSocket | null, WebSocket | null];
  /** 觀戰的連線（只看不下指令，雙方都看得到） */
  watchers: Set<WebSocket>;
  timer: NodeJS.Timeout | null;
  deadline: number | null;
}

const rooms = new Map<string, Room>();

const seedOf = () => (Math.random() * 2 ** 32) >>> 0;
function newMatch(rosters: [RosterEntry[], RosterEntry[]], settings?: BattleSettings): Match {
  const seed = seedOf();
  return new Match(seed, createGame(seed, rosters, settings));
}

/** 新房間：等雙方選隊加入 */
function newRoom(): Room {
  return { match: null, lobby: { rosters: [null, null], terms: null }, game: 0, sockets: [null, null], watchers: new Set(), timer: null, deadline: null };
}

/** 隊伍裡每台的機型、駕駛、裝備都認得 */
const knownRoster = (r: unknown): r is RosterEntry[] =>
  Array.isArray(r) && r.length > 0 && r.every((e) => e && CHASSIS[e.chassis] && PILOTS[e.pilot] && Array.isArray(e.equipment) && e.equipment.every(([d]: [string]) => EQUIPMENT[d]));

/** 開房模式：有人加入；雙方都到齊就檢查陣容並開打 */
function join(room: Room, seat: PlayerId, roster: unknown, terms: RoomTerms | undefined): string[] {
  if (room.match) return ['這一場已經開打了'];
  if (!knownRoster(roster)) return ['隊伍裡有不認得的機型、駕駛或裝備'];
  if (seat === 0) {
    if (!terms) return ['房主要決定對戰條件'];
    room.lobby.terms = terms;
  }
  room.lobby.rosters[seat] = roster;
  const [a, b] = room.lobby.rosters;
  const t = room.lobby.terms;
  if (!a || !b || !t) return [];
  const problems = ([0, 1] as PlayerId[]).flatMap((p) => lineupProblems(room.lobby.rosters[p]!, t.scale, t.settings).map((x) => ({ p, x })));
  if (problems.length) {
    for (const p of new Set(problems.map((x) => x.p))) {
      room.lobby.rosters[p] = null;
      send(room.sockets[p], { t: 'error', errors: problems.filter((x) => x.p === p).map((x) => `陣容不符合房主的條件：${x.x}`) });
    }
    return [];
  }
  room.match = newMatch([a, b], t.settings);
  room.game++;
  return [];
}

function send(ws: WebSocket | null, msg: ServerMessage) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastState(room: Room) {
  const connected = room.sockets.map((s) => !!s) as [boolean, boolean];
  for (const p of [0, 1] as PlayerId[]) {
    if (!room.match) send(room.sockets[p], { t: 'lobby', joined: room.lobby.rosters.map((r) => !!r) as [boolean, boolean], terms: room.lobby.terms, connected, game: room.game });
    else send(room.sockets[p], { t: 'state', view: room.match.viewFor(p), connected, deadline: room.deadline, game: room.game });
  }
  for (const w of room.watchers) {
    if (!room.match) send(w, { t: 'lobby', joined: room.lobby.rosters.map((r) => !!r) as [boolean, boolean], terms: room.lobby.terms, connected, game: room.game });
    else send(w, { t: 'state', view: room.match.spectatorView(), connected, deadline: room.deadline, game: room.game });
  }
}

function afterChange(room: Room, prevResolved: number, prevPhase: string) {
  if (!room.match) return broadcastState(room);
  if (room.match.resolvedCount !== prevResolved) {
    for (const p of [0, 1] as PlayerId[]) send(room.sockets[p], { t: 'resolved', events: room.match.eventsFor(p) });
    for (const w of room.watchers) send(w, { t: 'resolved', events: room.match.spectatorEvents() });
  }
  if (room.match.resolvedCount !== prevResolved || room.match.phase !== prevPhase) armTimer(room);
  broadcastState(room);
}

function armTimer(room: Room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.deadline = null;
  if (!TURN_SECONDS || !room.match || room.match.phase === 'over') return;
  room.deadline = Date.now() + TURN_SECONDS * 1000;
  room.timer = setTimeout(() => {
    if (!room.match) return;
    const prev = room.match.resolvedCount;
    const phase = room.match.phase;
    room.match.forceLock();
    afterChange(room, prev, phase);
  }, TURN_SECONDS * 1000);
}

const wss = new WebSocketServer({ port: PORT, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const roomId = url.searchParams.get('room') || 'test';
  const seat = (Number(url.searchParams.get('seat')) === 1 ? 1 : 0) as PlayerId;
  let room = rooms.get(roomId);
  if (!room) {
    room = newRoom();
    rooms.set(roomId, room);
    armTimer(room);
  }
  const r = room;
  // 觀戰：只收狀態，不能下指令
  if (url.searchParams.get('seat') === 'watch') {
    r.watchers.add(ws);
    console.log(`[${roomId}] watcher connected`);
    broadcastState(r);
    ws.on('close', () => r.watchers.delete(ws));
    return;
  }
  r.sockets[seat]?.close(4000, '同一席位有新的連線');
  r.sockets[seat] = ws;
  console.log(`[${roomId}] seat ${seat} connected`);
  broadcastState(r);

  ws.on('message', (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    // 重開：回到選隊（保留房主上次的條件）；setup：直接用指定的雙方陣容開打
    if (msg.t === 'reset' || msg.t === 'setup') {
      try {
        if (msg.t === 'setup') r.match = newMatch(msg.rosters, msg.settings);
        else {
          r.match = null;
          r.lobby.rosters = [null, null];
        }
        r.game++;
      } catch (e) {
        send(ws, { t: 'error', errors: [`陣容不正確：${(e as Error).message}`] });
        return;
      }
      console.log(`[${roomId}] seat ${seat} ${msg.t}`);
      armTimer(r);
      broadcastState(r);
      return;
    }
    if (msg.t === 'join') {
      const errors = join(r, seat, msg.roster, msg.terms);
      if (errors.length) send(ws, { t: 'error', errors });
      else console.log(`[${roomId}] seat ${seat} joined${r.match ? '，開打' : ''}`);
      armTimer(r);
      broadcastState(r);
      return;
    }
    if (!r.match) {
      send(ws, { t: 'error', errors: ['還沒開打：雙方都選好隊伍加入後才開始'] });
      return;
    }
    const prev = r.match.resolvedCount;
    const phase = r.match.phase;
    let errors: string[] = [];
    if (msg.t === 'moves') errors = r.match.submitMoves(seat, msg.moves);
    else if (msg.t === 'deploy') errors = r.match.submitDeploy(seat, msg.deploy);
    else if (msg.t === 'pursuits') errors = r.match.submitPursuits(seat, msg.pursuits);
    else if (msg.t === 'actions') errors = r.match.submitActions(seat, msg.actions);
    if (errors.length) send(ws, { t: 'error', errors });
    afterChange(r, prev, phase);
  });

  ws.on('close', () => {
    if (r.sockets[seat] === ws) r.sockets[seat] = null;
    broadcastState(r);
  });
});

console.log(`mech-wing server on ws://localhost:${PORT}/ws${TURN_SECONDS ? ` (turn timer ${TURN_SECONDS}s)` : ''}`);
