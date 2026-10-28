import type { BattleSettings, GameEvent, PlayerActions, PlayerDeploy, PlayerMoves, PlayerPursuits, PlayerView, RosterEntry, Scale } from './index';

/** 房主（A 方）選的對戰條件：客人照這個選隊；prefs 是出擊準備畫面的原始選項，原樣轉給客人 */
export interface RoomTerms {
  settings: BattleSettings;
  scale: Scale;
  prefs?: unknown;
  /** 每方幾個小隊（各一個席位，0、0-1、0-2…）；沒寫是一方一個 */
  squads?: [number, number];
  /** 由電腦指揮的小隊：席位名稱 → 房主替它選的隊伍 */
  ai?: Record<string, RosterEntry[]>;
}

/** 席位的狀況：key 是席位名稱（0、1、0-1…） */
export interface SeatInfo {
  key: string;
  side: 0 | 1;
  squad: number;
  connected: boolean;
  joined: boolean;
  ai: boolean;
}

/** moves 也用在王牌移動步驟（只需要擱置的機體） */
export type ClientMessage =
  /** note：這一步的觀察與決策理由（存進對戰紀錄，對手看不到） */
  | { t: 'moves'; moves: PlayerMoves; note?: string }
  | { t: 'pursuits'; pursuits: PlayerPursuits; note?: string }
  | { t: 'deploy'; deploy: PlayerDeploy; note?: string }
  | { t: 'actions'; actions: PlayerActions; note?: string }
  /** 隨時留一段話（對戰結束後的感想也用這個） */
  | { t: 'note'; text: string }
  | { t: 'reset' }
  /** 連線房間：用指定的陣容與勝利條件重開一場 */
  | { t: 'setup'; rosters: [RosterEntry[], RosterEntry[]]; settings: BattleSettings; ai?: string[] }
  /** 開房模式：各自選好自己的隊伍加入；A 方（房主）同時決定對戰條件，雙方都加入就開打 */
  | { t: 'join'; roster: RosterEntry[]; terms?: RoomTerms };

export type ServerMessage =
  /** game：房間裡第幾場（重開就換），讓文字座位知道是新的一場 */
  | { t: 'state'; view: PlayerView; connected: [boolean, boolean]; deadline: number | null; game?: number; seats?: SeatInfo[] }
  | { t: 'resolved'; events: GameEvent[] }
  | { t: 'error'; errors: string[] }
  /** 開房模式：還沒開打，誰已經加入、房主選的條件 */
  | { t: 'lobby'; joined: [boolean, boolean]; terms: RoomTerms | null; connected: [boolean, boolean]; game: number; seats?: SeatInfo[]; mates?: Record<string, RosterEntry[]> };
