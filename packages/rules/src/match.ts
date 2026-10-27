import { inGrapple, resolveAceMovement, resolveActions, resolveMovement, resolvePursuit } from './resolve';
import { createGame } from './setup';
import { pursuitOptions, validatePursuits, type PursuitOption } from './pursuit';
import type { GameEvent, GameState, PlayerActions, PlayerId, PlayerMoves, PlayerPursuits, TurnPhase } from './types';
import { validateAction, validateMove } from './unit';
import { filterEvents, viewState, type StateView } from './visibility';

export type MatchPhase = TurnPhase | 'over';

export interface PlayerView {
  you: PlayerId;
  phase: MatchPhase;
  state: StateView;
  submitted: [boolean, boolean];
  /** 王牌移動步驟：自己這邊要下指令的機體 */
  aceUnits?: string[];
  /** 追擊步驟：自己這邊各機體能做的追擊 */
  pursuit?: Record<string, PursuitOption[]>;
}

type Orders = PlayerMoves | PlayerActions | PlayerPursuits;

/**
 * 一場對戰的權威狀態。與傳輸層無關：本機 Node 伺服器與日後的 Durable Object 都只包這一層。
 * 每回合依序暗選：移動 →（王牌移動）→（追擊）→ 動作；王牌移動與追擊只有用得到的一方要下指令。
 */
export class Match {
  state: GameState;
  private orders: [Orders | null, Orders | null] = [null, null];
  private lastEvents: GameEvent[] = [];
  /** 已結算的步驟數，傳輸層用來判斷是否要送出新的事件紀錄 */
  resolvedCount = 0;

  constructor(seed: number, state?: GameState) {
    this.state = state ?? createGame(seed);
  }

  get phase(): MatchPhase {
    return this.state.winner !== null ? 'over' : this.state.phase;
  }

  /** 王牌移動步驟裡，player 要下指令的機體 */
  aceUnits(player: PlayerId): string[] {
    return (this.state.turnInfo?.deferred ?? []).filter((id) => this.state.units.find((u) => u.id === id && u.owner === player && u.status === 'active'));
  }

  /** 追擊步驟裡，player 各機體能做的追擊 */
  pursuitFor(player: PlayerId): Record<string, PursuitOption[]> {
    const out: Record<string, PursuitOption[]> = {};
    for (const u of this.ownActive(player)) {
      const opts = pursuitOptions(this.state, u);
      if (opts.length) out[u.id] = opts;
    }
    return out;
  }

  /** 這個步驟 player 有沒有要下的指令（沒有就自動當作已送出） */
  private hasWork(player: PlayerId): boolean {
    if (this.phase === 'ace') return this.aceUnits(player).length > 0;
    if (this.phase === 'pursuit') return Object.keys(this.pursuitFor(player)).length > 0;
    return true;
  }

  submitMoves(player: PlayerId, moves: PlayerMoves): string[] {
    if (this.phase === 'ace') return this.submitAce(player, moves);
    if (this.phase !== 'move') return ['現在不是移動階段'];
    const errors: string[] = [];
    for (const u of this.ownActive(player)) {
      const plan = moves[u.id];
      if (!plan) errors.push(`${u.label}：缺少移動指令`);
      else errors.push(...validateMove(u, plan, inGrapple(this.state, u.id)));
    }
    return this.accept(player, moves, errors);
  }

  private submitAce(player: PlayerId, moves: PlayerMoves): string[] {
    const errors: string[] = [];
    for (const id of this.aceUnits(player)) {
      const u = this.state.units.find((x) => x.id === id)!;
      const plan = moves[id];
      if (!plan) errors.push(`${u.label}：缺少王牌移動的指令`);
      else errors.push(...validateMove(u, { ...plan, defer: false }, false));
    }
    return this.accept(player, moves, errors);
  }

  submitPursuits(player: PlayerId, pursuits: PlayerPursuits): string[] {
    if (this.phase !== 'pursuit') return ['現在不是追擊階段'];
    return this.accept(player, pursuits, validatePursuits(this.state, player, pursuits));
  }

  submitActions(player: PlayerId, actions: PlayerActions): string[] {
    if (this.phase !== 'action') return ['現在不是動作階段'];
    const errors = this.ownActive(player).flatMap((u) => (actions[u.id] ? validateAction(u, actions[u.id]) : []));
    return this.accept(player, actions, errors);
  }

  private accept(player: PlayerId, orders: Orders, errors: string[]): string[] {
    if (errors.length) return errors;
    this.orders[player] = orders;
    this.advance();
    return [];
  }

  /** 回合計時到：未送出的一方以預設指令處理 */
  forceLock(): void {
    if (this.phase === 'over') return;
    for (const p of [0, 1] as PlayerId[]) if (!this.orders[p]) this.orders[p] = {};
    this.advance();
  }

  private ownActive(player: PlayerId) {
    return this.state.units.filter((u) => u.owner === player && u.status === 'active');
  }

  private advance(): void {
    // 這一步沒有要下指令的一方自動送出空指令
    for (const p of [0, 1] as PlayerId[]) if (!this.orders[p] && !this.hasWork(p)) this.orders[p] = {};
    const [a, b] = this.orders;
    if (!a || !b) return;
    const phase = this.phase;
    const result =
      phase === 'move'
        ? resolveMovement(this.state, [a as PlayerMoves, b as PlayerMoves])
        : phase === 'ace'
          ? resolveAceMovement(this.state, [a as PlayerMoves, b as PlayerMoves])
          : phase === 'pursuit'
            ? resolvePursuit(this.state, [a as PlayerPursuits, b as PlayerPursuits])
            : resolveActions(this.state, [a as PlayerActions, b as PlayerActions]);
    this.orders = [null, null];
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

  viewFor(player: PlayerId): PlayerView {
    const submitted: [boolean, boolean] = [!!this.orders[0] || (this.phase !== 'over' && !this.hasWork(0)), !!this.orders[1] || (this.phase !== 'over' && !this.hasWork(1))];
    const view: PlayerView = { you: player, phase: this.phase, state: viewState(this.state, player), submitted };
    if (this.phase === 'ace') view.aceUnits = this.aceUnits(player);
    if (this.phase === 'pursuit') view.pursuit = this.pursuitFor(player);
    return view;
  }
}
