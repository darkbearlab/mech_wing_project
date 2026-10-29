// 對戰紀錄：開場的種子與陣容加上雙方每一步送出的指令。
// 規則引擎在同樣的起點與指令下結果固定，所以照紀錄重播就能還原整場的經過。
import type { ContentPack } from './content';
import type { RosterEntry } from './data';
import { Match } from './match';
import { createGame } from './setup';
import { RULES_VERSION } from './config';
import type { PlayerActions, PlayerDeploy, PlayerId, PlayerMoves, PlayerPursuits, TurnPhase } from './types';
import type { BattleSettings } from './objectives';

export interface BattleStep {
  seat: PlayerId;
  /** 小隊席位送出的（沒寫是整方） */
  squad?: number;
  phase: TurnPhase;
  orders: PlayerMoves | PlayerActions | PlayerPursuits | PlayerDeploy;
}

/** 玩家（多半是代理）留下的一段話：這一步的觀察與決策理由，或對戰結束後的感想；對戰中只存在伺服器，對手看不到 */
export interface BattleNote {
  seat: PlayerId;
  squad?: number;
  turn: number;
  /** 送出哪一步的指令時寫的；over 是對戰結束後 */
  phase: TurnPhase | 'over';
  text: string;
}

/** 一段話最多幾個字 */
export const MAX_NOTE_CHARS = 1200;

export interface BattleRecord {
  format: 1;
  seed: number;
  /** 開場用的資料版本 */
  contentVersion: string;
  /** 規則版本（舊紀錄沒有：重播時從聯賽開打以來的版本裡找對得上的） */
  rules?: number;
  /** 機庫草稿試玩時沒有固定版本，整份資料包一起附上 */
  pack?: ContentPack;
  /** 出擊準備選的陣容；沒有就是照資料包的隨機規則 */
  rosters?: [RosterEntry[], RosterEntry[]];
  /** 勝利條件與部署方式（舊紀錄沒有：當時是先少一台就輸，重播結果可能對不上） */
  settings?: BattleSettings;
  /** 各席位由誰操作 */
  seats: ['human' | 'ai', 'human' | 'ai'];
  /** 客戶端版本（git commit），重播結果對不上時用來判斷是不是規則改過 */
  build?: string;
  /** 在哪個對戰房間打的（伺服器房間的紀錄才有） */
  room?: string;
  /** 玩家留下的話 */
  notes?: BattleNote[];
  /** 伺服器房間裡交給電腦的席位（房間重啟後接著打要用） */
  aiSeats?: string[];
  startedAt: string;
  steps: BattleStep[];
  /** 結束時的狀態；中途重開的對戰 winner 是 null */
  winner: PlayerId | 'draw' | null;
  turns: number;
}

export const MAX_RECORD_BYTES = 512 * 1024;
const PHASES: string[] = ['deploy', 'move', 'ace', 'pursuit', 'action'];

/** 粗略檢查上傳的紀錄格式，回傳問題說明（沒問題回傳 null） */
export function checkRecord(r: unknown): string | null {
  const x = r as Partial<BattleRecord> | null;
  if (!x || typeof x !== 'object') return '不是物件';
  if (x.format !== 1) return 'format 要是 1';
  if (typeof x.seed !== 'number' || !Number.isFinite(x.seed)) return '缺少 seed';
  if (typeof x.contentVersion !== 'string' || x.contentVersion.length > 40) return '缺少 contentVersion';
  if (!Array.isArray(x.steps) || x.steps.some((s) => !s || (s.seat !== 0 && s.seat !== 1) || !PHASES.includes(s.phase) || typeof s.orders !== 'object')) return 'steps 格式不對';
  if (!Array.isArray(x.seats) || x.seats.length !== 2) return '缺少 seats';
  if (typeof x.turns !== 'number') return '缺少 turns';
  return null;
}

/** 照步驟送出指令 */
export function submitStep(match: Match, s: BattleStep): string[] {
  if (s.phase === 'move' || s.phase === 'ace') return match.submitMoves(s.seat, s.orders as PlayerMoves, s.squad);
  if (s.phase === 'pursuit') return match.submitPursuits(s.seat, s.orders as PlayerPursuits, s.squad);
  if (s.phase === 'deploy') return match.submitDeploy(s.seat, s.orders as PlayerDeploy, s.squad);
  return match.submitActions(s.seat, s.orders as PlayerActions, s.squad);
}

/** 沒寫規則版本的舊紀錄：當時可能用過的版本（新的先試） */
const LEGACY_RULES = [2, 1];

/** 照紀錄的規則版本開場 */
export function recordStart(rec: BattleRecord, rules = rec.rules ?? RULES_VERSION): Match {
  return new Match(rec.seed, createGame(rec.seed, rec.rosters, rec.settings, rules));
}

type OnResolved = (m: Match, phase: TurnPhase, orders: [BattleStep['orders'] | null, BattleStep['orders'] | null]) => void;

/**
 * 照紀錄重播（資料包要先換成紀錄用的版本）。
 * onResolved 在每次結算後呼叫，帶這次結算前各席位送出的指令。
 * 沒寫規則版本的舊紀錄依序試當時的幾個版本，用第一個對得上的（都對不上就用最新的那個的結果）。
 */
export function replayRecord(rec: BattleRecord, onResolved?: OnResolved): { match: Match; errors: string[]; rules: number } {
  if (rec.rules !== undefined) return { ...replayWith(rec, rec.rules, onResolved), rules: rec.rules };
  let first: { match: Match; errors: string[]; rules: number } | null = null;
  for (const rules of LEGACY_RULES) {
    const out = { ...replayWith(rec, rules), rules };
    first ??= out;
    if (!out.errors.length) return onResolved ? { ...replayWith(rec, rules, onResolved), rules } : out;
  }
  return onResolved ? { ...replayWith(rec, first!.rules, onResolved), rules: first!.rules } : first!;
}

function replayWith(rec: BattleRecord, rules: number, onResolved?: OnResolved): { match: Match; errors: string[] } {
  const match = recordStart(rec, rules);
  const errors: string[] = [];
  let pending: [BattleStep['orders'] | null, BattleStep['orders'] | null] = [null, null];
  for (const [i, s] of rec.steps.entries()) {
    if (match.phase !== s.phase) {
      errors.push(`第 ${i} 步：紀錄是 ${s.phase}，重播時是 ${match.phase}`);
      break;
    }
    const before = match.resolvedCount;
    const errs = submitStep(match, s);
    if (errs.length) {
      errors.push(`第 ${i} 步（${'AB'[s.seat]} 方）：${errs.join('；')}`);
      break;
    }
    pending[s.seat] = s.squad === undefined ? s.orders : ({ ...pending[s.seat], ...s.orders } as BattleStep['orders']);
    if (match.resolvedCount !== before) {
      onResolved?.(match, s.phase, pending);
      pending = [null, null];
    }
  }
  if (!errors.length && match.state.winner !== rec.winner) errors.push(`結果對不上：紀錄是 ${rec.winner}，重播是 ${match.state.winner}（規則可能改過）`);
  return { match, errors };
}
