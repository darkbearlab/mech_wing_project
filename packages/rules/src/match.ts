import { resolveTurn, inGrapple } from './resolve';
import { createGame } from './setup';
import type { GameEvent, GameState, PlayerId, PlayerPlans } from './types';
import { validatePlan } from './unit';
import { filterEvents, viewState, type StateView } from './visibility';

export type MatchPhase = 'planning' | 'over';

export interface PlayerView {
  you: PlayerId;
  phase: MatchPhase;
  state: StateView;
  submitted: [boolean, boolean];
}

/**
 * 一場對戰的權威狀態。與傳輸層無關：本機 Node 伺服器與日後的 Durable Object 都只包這一層。
 */
export class Match {
  state: GameState;
  phase: MatchPhase = 'planning';
  private plans: [PlayerPlans | null, PlayerPlans | null] = [null, null];
  private lastEvents: GameEvent[] = [];
  /** 已結算的回合數，傳輸層用來判斷是否要送出新的事件紀錄 */
  resolvedCount = 0;

  constructor(seed: number, state?: GameState) {
    this.state = state ?? createGame(seed);
  }

  submitPlans(player: PlayerId, plans: PlayerPlans): string[] {
    if (this.phase !== 'planning') return ['現在不是規劃階段'];
    const errors: string[] = [];
    const accepted: PlayerPlans = {};
    for (const u of this.state.units) {
      if (u.owner !== player || u.status !== 'active') continue;
      const plan = plans[u.id];
      if (!plan) {
        errors.push(`${u.label}：缺少指令`);
        continue;
      }
      errors.push(...validatePlan(u, plan, inGrapple(this.state, u.id)));
      accepted[u.id] = plan;
    }
    if (errors.length) return errors;
    this.plans[player] = accepted;
    this.advance();
    return [];
  }

  /** 回合計時到：未送出的一方以預設指令處理 */
  forceLock(): void {
    if (this.phase !== 'planning') return;
    for (const p of [0, 1] as PlayerId[]) if (!this.plans[p]) this.plans[p] = {};
    this.advance();
  }

  private advance(): void {
    if (this.phase !== 'planning' || !this.plans[0] || !this.plans[1]) return;
    const result = resolveTurn(this.state, [this.plans[0], this.plans[1]]);
    this.state = result.state;
    this.lastEvents = result.events;
    this.resolvedCount++;
    this.plans = [null, null];
    this.phase = this.state.winner !== null ? 'over' : 'planning';
  }

  get turnResolvedEvents(): GameEvent[] {
    return this.lastEvents;
  }

  eventsFor(player: PlayerId): GameEvent[] {
    return filterEvents(this.lastEvents, this.state, player);
  }

  viewFor(player: PlayerId): PlayerView {
    return { you: player, phase: this.phase, state: viewState(this.state, player), submitted: [!!this.plans[0], !!this.plans[1]] };
  }
}
