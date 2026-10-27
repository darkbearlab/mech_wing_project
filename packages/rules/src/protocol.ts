import type { GameEvent, PlayerActions, PlayerMoves, PlayerPursuits, PlayerView } from './index';

/** moves 也用在王牌移動步驟（只需要擱置的機體） */
export type ClientMessage = { t: 'moves'; moves: PlayerMoves } | { t: 'pursuits'; pursuits: PlayerPursuits } | { t: 'actions'; actions: PlayerActions } | { t: 'reset' };

export type ServerMessage =
  | { t: 'state'; view: PlayerView; connected: [boolean, boolean]; deadline: number | null }
  | { t: 'resolved'; events: GameEvent[] }
  | { t: 'error'; errors: string[] };
