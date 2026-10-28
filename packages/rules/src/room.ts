// 對戰房間：一個房間一個 Match。本機伺服器（Node 的 ws）和 Cloudflare Durable Object 共用這一層，只有連線的接法不同。
// 瀏覽器的出擊準備畫面送 join（開房模式）或 setup（直接指定雙方陣容）開新的一場。
//
// 席位：0、1 是 A、B 方；一方分成幾個小隊時，第 2 個小隊起是 0-1、0-2…（0 就是 0-0）。
// 每個席位只指揮自己小隊的機體，視野和勝負照整方算。沒人坐的小隊可以交給電腦（ai）。
import { aiOrders } from './ai';
import { CHASSIS, EQUIPMENT, PILOTS } from './data';
import { Match, ordersBySquad, squadsOf, type Orders } from './match';
import { contentVersion } from './content';
import { MAX_NOTE_CHARS, replayRecord, submitStep, type BattleRecord, type BattleStep } from './record';
import { lineupProblems, squadShare, type BattleSettings } from './objectives';
import type { ClientMessage, RoomTerms, SeatInfo, ServerMessage } from './protocol';
import { Rng } from './rng';
import { createGame } from './setup';
import type { RosterEntry } from './data';
import type { PlayerId, TurnPhase } from './types';

/** 一條連線：只要能送字串、能關掉 */
export interface RoomSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** 0、1、'0-1' 這類小隊席位，或觀戰 */
export type RoomSeat = PlayerId | string | 'watch';

interface Seat {
  side: PlayerId;
  squad: number;
}

/** 席位名稱：第 0 小隊就是 0、1，其他是「方-小隊」 */
export const seatKey = (side: PlayerId, squad: number): string => (squad ? `${side}-${squad}` : `${side}`);

/** 解析席位參數；認不得的當作 A 方（和以前一樣） */
export function parseSeat(seat: RoomSeat | null | undefined): Seat | 'watch' {
  if (seat === 'watch') return 'watch';
  const m = /^([01])(?:-(\d{1,2}))?$/.exec(String(seat ?? '0'));
  if (!m) return { side: 0, squad: 0 };
  return { side: Number(m[1]) as PlayerId, squad: Number(m[2] ?? 0) };
}

/** 隊伍裡每台的機型、駕駛、裝備都認得 */
const knownRoster = (r: unknown): r is RosterEntry[] =>
  Array.isArray(r) && r.length > 0 && r.every((e) => e && CHASSIS[e.chassis] && PILOTS[e.pilot] && Array.isArray(e.equipment) && e.equipment.every(([d]: [string]) => EQUIPMENT[d]));

const seedOf = () => (Math.random() * 2 ** 32) >>> 0;

/** 每方的小隊數（開房條件沒寫就是一方一個） */
const squadCounts = (terms: RoomTerms | null): [number, number] => {
  const n = terms?.squads ?? [1, 1];
  return [Math.max(1, Math.min(8, n[0] | 0)), Math.max(1, Math.min(8, n[1] | 0))];
};

export class Room {
  /** 還沒開打（雙方選隊中）時是 null */
  match: Match | null = null;
  /** 開房模式：各席位加入的隊伍與房主的條件 */
  lobby: { rosters: Record<string, RosterEntry[]>; terms: RoomTerms | null } = { rosters: {}, terms: null };
  /** 房間裡第幾場 */
  game = 0;
  /** 各席位的連線（key 是席位名稱） */
  sockets = new Map<string, RoomSocket>();
  /** 觀戰的連線（只看不下指令，雙方都看得到） */
  watchers = new Set<RoomSocket>();
  /** 電腦指揮的小隊（席位名稱） */
  aiSeats = new Set<string>();
  private aiRng = new Rng(1);
  /** 這一場的對戰紀錄（種子、陣容、每一步的指令與留言）；結束時交給 onRecord 存起來 */
  record: BattleRecord | null = null;
  private recordDone = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  deadline: number | null = null;

  /**
   * turnSeconds：每一步的時限（0 = 不計時）；log：連線、開打的紀錄；
   * onRecord：對戰結束（或中途重開）時存紀錄，結束後又有人留言時再呼叫一次；name：房間名稱（寫進紀錄）
   */
  constructor(
    private readonly turnSeconds = 0,
    private readonly log: (text: string) => void = () => {},
    /** inProgress：還在打（每結算一次存的進度）；false 是結束或中途放棄的最終版本 */
    private readonly onRecord: (rec: BattleRecord, inProgress: boolean) => void = () => {},
    private readonly name?: string,
  ) {}

  /**
   * 房間重啟（伺服器回收了房間）後接著打：照紀錄重算到最後一次結算。
   * 最後一次結算之後才送出的指令丟掉（雙方重送就好）。重算對不上就不接（回傳 false）
   */
  restore(rec: BattleRecord): boolean {
    // 找出最後一次結算是第幾步
    const probe = new Match(rec.seed, createGame(rec.seed, rec.rosters, rec.settings));
    let resolved = 0;
    for (const [i, s] of rec.steps.entries()) {
      const before = probe.resolvedCount;
      if (submitStep(probe, s).length) break;
      if (probe.resolvedCount !== before) resolved = i + 1;
    }
    const kept: BattleRecord = { ...rec, steps: rec.steps.slice(0, resolved) };
    const { match, errors } = replayRecord(kept);
    if (errors.length) {
      this.log(`restore failed: ${errors.join('；')}`);
      return false;
    }
    this.match = match;
    this.record = kept;
    this.recordDone = match.phase === 'over';
    this.aiSeats = new Set(rec.aiSeats ?? []);
    this.aiRng = new Rng((rec.seed ^ 0x5a5a5a5a ^ resolved) >>> 0);
    this.game++;
    this.runAi();
    this.broadcastState();
    return true;
  }

  /** 送出一步並記進紀錄 */
  private submit(side: PlayerId, squad: number | undefined, phase: TurnPhase, orders: BattleStep['orders']): string[] {
    const m = this.match!;
    const errors =
      phase === 'move' || phase === 'ace'
        ? m.submitMoves(side, orders as never, squad)
        : phase === 'pursuit'
          ? m.submitPursuits(side, orders as never, squad)
          : phase === 'deploy'
            ? m.submitDeploy(side, orders as never, squad)
            : m.submitActions(side, orders as never, squad);
    if (!errors.length && this.record) this.record.steps.push({ seat: side, ...(squad === undefined ? {} : { squad }), phase, orders: structuredClone(orders) });
    return errors;
  }

  private addNote(seat: Seat, phase: TurnPhase | 'over', text: unknown, turn = this.match?.state.turn ?? 0) {
    if (!this.record || typeof text !== 'string' || !text.trim()) return;
    const squad = this.squadFor(seat);
    (this.record.notes ??= []).push({ seat: seat.side, ...(squad === undefined ? {} : { squad }), turn, phase, text: text.trim().slice(0, MAX_NOTE_CHARS) });
  }

  /** 對戰結束、或打到一半重開：把紀錄交出去（結束後再有留言就再交一次） */
  private saveRecord(force = false, abandoned = false) {
    const m = this.match;
    if (!m || !this.record || !this.record.steps.length) return;
    const over = m.phase === 'over';
    if (!over && !force) return;
    if (over && this.recordDone && !force) return;
    this.recordDone = over;
    this.record.winner = m.state.winner;
    this.record.turns = m.state.turn;
    try {
      this.onRecord(structuredClone(this.record), !over && !abandoned);
    } catch (e) {
      this.log(`save record failed: ${(e as Error).message}`);
    }
  }

  /** 新連線：回傳收到訊息、斷線時要呼叫的函式 */
  connect(ws: RoomSocket, seatParam: RoomSeat): { message(text: string): void; close(): void } {
    const seat = parseSeat(seatParam);
    if (seat === 'watch') {
      this.watchers.add(ws);
      this.log('watcher connected');
      this.broadcastState();
      return { message: () => {}, close: () => this.watchers.delete(ws) };
    }
    const key = seatKey(seat.side, seat.squad);
    this.sockets.get(key)?.close(4000, '同一席位有新的連線');
    this.sockets.set(key, ws);
    this.log(`seat ${key} connected`);
    this.broadcastState();
    return {
      message: (text) => this.onMessage(ws, seat, text),
      close: () => {
        if (this.sockets.get(key) === ws) this.sockets.delete(key);
        this.broadcastState();
      },
    };
  }

  /** 開一場：rosters 的 squad 決定小隊；ai 是電腦指揮的席位 */
  private start(rosters: [RosterEntry[], RosterEntry[]], settings: BattleSettings | undefined, ai: string[]) {
    // 上一場打到一半：先存起來
    if (this.match && this.match.phase !== 'over') this.saveRecord(true, true);
    const seed = seedOf();
    this.match = new Match(seed, createGame(seed, rosters, settings));
    this.recordDone = false;
    this.record = {
      format: 1,
      seed,
      contentVersion: contentVersion(),
      rosters: structuredClone(rosters),
      ...(settings ? { settings: structuredClone(settings) } : {}),
      seats: [ai.some((k) => k.startsWith('0')) ? 'ai' : 'human', ai.some((k) => k.startsWith('1')) ? 'ai' : 'human'],
      ...(this.aiSeats.size ? { aiSeats: [...this.aiSeats] } : {}),
      ...(this.name ? { room: this.name } : {}),
      startedAt: new Date().toISOString(),
      steps: [],
      notes: [],
      winner: null,
      turns: 1,
    };
    this.aiRng = new Rng((seed ^ 0xa5a5a5a5) >>> 0);
    this.aiSeats = new Set(ai.map((k) => parseSeat(k)).flatMap((s) => (s === 'watch' ? [] : [seatKey(s.side, s.squad)])));
    this.game++;
    this.runAi();
  }

  private onMessage(ws: RoomSocket, seat: Seat, text: string) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const key = seatKey(seat.side, seat.squad);
    // 重開：回到選隊（保留房主上次的條件）；setup：直接用指定的雙方陣容開打
    if (msg.t === 'reset' || msg.t === 'setup') {
      try {
        if (msg.t === 'setup') this.start(msg.rosters, msg.settings, msg.ai ?? []);
        else {
          if (this.match && this.match.phase !== 'over') this.saveRecord(true, true);
          this.match = null;
          this.lobby.rosters = {};
          this.aiSeats.clear();
          this.game++;
        }
      } catch (e) {
        send(ws, { t: 'error', errors: [`陣容不正確：${(e as Error).message}`] });
        return;
      }
      this.log(`seat ${key} ${msg.t}`);
      this.armTimer();
      this.broadcastState();
      return;
    }
    if (msg.t === 'join') {
      const errors = this.join(seat, msg.roster, msg.terms);
      if (errors.length) send(ws, { t: 'error', errors });
      else this.log(`seat ${key} joined${this.match ? '，開打' : ''}`);
      this.armTimer();
      this.broadcastState();
      return;
    }
    // 留言：隨時都可以（結束後的感想也是）；對戰已經結束就再存一次紀錄
    if (msg.t === 'note') {
      this.addNote(seat, this.match?.phase === 'over' ? 'over' : (this.match?.phase ?? 'over'), msg.text);
      if (this.match?.phase === 'over') this.saveRecord(true);
      return;
    }
    if (!this.match) {
      send(ws, { t: 'error', errors: ['還沒開打：雙方都選好隊伍加入後才開始'] });
      return;
    }
    if (this.aiSeats.has(key)) {
      send(ws, { t: 'error', errors: ['這個小隊由電腦指揮'] });
      return;
    }
    const prev = this.match.resolvedCount;
    const phase = this.match.phase;
    const turn = this.match.state.turn;
    const squad = this.squadFor(seat);
    let errors: string[] = [];
    if (phase === 'over') errors = ['對戰已結束'];
    else if (msg.t === 'moves') errors = this.submit(seat.side, squad, phase, msg.moves);
    else if (msg.t === 'deploy') errors = this.submit(seat.side, squad, phase, msg.deploy);
    else if (msg.t === 'pursuits') errors = this.submit(seat.side, squad, phase, msg.pursuits);
    else if (msg.t === 'actions') errors = this.submit(seat.side, squad, phase, msg.actions);
    if (errors.length) send(ws, { t: 'error', errors });
    else if ('note' in msg) this.addNote(seat, phase, msg.note, turn);
    this.runAi();
    this.afterChange(prev, phase);
  }

  /** 這一方沒分小隊時，席位 0、1 就是替整方下指令（和以前完全一樣） */
  private squadFor(seat: Seat): number | undefined {
    if (!this.match) return undefined;
    return squadsOf(this.match.state, seat.side).length > 1 ? seat.squad : undefined;
  }

  /** 開房模式要到齊的席位 */
  private lobbySeats(): Seat[] {
    const n = squadCounts(this.lobby.terms);
    return ([0, 1] as PlayerId[]).flatMap((side) => Array.from({ length: n[side] }, (_, squad) => ({ side, squad })));
  }

  /** 開房模式：有人加入；所有席位都到齊（含電腦）就檢查陣容並開打 */
  private join(seat: Seat, roster: unknown, terms: RoomTerms | undefined): string[] {
    if (this.match) return ['這一場已經開打了'];
    if (!knownRoster(roster)) return ['隊伍裡有不認得的機型、駕駛或裝備'];
    const key = seatKey(seat.side, seat.squad);
    if (key === '0') {
      if (!terms) return ['房主要決定對戰條件'];
      this.lobby.terms = terms;
      // 房主替電腦小隊選好的隊伍
      for (const k of Object.keys(this.lobby.rosters)) if (this.aiSeats.has(k)) delete this.lobby.rosters[k];
      this.aiSeats.clear();
      for (const [k, r] of Object.entries(terms.ai ?? {})) {
        const s = parseSeat(k);
        if (s === 'watch' || !knownRoster(r)) return [`電腦小隊 ${k} 的隊伍不正確`];
        const bad = lineupProblems(r, terms.scale, terms.settings, squadShare(terms.scale, squadCounts(terms)[s.side]));
        if (squadCounts(terms)[s.side] > 1 && bad.length) return bad.map((x) => `電腦小隊 ${k}：${x}`);
        this.aiSeats.add(seatKey(s.side, s.squad));
        this.lobby.rosters[seatKey(s.side, s.squad)] = r;
      }
      // 比房主早加入的人：照新的條件重新檢查，席位不在了或超出分到的份就請他重選
      const valid = new Set(this.lobbySeats().map((x) => seatKey(x.side, x.squad)));
      for (const k of Object.keys(this.lobby.rosters)) {
        if (k === '0' || this.aiSeats.has(k)) continue;
        const ks = parseSeat(k) as Seat;
        const n = squadCounts(terms)[ks.side];
        const bad = !valid.has(k) ? [`這一場沒有 ${k} 這個席位`] : n > 1 ? lineupProblems(this.lobby.rosters[k], terms.scale, terms.settings, squadShare(terms.scale, n)) : [];
        if (!bad.length) continue;
        delete this.lobby.rosters[k];
        send(this.sockets.get(k) ?? null, { t: 'error', errors: bad.map((x) => `陣容不符合房主的條件：${x}`) });
      }
    } else if (this.lobby.terms && !this.lobbySeats().some((s) => seatKey(s.side, s.squad) === key)) return [`這一場沒有 ${key} 這個席位`];
    if (this.aiSeats.has(key)) return ['這個小隊由電腦指揮'];
    // 分小隊時，預算與台數平均分給各隊，加入時就先檢查自己這一份
    if (this.lobby.terms && squadCounts(this.lobby.terms)[seat.side] > 1) {
      const t = this.lobby.terms;
      const bad = lineupProblems(roster, t.scale, t.settings, squadShare(t.scale, squadCounts(t)[seat.side]));
      if (bad.length) return bad.map((x) => `陣容不符合房主的條件：${x}`);
    }
    this.lobby.rosters[key] = roster;
    const t = this.lobby.terms;
    const seats = this.lobbySeats();
    if (!t || seats.some((s) => !this.lobby.rosters[seatKey(s.side, s.squad)])) return [];
    // 小隊的機體合成整方的陣容（第 0 小隊在前）；只有一個小隊就不標 squad，和以前一樣
    const n = squadCounts(t);
    const rosters = ([0, 1] as PlayerId[]).map((side) =>
      seats.filter((s) => s.side === side).flatMap((s) => this.lobby.rosters[seatKey(s.side, s.squad)].map((e) => (n[side] > 1 ? { ...e, squad: s.squad } : e))),
    ) as [RosterEntry[], RosterEntry[]];
    const problems = ([0, 1] as PlayerId[]).flatMap((p) => lineupProblems(rosters[p], t.scale, t.settings).map((x) => ({ p, x })));
    if (problems.length) {
      for (const p of new Set(problems.map((x) => x.p)))
        for (const s of seats.filter((x) => x.side === p)) {
          const k = seatKey(s.side, s.squad);
          if (this.aiSeats.has(k)) continue;
          delete this.lobby.rosters[k];
          send(this.sockets.get(k) ?? null, { t: 'error', errors: problems.filter((x) => x.p === p).map((x) => `陣容不符合房主的條件：${x.x}`) });
        }
      return [];
    }
    this.start(rosters, t.settings, [...this.aiSeats]);
    return [];
  }

  /**
   * 電腦小隊下指令：同一方的電腦小隊共用一份整方的計畫（和一台電腦指揮整方的結果一樣），各自送出自己那份。
   * 結算後下一步可能又輪到電腦，所以一直做到沒有電腦要下指令為止。
   */
  private runAi() {
    const m = this.match;
    if (!m || !this.aiSeats.size) return;
    // 真人的機體都倒了的話，剩下的整場都在這裡由電腦一路打完（每一步都要有人送出，沒有就停）
    for (let guard = 0; guard < 2000 && m.phase !== 'over'; guard++) {
      let acted = false;
      for (const side of [0, 1] as PlayerId[]) {
        const step = m.resolvedCount;
        const squads = squadsOf(m.state, side).filter((s) => this.aiSeats.has(seatKey(side, s)) && !m.isSubmitted(side, squadsOf(m.state, side).length > 1 ? s : undefined));
        if (!squads.length) continue;
        const parts = ordersBySquad(m.state, side, aiOrders(m.viewFor(side), this.aiRng) as Orders);
        for (const s of squads) {
          if (m.resolvedCount !== step) break;
          const squad = squadsOf(m.state, side).length > 1 ? s : undefined;
          const orders = parts[s] ?? {};
          const errors = this.submit(side, squad, m.phase as TurnPhase, orders);
          if (errors.length) {
            // 不該發生；當作沒事做，免得卡住整場
            this.log(`ai ${seatKey(side, s)} ${errors.join('；')}`);
            m.forceLock();
          }
          acted = true;
        }
      }
      if (!acted) break;
    }
  }

  /** 各席位的狀況（大廳與對戰中都送） */
  private seatInfo(): SeatInfo[] {
    const seats: Seat[] = this.match
      ? ([0, 1] as PlayerId[]).flatMap((side) => squadsOf(this.match!.state, side).map((squad) => ({ side, squad })))
      : this.lobbySeats();
    return seats.map(({ side, squad }) => {
      const key = seatKey(side, squad);
      return { key, side, squad, connected: this.sockets.has(key), joined: !!this.lobby.rosters[key] || !!this.match, ai: this.aiSeats.has(key) };
    });
  }

  broadcastState() {
    const seats = this.seatInfo();
    const connected = ([0, 1] as PlayerId[]).map((p) => seats.some((s) => s.side === p && (s.connected || s.ai))) as [boolean, boolean];
    const multi = seats.length > 2;
    // 大廳：房主還沒定小隊數時先連進來的小隊席位也列出來（不算進到齊與否）
    const extra: SeatInfo[] = this.match
      ? []
      : [...this.sockets.keys()]
          .filter((k) => !seats.some((s) => s.key === k))
          .map((k) => {
            const s = parseSeat(k) as Seat;
            return { key: k, side: s.side, squad: s.squad, connected: true, joined: !!this.lobby.rosters[k], ai: false };
          });
    // 電腦小隊的隊伍只給同一方看
    const terms = this.lobby.terms && { ...this.lobby.terms, ai: undefined };
    const lobbyFor = (side: PlayerId | null, self: string | null): ServerMessage => ({
      t: 'lobby',
      joined: ([0, 1] as PlayerId[]).map((p) => seats.filter((s) => s.side === p).every((s) => s.joined)) as [boolean, boolean],
      terms,
      connected,
      game: this.game,
      seats: [...seats, ...extra].sort((a, b) => a.side - b.side || a.squad - b.squad),
      ...(side === null ? {} : { mates: Object.fromEntries(Object.entries(this.lobby.rosters).filter(([k]) => k !== self && (parseSeat(k) as Seat).side === side)) }),
    });
    for (const [key, ws] of this.sockets) {
      const seat = parseSeat(key) as Seat;
      send(ws, this.match ? { t: 'state', view: this.match.viewFor(seat.side, this.squadFor(seat)), connected, deadline: this.deadline, game: this.game, ...(multi ? { seats } : {}) } : lobbyFor(seat.side, key));
    }
    const lobby = lobbyFor(null, null);
    for (const w of this.watchers) send(w, this.match ? { t: 'state', view: this.match.spectatorView(), connected, deadline: this.deadline, game: this.game, ...(multi ? { seats } : {}) } : lobby);
  }

  private afterChange(prevResolved: number, prevPhase: string) {
    if (!this.match) return this.broadcastState();
    if (this.match.resolvedCount !== prevResolved) {
      for (const [key, ws] of this.sockets) send(ws, { t: 'resolved', events: this.match.eventsFor((parseSeat(key) as Seat).side) });
      for (const w of this.watchers) send(w, { t: 'resolved', events: this.match.spectatorEvents() });
    }
    if (this.match.resolvedCount !== prevResolved || this.match.phase !== prevPhase) this.armTimer();
    this.broadcastState();
    // 每結算一次也存一次（伺服器的房間可能被回收：打到一半的紀錄才不會不見，也能接著打）；結束時再存最終的
    if (this.match.resolvedCount !== prevResolved && this.match.phase !== 'over') this.saveRecord(true);
    else this.saveRecord();
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
      this.runAi();
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
