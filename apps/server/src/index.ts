// 本機替身伺服器：一個房間一個 Match，日後換成 Cloudflare Durable Object 時只換這層。
// 開場前讀資料包：PACK=檔案路徑，否則抓線上最新版（抓不到就用內建資料）。瀏覽器的出擊準備畫面送 setup 開新的一場。
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { Match, contentVersion, createGame, useContent, type BattleSettings, type ClientMessage, type ContentPack, type PlayerId, type RosterEntry, type ServerMessage } from '@mech/rules';

const API = process.env.MECH_API ?? 'https://mech-wing-api.darkbearlab.workers.dev';
try {
  const pack = process.env.PACK ? JSON.parse(readFileSync(process.env.PACK, 'utf-8')) : await (await fetch(`${API}/packs/latest`)).json();
  useContent(pack as ContentPack);
} catch (e) {
  console.warn('資料包讀取失敗，改用內建資料', e);
}
console.log(`資料 ${contentVersion()}`);

const PORT = Number(process.env.MECH_SERVER_PORT ?? 8787);
const TURN_SECONDS = Number(process.env.TURN_SECONDS ?? 0); // 0 = 不計時

interface Room {
  match: Match;
  /** 房間裡第幾場 */
  game: number;
  sockets: [WebSocket | null, WebSocket | null];
  timer: NodeJS.Timeout | null;
  deadline: number | null;
}

const rooms = new Map<string, Room>();

function newRoom(rosters?: [RosterEntry[], RosterEntry[]], settings?: BattleSettings): Room {
  const seed = (Math.random() * 2 ** 32) >>> 0;
  return { match: new Match(seed, rosters ? createGame(seed, rosters, settings) : undefined), game: 0, sockets: [null, null], timer: null, deadline: null };
}

function send(ws: WebSocket | null, msg: ServerMessage) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastState(room: Room) {
  for (const p of [0, 1] as PlayerId[]) send(room.sockets[p], { t: 'state', view: room.match.viewFor(p), connected: room.sockets.map((s) => !!s) as [boolean, boolean], deadline: room.deadline, game: room.game });
}

function afterChange(room: Room, prevResolved: number, prevPhase: string) {
  if (room.match.resolvedCount !== prevResolved) {
    for (const p of [0, 1] as PlayerId[]) send(room.sockets[p], { t: 'resolved', events: room.match.eventsFor(p) });
  }
  if (room.match.resolvedCount !== prevResolved || room.match.phase !== prevPhase) armTimer(room);
  broadcastState(room);
}

function armTimer(room: Room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.deadline = null;
  if (!TURN_SECONDS || room.match.phase === 'over') return;
  room.deadline = Date.now() + TURN_SECONDS * 1000;
  room.timer = setTimeout(() => {
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
    const prev = r.match.resolvedCount;
    const phase = r.match.phase;
    let errors: string[] = [];
    if (msg.t === 'moves') errors = r.match.submitMoves(seat, msg.moves);
    else if (msg.t === 'deploy') errors = r.match.submitDeploy(seat, msg.deploy);
    else if (msg.t === 'pursuits') errors = r.match.submitPursuits(seat, msg.pursuits);
    else if (msg.t === 'actions') errors = r.match.submitActions(seat, msg.actions);
    else if (msg.t === 'reset' || msg.t === 'setup') {
      try {
        r.match = (msg.t === 'setup' ? newRoom(msg.rosters, msg.settings) : newRoom()).match;
        r.game++;
      } catch (e) {
        send(ws, { t: 'error', errors: [`陣容不正確：${(e as Error).message}`] });
        return;
      }
      console.log(`[${roomId}] new match（seat ${seat} ${msg.t}）`);
      armTimer(r);
      broadcastState(r);
      return;
    }
    if (errors.length) send(ws, { t: 'error', errors });
    afterChange(r, prev, phase);
  });

  ws.on('close', () => {
    if (r.sockets[seat] === ws) r.sockets[seat] = null;
    broadcastState(r);
  });
});

console.log(`mech-wing server on ws://localhost:${PORT}/ws${TURN_SECONDS ? ` (turn timer ${TURN_SECONDS}s)` : ''}`);
