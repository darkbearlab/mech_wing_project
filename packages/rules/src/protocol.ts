import type { BattleSettings, GameEvent, PlayerActions, PlayerDeploy, PlayerMoves, PlayerPursuits, PlayerView, RosterEntry } from './index';

/** moves 也用在王牌移動步驟（只需要擱置的機體） */
export type ClientMessage =
  | { t: 'moves'; moves: PlayerMoves }
  | { t: 'pursuits'; pursuits: PlayerPursuits }
  | { t: 'deploy'; deploy: PlayerDeploy }
  | { t: 'actions'; actions: PlayerActions }
  | { t: 'reset' }
  /** 連線房間：用指定的陣容與勝利條件重開一場 */
  | { t: 'setup'; rosters: [RosterEntry[], RosterEntry[]]; settings: BattleSettings };

export type ServerMessage =
  /** game：房間裡第幾場（重開就換），讓文字座位知道是新的一場 */
  | { t: 'state'; view: PlayerView; connected: [boolean, boolean]; deadline: number | null; game?: number }
  | { t: 'resolved'; events: GameEvent[] }
  | { t: 'error'; errors: string[] };
