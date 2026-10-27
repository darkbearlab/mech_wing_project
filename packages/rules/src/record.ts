// 對戰紀錄：開場的種子與陣容加上雙方每一步送出的指令。
// 規則引擎在同樣的起點與指令下結果固定，所以照紀錄重播就能還原整場的經過。
import type { ContentPack } from './content';
import type { RosterEntry } from './data';
import { Match } from './match';
import { createGame } from './setup';
import type { PlayerActions, PlayerDeploy, PlayerId, PlayerMoves, PlayerPursuits, TurnPhase } from './types';
import type { BattleSettings } from './objectives';

export interface BattleStep {
  seat: PlayerId;
  phase: TurnPhase;
  orders: PlayerMoves | PlayerActions | PlayerPursuits | PlayerDeploy;
}

export interface BattleRecord {
  format: 1;
  seed: number;
  /** 開場用的資料版本 */
  contentVersion: string;
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
  if (s.phase === 'move' || s.phase === 'ace') return match.submitMoves(s.seat, s.orders as PlayerMoves);
  if (s.phase === 'pursuit') return match.submitPursuits(s.seat, s.orders as PlayerPursuits);
  if (s.phase === 'deploy') return match.submitDeploy(s.seat, s.orders as PlayerDeploy);
  return match.submitActions(s.seat, s.orders as PlayerActions);
}

/**
 * 照紀錄重播（資料包要先換成紀錄用的版本）。
 * onResolved 在每次結算後呼叫，帶這次結算前各席位送出的指令。
 */
export function replayRecord(rec: BattleRecord, onResolved?: (m: Match, phase: TurnPhase, orders: [BattleStep['orders'] | null, BattleStep['orders'] | null]) => void): { match: Match; errors: string[] } {
  const match = new Match(rec.seed, createGame(rec.seed, rec.rosters, rec.settings));
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
    pending[s.seat] = s.orders;
    if (match.resolvedCount !== before) {
      onResolved?.(match, s.phase, pending);
      pending = [null, null];
    }
  }
  if (!errors.length && match.state.winner !== rec.winner) errors.push(`結果對不上：紀錄是 ${rec.winner}，重播是 ${match.state.winner}（規則可能改過）`);
  return { match, errors };
}
