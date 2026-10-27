import type { BattleSettings, GameEvent, PlayerActions, PlayerDeploy, PlayerMoves, PlayerPursuits, PlayerView, RosterEntry, Scale } from './index';

/** 房主（A 方）選的對戰條件：客人照這個選隊；prefs 是出擊準備畫面的原始選項，原樣轉給客人 */
export interface RoomTerms {
  settings: BattleSettings;
  scale: Scale;
  prefs?: unknown;
}

/** moves 也用在王牌移動步驟（只需要擱置的機體） */
export type ClientMessage =
  | { t: 'moves'; moves: PlayerMoves }
  | { t: 'pursuits'; pursuits: PlayerPursuits }
  | { t: 'deploy'; deploy: PlayerDeploy }
  | { t: 'actions'; actions: PlayerActions }
  | { t: 'reset' }
  /** 連線房間：用指定的陣容與勝利條件重開一場 */
  | { t: 'setup'; rosters: [RosterEntry[], RosterEntry[]]; settings: BattleSettings }
  /** 開房模式：各自選好自己的隊伍加入；A 方（房主）同時決定對戰條件，雙方都加入就開打 */
  | { t: 'join'; roster: RosterEntry[]; terms?: RoomTerms };

export type ServerMessage =
  /** game：房間裡第幾場（重開就換），讓文字座位知道是新的一場 */
  | { t: 'state'; view: PlayerView; connected: [boolean, boolean]; deadline: number | null; game?: number }
  | { t: 'resolved'; events: GameEvent[] }
  | { t: 'error'; errors: string[] }
  /** 開房模式：還沒開打，誰已經加入、房主選的條件 */
  | { t: 'lobby'; joined: [boolean, boolean]; terms: RoomTerms | null; connected: [boolean, boolean]; game: number };
