import { inGrapple, resolveActions, resolveMovement } from './resolve';
import { createGame } from './setup';
import type { GameEvent, GameState, PlayerActions, PlayerId, PlayerMoves, TurnPhase } from './types';
import { validateAction, validateMove } from './unit';
import { filterEvents, viewState, type StateView } from './visibility';

export type MatchPhase = TurnPhase | 'over';

export interface PlayerView {
  you: PlayerId;
  phase: MatchPhase;
  state: StateView;
  submitted: [boolean, boolean];
}

/**
 * 一場對戰的權威狀態。與傳輸層無關：本機 Node 伺服器與日後的 Durable Object 都只包這一層。
 * 每回合兩次暗選：先移動，雙方都看到移動結果後再選動作。
 */
export class Match {
  state: GameState;
  private moves: [PlayerMoves | null, PlayerMoves | null] = [null, null];
  private actions: [PlayerActions | null, PlayerActions | null] = [null, null];
  private lastEvents: GameEvent[] = [];
  /** 已結算的步驟數，傳輸層用來判斷是否要送出新的事件紀錄 */
  resolvedCount = 0;

  constructor(seed: number, state?: GameState) {
    this.state = state ?? createGame(seed);
  }

  get phase(): MatchPhase {
    return this.state.winner !== null ? 'over' : this.state.phase;
  }

  submitMoves(player: PlayerId, moves: PlayerMoves): string[] {
    if (this.phase !== 'move') return ['現在不是移動階段'];
    const errors: string[] = [];
    for (const u of this.ownActive(player)) {
      const plan = moves[u.id];
      if (!plan) errors.push(`${u.label}：缺少移動指令`);
      else errors.push(...validateMove(u, plan, inGrapple(this.state, u.id)));
    }
    if (errors.length) return errors;
    this.moves[player] = moves;
    this.advance();
    return [];
  }

  submitActions(player: PlayerId, actions: PlayerActions): string[] {
    if (this.phase !== 'action') return ['現在不是動作階段'];
    const errors = this.ownActive(player).flatMap((u) => (actions[u.id] ? validateAction(u, actions[u.id]) : []));
    if (errors.length) return errors;
    this.actions[player] = actions;
    this.advance();
    return [];
  }

  /** 回合計時到：未送出的一方以預設指令處理 */
  forceLock(): void {
    const slot = this.phase === 'move' ? this.moves : this.phase === 'action' ? this.actions : null;
    if (!slot) return;
    for (const p of [0, 1] as PlayerId[]) if (!slot[p]) slot[p] = {};
    this.advance();
  }

  private ownActive(player: PlayerId) {
    return this.state.units.filter((u) => u.owner === player && u.status === 'active');
  }

  private advance(): void {
    let result: { state: GameState; events: GameEvent[] } | null = null;
    if (this.phase === 'move' && this.moves[0] && this.moves[1]) {
      result = resolveMovement(this.state, [this.moves[0], this.moves[1]]);
      this.moves = [null, null];
    } else if (this.phase === 'action' && this.actions[0] && this.actions[1]) {
      result = resolveActions(this.state, [this.actions[0], this.actions[1]]);
      this.actions = [null, null];
    }
    if (!result) return;
    this.state = result.state;
    this.lastEvents = result.events;
    this.resolvedCount++;
  }

  get turnResolvedEvents(): GameEvent[] {
    return this.lastEvents;
  }

  eventsFor(player: PlayerId): GameEvent[] {
    return filterEvents(this.lastEvents, this.state, player);
  }

  viewFor(player: PlayerId): PlayerView {
    const slot = this.phase === 'action' ? this.actions : this.moves;
    return { you: player, phase: this.phase, state: viewState(this.state, player), submitted: [!!slot[0], !!slot[1]] };
  }
}
