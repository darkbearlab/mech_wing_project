import type { GameEvent, PlayerActions, PlayerMoves, PlayerView } from './index';

export type ClientMessage = { t: 'moves'; moves: PlayerMoves } | { t: 'actions'; actions: PlayerActions } | { t: 'reset' };

export type ServerMessage =
  | { t: 'state'; view: PlayerView; connected: [boolean, boolean]; deadline: number | null }
  | { t: 'resolved'; events: GameEvent[] }
  | { t: 'error'; errors: string[] };
