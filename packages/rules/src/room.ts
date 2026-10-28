// 對戰房間：一個房間一個 Match。本機伺服器（Node 的 ws）和 Cloudflare Durable Object 共用這一層，只有連線的接法不同。
// 瀏覽器的出擊準備畫面送 join（開房模式）或 setup（直接指定雙方陣容）開新的一場。
import { CHASSIS, EQUIPMENT, PILOTS } from './data';
import { Match } from './match';
import { lineupProblems, type BattleSettings } from './objectives';
import type { ClientMessage, RoomTerms, ServerMessage } from './protocol';
import { createGame } from './setup';
import type { RosterEntry } from './data';
import type { PlayerId } from './types';

/** 一條連線：只要能送字串、能關掉 */
export interface RoomSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RoomSeat = PlayerId | 'watch';

/** 隊伍裡每台的機型、駕駛、裝備都認得 */
const knownRoster = (r: unknown): r is RosterEntry[] =>
  Array.isArray(r) && r.length > 0 && r.every((e) => e && CHASSIS[e.chassis] && PILOTS[e.pilot] && Array.isArray(e.equipment) && e.equipment.every(([d]: [string]) => EQUIPMENT[d]));

const seedOf = () => (Math.random() * 2 ** 32) >>> 0;
function newMatch(rosters: [RosterEntry[], RosterEntry[]], settings?: BattleSettings): Match {
  const seed = seedOf();
  return new Match(seed, createGame(seed, rosters, settings));
}

export class Room {
  /** 還沒開打（雙方選隊中）時是 null */
  match: Match | null = null;
  /** 開房模式：雙方加入的隊伍與房主的條件 */
  lobby: { rosters: [RosterEntry[] | null, RosterEntry[] | null]; terms: RoomTerms | null } = { rosters: [null, null], terms: null };
  /** 房間裡第幾場 */
  game = 0;
  sockets: [RoomSocket | null, RoomSocket | null] = [null, null];
  /** 觀戰的連線（只看不下指令，雙方都看得到） */
  watchers = new Set<RoomSocket>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  deadline: number | null = null;

  /** turnSeconds：每一步的時限（0 = 不計時）；log：連線、開打的紀錄 */
  constructor(
    private readonly turnSeconds = 0,
    private readonly log: (text: string) => void = () => {},
  ) {}

  /** 新連線：回傳收到訊息、斷線時要呼叫的函式 */
  connect(ws: RoomSocket, seat: RoomSeat): { message(text: string): void; close(): void } {
    if (seat === 'watch') {
      this.watchers.add(ws);
      this.log('watcher connected');
      this.broadcastState();
      return { message: () => {}, close: () => this.watchers.delete(ws) };
    }
    this.sockets[seat]?.close(4000, '同一席位有新的連線');
    this.sockets[seat] = ws;
    this.log(`seat ${seat} connected`);
    this.broadcastState();
    return {
      message: (text) => this.onMessage(ws, seat, text),
      close: () => {
        if (this.sockets[seat] === ws) this.sockets[seat] = null;
        this.broadcastState();
      },
    };
  }

  private onMessage(ws: RoomSocket, seat: PlayerId, text: string) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    // 重開：回到選隊（保留房主上次的條件）；setup：直接用指定的雙方陣容開打
    if (msg.t === 'reset' || msg.t === 'setup') {
      try {
        if (msg.t === 'setup') this.match = newMatch(msg.rosters, msg.settings);
        else {
          this.match = null;
          this.lobby.rosters = [null, null];
        }
        this.game++;
      } catch (e) {
        send(ws, { t: 'error', errors: [`陣容不正確：${(e as Error).message}`] });
        return;
      }
      this.log(`seat ${seat} ${msg.t}`);
      this.armTimer();
      this.broadcastState();
      return;
    }
    if (msg.t === 'join') {
      const errors = this.join(seat, msg.roster, msg.terms);
      if (errors.length) send(ws, { t: 'error', errors });
      else this.log(`seat ${seat} joined${this.match ? '，開打' : ''}`);
      this.armTimer();
      this.broadcastState();
      return;
    }
    if (!this.match) {
      send(ws, { t: 'error', errors: ['還沒開打：雙方都選好隊伍加入後才開始'] });
      return;
    }
    const prev = this.match.resolvedCount;
    const phase = this.match.phase;
    let errors: string[] = [];
    if (msg.t === 'moves') errors = this.match.submitMoves(seat, msg.moves);
    else if (msg.t === 'deploy') errors = this.match.submitDeploy(seat, msg.deploy);
    else if (msg.t === 'pursuits') errors = this.match.submitPursuits(seat, msg.pursuits);
    else if (msg.t === 'actions') errors = this.match.submitActions(seat, msg.actions);
    if (errors.length) send(ws, { t: 'error', errors });
    this.afterChange(prev, phase);
  }

  /** 開房模式：有人加入；雙方都到齊就檢查陣容並開打 */
  private join(seat: PlayerId, roster: unknown, terms: RoomTerms | undefined): string[] {
    if (this.match) return ['這一場已經開打了'];
    if (!knownRoster(roster)) return ['隊伍裡有不認得的機型、駕駛或裝備'];
    if (seat === 0) {
      if (!terms) return ['房主要決定對戰條件'];
      this.lobby.terms = terms;
    }
    this.lobby.rosters[seat] = roster;
    const [a, b] = this.lobby.rosters;
    const t = this.lobby.terms;
    if (!a || !b || !t) return [];
    const problems = ([0, 1] as PlayerId[]).flatMap((p) => lineupProblems(this.lobby.rosters[p]!, t.scale, t.settings).map((x) => ({ p, x })));
    if (problems.length) {
      for (const p of new Set(problems.map((x) => x.p))) {
        this.lobby.rosters[p] = null;
        send(this.sockets[p], { t: 'error', errors: problems.filter((x) => x.p === p).map((x) => `陣容不符合房主的條件：${x.x}`) });
      }
      return [];
    }
    this.match = newMatch([a, b], t.settings);
    this.game++;
    return [];
  }

  broadcastState() {
    const connected = this.sockets.map((s) => !!s) as [boolean, boolean];
    const lobby: ServerMessage = { t: 'lobby', joined: this.lobby.rosters.map((r) => !!r) as [boolean, boolean], terms: this.lobby.terms, connected, game: this.game };
    for (const p of [0, 1] as PlayerId[]) send(this.sockets[p], this.match ? { t: 'state', view: this.match.viewFor(p), connected, deadline: this.deadline, game: this.game } : lobby);
    for (const w of this.watchers) send(w, this.match ? { t: 'state', view: this.match.spectatorView(), connected, deadline: this.deadline, game: this.game } : lobby);
  }

  private afterChange(prevResolved: number, prevPhase: string) {
    if (!this.match) return this.broadcastState();
    if (this.match.resolvedCount !== prevResolved) {
      for (const p of [0, 1] as PlayerId[]) send(this.sockets[p], { t: 'resolved', events: this.match.eventsFor(p) });
      for (const w of this.watchers) send(w, { t: 'resolved', events: this.match.spectatorEvents() });
    }
    if (this.match.resolvedCount !== prevResolved || this.match.phase !== prevPhase) this.armTimer();
    this.broadcastState();
  }

  private armTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
    if (!this.turnSeconds || !this.match || this.match.phase === 'over') return;
    this.deadline = Date.now() + this.turnSeconds * 1000;
    this.timer = setTimeout(() => {
      if (!this.match) return;
      const prev = this.match.resolvedCount;
      const phase = this.match.phase;
      this.match.forceLock();
      this.afterChange(prev, phase);
    }, this.turnSeconds * 1000);
  }
}

function send(ws: RoomSocket | null, msg: ServerMessage) {
  if (!ws) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // 連線已經關了
  }
}
