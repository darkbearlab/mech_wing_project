import { aceTier, inGrapple, resolveAceMovement, resolveActions, resolveDeploy, resolveMovement, resolvePursuit, validateDeploy } from './resolve';
import { createGame } from './setup';
import { pursuitOptions, validatePursuits, type PursuitOption } from './pursuit';
import type { GameEvent, GameState, PlayerActions, PlayerDeploy, PlayerId, PlayerMoves, PlayerPursuits, TurnPhase, UnitState } from './types';
import { validateAction, validateMove } from './unit';
import { filterEvents, viewState, type StateView } from './visibility';

export type MatchPhase = TurnPhase | 'over';

export interface PlayerView {
  you: PlayerId;
  /** 小隊席位：只指揮這個小隊的機體（同一方的其他機體是隊友，看得到但不能下令） */
  squad?: number;
  /** 自己這一方分成好幾個小隊時，各小隊這一步送出了沒 */
  squads?: Record<number, boolean>;
  phase: MatchPhase;
  state: StateView;
  submitted: [boolean, boolean];
  /** 王牌移動步驟：自己這邊要下指令的機體 */
  aceUnits?: string[];
  /** 追擊步驟：自己這邊各機體能做的追擊 */
  pursuit?: Record<string, PursuitOption[]>;
  /** 觀戰：只看不下指令 */
  spectator?: boolean;
}

export type Orders = PlayerMoves | PlayerActions | PlayerPursuits | PlayerDeploy;

/** 機體歸哪個小隊；沒寫是 0 */
export const squadOf = (u: Pick<UnitState, 'squad'>): number => u.squad ?? 0;

/** 這一方有哪些小隊（含還沒進場的增援）；沒分小隊就是 [0] */
export function squadsOf(state: GameState, side: PlayerId): number[] {
  const set = new Set<number>();
  for (const u of [...state.units, ...(state.reserves ?? []).map((r) => r.unit)]) if (u.owner === side) set.add(squadOf(u));
  return set.size ? [...set].sort((a, b) => a - b) : [0];
}

/** 把整方的指令依小隊拆開（電腦一次替整方想好，再分給各小隊送出） */
export function ordersBySquad<T extends Orders>(state: GameState, side: PlayerId, orders: T): Record<number, T> {
  const out: Record<number, T> = {};
  for (const s of squadsOf(state, side)) out[s] = {} as T;
  for (const [id, o] of Object.entries(orders)) {
    const u = state.units.find((x) => x.id === id && x.owner === side);
    if (u) (out[squadOf(u)] as Record<string, unknown>)[id] = o;
  }
  return out;
}

/**
 * 一場對戰的權威狀態。與傳輸層無關：本機 Node 伺服器與日後的 Durable Object 都只包這一層。
 * 每回合依序暗選：移動 →（王牌移動）→（追擊）→ 動作；王牌移動與追擊只有用得到的一方要下指令。
 *
 * 每一方可以分成幾個小隊，各自送出自己機體的指令（squad 參數）；整方都送齊了才算這一方送出。
 * 不帶 squad 就是替整方下指令（原本的一人一方）。只有一個小隊時，指令原封不動交給結算，結果和整方送出一模一樣。
 */
export class Match {
  state: GameState;
  private orders: [Orders | null, Orders | null] = [null, null];
  /** 小隊各自送出的指令，整方送齊才合併進 orders */
  private partial: [Map<number, Orders>, Map<number, Orders>] = [new Map(), new Map()];
  private lastEvents: GameEvent[] = [];
  /** 已結算的步驟數，傳輸層用來判斷是否要送出新的事件紀錄 */
  resolvedCount = 0;

  constructor(seed: number, state?: GameState) {
    this.state = state ?? createGame(seed);
  }

  get phase(): MatchPhase {
    return this.state.winner !== null ? 'over' : this.state.phase;
  }

  /** 王牌移動步驟裡，player（的這個小隊）要下指令的機體 */
  aceUnits(player: PlayerId, squad?: number): string[] {
    return aceTier(this.state).filter((id) => this.state.units.find((u) => u.id === id && u.owner === player && (squad === undefined || squadOf(u) === squad)));
  }

  /** 追擊步驟裡，player（的這個小隊）各機體能做的追擊 */
  pursuitFor(player: PlayerId, squad?: number): Record<string, PursuitOption[]> {
    const out: Record<string, PursuitOption[]> = {};
    for (const u of this.ownActive(player, squad)) {
      const opts = pursuitOptions(this.state, u);
      if (opts.length) out[u.id] = opts;
    }
    return out;
  }

  /** 這個步驟 player（的這個小隊）有沒有要下的指令（沒有就自動當作已送出） */
  private hasWork(player: PlayerId, squad?: number): boolean {
    if (this.phase === 'ace') return this.aceUnits(player, squad).length > 0;
    if (this.phase === 'pursuit') return Object.keys(this.pursuitFor(player, squad)).length > 0;
    // 小隊的機體全倒了就沒事做；整方則照原本，一律要送
    if (squad !== undefined) return this.ownActive(player, squad).length > 0;
    return true;
  }

  submitMoves(player: PlayerId, moves: PlayerMoves, squad?: number): string[] {
    if (this.phase === 'ace') return this.submitAce(player, moves, squad);
    if (this.phase !== 'move') return ['現在不是移動階段'];
    const errors: string[] = this.foreign(player, moves, squad);
    moves = { ...moves };
    for (const u of this.ownActive(player, squad)) {
      // 纏鬥中的機體本來就不移動：沒給指令就補一個懸停
      if (!moves[u.id] && inGrapple(this.state, u.id)) moves[u.id] = { maneuver: 'hover-S-0', stance: 'shoot', facingOffset: 0, limiter: false };
      const plan = moves[u.id];
      if (!plan) errors.push(`${u.label}：缺少移動指令`);
      else errors.push(...validateMove(u, plan, inGrapple(this.state, u.id), this.state));
    }
    return this.accept(player, moves, errors, squad);
  }

  private submitAce(player: PlayerId, moves: PlayerMoves, squad?: number): string[] {
    const errors: string[] = this.foreign(player, moves, squad);
    for (const id of this.aceUnits(player, squad)) {
      const u = this.state.units.find((x) => x.id === id)!;
      const plan = moves[id];
      if (!plan) errors.push(`${u.label}：缺少王牌移動的指令`);
      else errors.push(...validateMove(u, { ...plan, defer: false }, false, this.state));
    }
    return this.accept(player, moves, errors, squad);
  }

  submitDeploy(player: PlayerId, deploy: PlayerDeploy, squad?: number): string[] {
    if (this.phase !== 'deploy') return ['現在不是部署階段'];
    const errors = this.foreign(player, deploy, squad);
    // 小隊：連同隊友已經送出的位置一起檢查，才抓得到和隊友重疊
    const all = squad === undefined ? deploy : { ...this.merged(player, squad, deploy) };
    return this.accept(player, deploy, [...errors, ...validateDeploy(this.state, player, all as PlayerDeploy)], squad);
  }

  submitPursuits(player: PlayerId, pursuits: PlayerPursuits, squad?: number): string[] {
    if (this.phase !== 'pursuit') return ['現在不是追擊階段'];
    return this.accept(player, pursuits, [...this.foreign(player, pursuits, squad), ...validatePursuits(this.state, player, pursuits)], squad);
  }

  submitActions(player: PlayerId, actions: PlayerActions, squad?: number): string[] {
    if (this.phase !== 'action') return ['現在不是動作階段'];
    const errors = this.ownActive(player, squad).flatMap((u) => (actions[u.id] ? validateAction(u, actions[u.id]) : []));
    return this.accept(player, actions, [...this.foreign(player, actions, squad), ...errors], squad);
  }

  /** 小隊只能指揮自己的機體 */
  private foreign(player: PlayerId, orders: Orders, squad?: number): string[] {
    if (squad === undefined) return [];
    return Object.keys(orders).flatMap((id) => {
      const u = this.state.units.find((x) => x.id === id);
      return u && u.owner === player && squadOf(u) === squad ? [] : [`${u?.label ?? id}：不是你指揮的機體`];
    });
  }

  private accept(player: PlayerId, orders: Orders, errors: string[], squad?: number): string[] {
    if (errors.length) return errors;
    if (squad === undefined) {
      this.orders[player] = orders;
      this.partial[player].clear();
    } else {
      this.partial[player].set(squad, orders);
      this.collect(player, false);
    }
    this.advance();
    return [];
  }

  /** 各小隊（含這次送出的）指令合併成整方的，依機體順序排 */
  private merged(player: PlayerId, squad: number, orders: Orders): Orders {
    const parts = new Map(this.partial[player]).set(squad, orders);
    const out: Record<string, unknown> = {};
    for (const u of this.state.units) {
      if (u.owner !== player) continue;
      const o = (parts.get(squadOf(u)) as Record<string, unknown> | undefined)?.[u.id];
      if (o !== undefined) out[u.id] = o;
    }
    return out as Orders;
  }

  /** 小隊都送齊（或沒事做）就合併成整方的指令；force：沒送的小隊當作空指令（計時到） */
  private collect(player: PlayerId, force: boolean): void {
    const parts = this.partial[player];
    if (!parts.size) return;
    const squads = squadsOf(this.state, player);
    if (!force && squads.some((s) => !parts.has(s) && this.hasWork(player, s))) return;
    const only = squads.length === 1 ? parts.get(squads[0]) : undefined;
    // 只有一個小隊：原封不動交出去，和整方送出完全一樣
    this.orders[player] = only ?? this.merged(player, squads[0], parts.get(squads[0]) ?? {});
  }

  /** 回合計時到：未送出的一方（或小隊）以預設指令處理 */
  forceLock(): void {
    if (this.phase === 'over') return;
    for (const p of [0, 1] as PlayerId[]) {
      if (!this.orders[p]) this.collect(p, true);
      if (!this.orders[p]) this.orders[p] = {};
    }
    this.advance();
  }

  private ownActive(player: PlayerId, squad?: number) {
    return this.state.units.filter((u) => u.owner === player && u.status === 'active' && (squad === undefined || squadOf(u) === squad));
  }

  private advance(): void {
    // 這一步沒有要下指令的一方自動送出空指令
    for (const p of [0, 1] as PlayerId[]) if (!this.orders[p] && !this.hasWork(p)) this.orders[p] = {};
    const [a, b] = this.orders;
    if (!a || !b) return;
    const phase = this.phase;
    const result =
      phase === 'deploy'
        ? resolveDeploy(this.state, [a as PlayerDeploy, b as PlayerDeploy])
        : phase === 'move'
        ? resolveMovement(this.state, [a as PlayerMoves, b as PlayerMoves])
        : phase === 'ace'
          ? resolveAceMovement(this.state, [a as PlayerMoves, b as PlayerMoves])
          : phase === 'pursuit'
            ? resolvePursuit(this.state, [a as PlayerPursuits, b as PlayerPursuits])
            : resolveActions(this.state, [a as PlayerActions, b as PlayerActions]);
    this.orders = [null, null];
    this.partial = [new Map(), new Map()];
    this.state = result.state;
    this.lastEvents = result.events;
    this.resolvedCount++;
    // 下一步若雙方都沒事做（例如沒有人能追擊時不會進來；保險起見）就直接往下
    if (this.phase !== 'over' && !this.hasWork(0) && !this.hasWork(1)) {
      const before = this.lastEvents;
      this.advance();
      this.lastEvents = [...before, ...this.lastEvents];
    }
  }

  get turnResolvedEvents(): GameEvent[] {
    return this.lastEvents;
  }

  eventsFor(player: PlayerId): GameEvent[] {
    return filterEvents(this.lastEvents, this.state, player);
  }

  /** 這一方（的這個小隊）這一步送出了沒（沒事做也算） */
  isSubmitted(player: PlayerId, squad?: number): boolean {
    if (this.phase === 'over') return false;
    if (this.orders[player] || !this.hasWork(player)) return true;
    return squad !== undefined && (this.partial[player].has(squad) || !this.hasWork(player, squad));
  }

  private submittedPair(): [boolean, boolean] {
    return [!!this.orders[0] || (this.phase !== 'over' && !this.hasWork(0)), !!this.orders[1] || (this.phase !== 'over' && !this.hasWork(1))];
  }

  /** 觀戰（從 A 方的位置看，但雙方機體都看得到、事件不過濾；看不到雙方的駕駛細節以外的東西都有） */
  spectatorView(): PlayerView {
    const s = structuredClone(this.state);
    s.visible = [s.units.filter((u) => u.owner === 1).map((u) => u.id), s.units.filter((u) => u.owner === 0).map((u) => u.id)];
    s.obscured = [[], []];
    return { you: 0, phase: this.phase, state: viewState(s, 0), submitted: this.submittedPair(), spectator: true };
  }

  /** 觀戰用的事件：不過濾 */
  spectatorEvents(): GameEvent[] {
    return structuredClone(this.lastEvents);
  }

  /** squad：小隊席位的畫面（王牌、追擊只列自己小隊的機體，submitted 的自己那一格是自己小隊送出了沒） */
  viewFor(player: PlayerId, squad?: number): PlayerView {
    const submitted = this.submittedPair();
    const view: PlayerView = { you: player, phase: this.phase, state: viewState(this.state, player), submitted };
    if (squad !== undefined) {
      view.squad = squad;
      submitted[player] = this.isSubmitted(player, squad);
    }
    const squads = squadsOf(this.state, player);
    if (squads.length > 1) view.squads = Object.fromEntries(squads.map((s) => [s, this.isSubmitted(player, s)]));
    if (this.phase === 'ace') view.aceUnits = this.aceUnits(player, squad);
    if (this.phase === 'pursuit') view.pursuit = this.pursuitFor(player, squad);
    return view;
  }
}
