import type { GameEvent, PlayerPlans, PlayerView } from './index';

export type ClientMessage = { t: 'plans'; plans: PlayerPlans } | { t: 'reset' };

export type ServerMessage =
  | { t: 'state'; view: PlayerView; connected: [boolean, boolean]; deadline: number | null }
  | { t: 'resolved'; events: GameEvent[] }
  | { t: 'error'; errors: string[] };
