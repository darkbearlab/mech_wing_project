// 勝利條件與費用：開戰前選的條件（可複選，先達成者勝），以及機體＋駕駛＋裝備的費用。
// 一方全滅一定算輸；回合上限到了比擊墜分（有據點時先比據點分）。
import { gearProblems } from './loadout';
import * as C from './config';
import { CHASSIS, EQUIPMENT, PILOTS, type RosterEntry } from './data';
import { dist } from './geometry';
import type { Environment, GameState, PlayerId, UnitState, Vec } from './types';

export interface BattleSettings {
  /** 擊墜分：擊墜敵機的費用加總到這個門檻就獲勝；沒設定就不用這個條件 */
  killScore?: number;
  /** 斬首：擊墜對方費用最高的機體（旗艦）就獲勝 */
  decapitation?: boolean;
  /** 達陣：進入對方部署區的達陣圈、停住（動能 0）並撐過下一回合 */
  goal?: boolean;
  /** 據點：每回合結束時單獨佔住的據點各得 1 分，先到這個分數獲勝；沒設定就不用 */
  control?: number;
  /** 補給點：雙方後方各一個，停在自己的補給點上用掉動作就補滿彈藥與推進劑 */
  supply?: boolean;
  /** 回合上限 */
  turnLimit: number;
  /** 部署：fixed 照順序排開；free 開戰前各自在部署區暗中擺好、一起公布 */
  deploy: 'fixed' | 'free';
  /** 戰場環境（沒寫＝宇宙） */
  environment?: Environment;
  /** 地形：asteroid 隕石帶（預設）、forest 森林、town 城鎮 */
  terrain?: 'asteroid' | 'forest' | 'town' | 'city';
  /** 增援：第 turn 回合開始時在 (x, y) 進場 */
  reinforcements?: { owner: PlayerId; entry: RosterEntry; turn: number; x: number; y: number; facing: number }[];
  /** 劇本的開場位置（照陣容順序；沒列的照平常排開） */
  placements?: { owner: PlayerId; index: number; x: number; y: number; facing: number; momentum?: number }[];
  /** 劇本事先布置好的煙霧與欺敵氣球（氣球模仿第 index 台機體的外觀） */
  prepared?: { smokes?: { x: number; y: number }[]; decoys?: { owner: PlayerId; index: number; x: number; y: number }[] };
}

export const DEFAULT_SETTINGS: BattleSettings = { killScore: 50, decapitation: true, turnLimit: C.TURN_LIMIT, deploy: 'fixed' };

/** 勝負的原因 */
export type WinReason = 'annihilation' | 'decapitation' | 'killScore' | 'goal' | 'control' | 'turnLimit';

/** 達陣、據點的進度（雙方都看得到） */
export interface ObjectiveState {
  /** 各方正在對方達陣圈裡停住的機體與開始的回合 */
  goalHold: [{ unit: string; turn: number } | null, { unit: string; turn: number } | null];
  /** 據點分 */
  control: [number, number];
}

export const newObjectives = (): ObjectiveState => ({ goalHold: [null, null], control: [0, 0] });

// ---- 費用 ----

/** 一台出擊機體的費用：機型＋駕駛＋帶的裝備（機型的標準裝備不另外算） */
export function entryCost(e: RosterEntry): number {
  return (CHASSIS[e.chassis]?.cost ?? 0) + (PILOTS[e.pilot]?.cost ?? 0) + e.equipment.reduce((n, [d]) => n + (EQUIPMENT[d]?.cost ?? 0), 0);
}

export const rosterCost = (r: RosterEntry[]): number => r.reduce((n, e) => n + entryCost(e), 0);

/** 隊伍規模：預算與機體數上限 */
export const SCALES = {
  small: { name: '小規模', budget: 50, maxUnits: 4, killScore: 20 },
  standard: { name: '標準', budget: 85, maxUnits: 6, killScore: 35 },
  expanded: { name: '擴大', budget: 100, maxUnits: 7, killScore: 42 },
  large: { name: '大規模', budget: 130, maxUnits: 8, killScore: 55 },
} as const;
export type Scale = keyof typeof SCALES;

/** 斬首的旗艦至少要這麼貴，避免全隊都是便宜貨 */
export const FLAGSHIP_MIN_COST = 15;

/** 一方分成 squads 個小隊時，每隊分到的預算與台數：平均分、無條件捨去（至少 1 台） */
export function squadShare(scale: Scale, squads: number): { budget: number; maxUnits: number } {
  const s = SCALES[scale];
  const n = Math.max(1, squads);
  return { budget: Math.floor(s.budget / n), maxUnits: Math.max(1, Math.floor(s.maxUnits / n)) };
}

/**
 * 陣容的問題（超出預算、台數、重複的具名駕駛、旗艦太便宜）；空陣列代表可以出擊。
 * share：一個小隊的陣容，預算與台數照分到的份檢查（旗艦整方合起來才看，所以小隊不查）
 */
export function lineupProblems(r: RosterEntry[], scale: Scale, settings: Pick<BattleSettings, 'decapitation'>, share?: { budget: number; maxUnits: number }): string[] {
  const s = SCALES[scale];
  const limit = share ?? s;
  const out: string[] = [];
  const cost = rosterCost(r);
  if (cost > limit.budget) out.push(`費用 ${cost} 超出${share ? '這一隊分到的' : ''}預算 ${limit.budget}`);
  if (r.length > limit.maxUnits) out.push(share ? `這一隊最多 ${limit.maxUnits} 台` : `${s.name}最多 ${s.maxUnits} 台`);
  // 配裝：每件裝備都要放得進這個機型的掛點、不超過載重與重掛點（可以照配裝選項，也可以自己組）
  for (const [i, e] of r.entries()) {
    if (!CHASSIS[e.chassis]) out.push(`第 ${i + 1} 台：沒有機型 ${e.chassis}`);
    else if (!PILOTS[e.pilot]) out.push(`第 ${i + 1} 台：沒有駕駛 ${e.pilot}`);
    else {
      const bad = e.equipment.filter(([d]) => !EQUIPMENT[d]).map(([d]) => d);
      if (bad.length) out.push(`第 ${i + 1} 台：沒有裝備 ${bad.join('、')}`);
      else for (const p of gearProblems(e.chassis, e.equipment)) out.push(`第 ${i + 1} 台（${e.chassis}）：${p}`);
    }
  }
  const seen = new Set<string>();
  for (const e of r) {
    if (PILOTS[e.pilot]?.unique && seen.has(e.pilot)) out.push(`${PILOTS[e.pilot].name} 只能出擊一次`);
    seen.add(e.pilot);
  }
  if (!share && settings.decapitation && r.length && Math.max(...r.map(entryCost)) < FLAGSHIP_MIN_COST) out.push(`斬首：旗艦（最貴的機體）至少要 ${FLAGSHIP_MIN_COST} 分`);
  return out;
}

// ---- 旗艦與擊墜分 ----

/** 一方的旗艦：費用最高的機體（同分取編號小的），開場就決定 */
export function flagshipOf(state: GameState, p: PlayerId): UnitState | undefined {
  let best: UnitState | undefined;
  for (const u of [...state.units, ...(state.reserves ?? []).map((r) => r.unit)]) if (u.owner === p && (!best || (u.cost ?? 0) > (best.cost ?? 0))) best = u;
  return best;
}

/** p 方的擊墜分：對方已經退場（擊毀、昏迷、飛出地圖）的機體費用總和 */
export const killScoreOf = (state: GameState, p: PlayerId): number =>
  state.units.filter((u) => u.owner !== p && u.status !== 'active').reduce((n, u) => n + (u.cost ?? 0), 0);

// ---- 地圖目標 ----

export const GOAL_RADIUS = 1.5;
export const CONTROL_RADIUS = 1.5;

/** p 方部署區裡的達陣圈（對方要攻佔的地方） */
export const goalZone = (p: PlayerId): Vec => ({ x: C.MAP_SIZE / 2, y: p === 0 ? 2.5 : C.MAP_SIZE - 2.5 });
/** p 方的補給點：自己部署區靠一側（雙方以地圖中心點對稱，和達陣圈錯開） */
export const supplyPoint = (p: PlayerId): Vec => (p === 0 ? { x: C.MAP_SIZE * 0.25, y: 3 } : { x: C.MAP_SIZE * 0.75, y: C.MAP_SIZE - 3 });

/** 據點：中線上三個 */
export const controlPoints = (): Vec[] => [0.25, 0.5, 0.75].map((f) => ({ x: C.MAP_SIZE * f, y: C.MAP_SIZE / 2 }));

/** 部署區：自己那一側邊緣的帶狀區域 */
export const DEPLOY_DEPTH = 4.5;
export function deployZone(p: PlayerId): { x0: number; x1: number; y0: number; y1: number } {
  return { x0: 1, x1: C.MAP_SIZE - 1, y0: p === 0 ? 1 : C.MAP_SIZE - DEPLOY_DEPTH, y1: p === 0 ? DEPLOY_DEPTH : C.MAP_SIZE - 1 };
}

const inside = (u: UnitState, c: Vec, r: number) => u.status === 'active' && dist(u.pos, c) <= r;

/**
 * 回合結束時結算達陣與據點，回傳這回合達成的一方（雙方同時達成回傳兩方）。
 * 達陣：在對方達陣圈裡動能 0、圈裡沒有敵機；上回合結束時已經這樣、這回合結束時還是同一台就達成。
 */
export function scoreObjectives(state: GameState, settings: BattleSettings, note: (text: string, side: PlayerId) => void): { goal: PlayerId[]; control: PlayerId[] } {
  const obj = (state.objectives ??= newObjectives());
  const goal: PlayerId[] = [];
  const control: PlayerId[] = [];
  if (settings.goal) {
    for (const p of [0, 1] as PlayerId[]) {
      const zone = goalZone((1 - p) as PlayerId);
      const contested = state.units.some((u) => u.owner !== p && inside(u, zone, GOAL_RADIUS));
      const holders = state.units.filter((u) => u.owner === p && inside(u, zone, GOAL_RADIUS) && u.momentum === 0);
      const prev = obj.goalHold[p];
      if (contested || !holders.length) {
        if (prev) note(`${'AB'[p]} 方的達陣被打斷`, p);
        obj.goalHold[p] = null;
      } else if (prev && prev.turn < state.turn && holders.some((u) => u.id === prev.unit)) {
        goal.push(p);
      } else if (!prev || !holders.some((u) => u.id === prev.unit)) {
        obj.goalHold[p] = { unit: holders[0].id, turn: state.turn };
        note(`${holders[0].label} 停在 ${'AB'[1 - p]} 方的達陣圈：撐過下一回合就達陣`, p);
      }
    }
  }
  if (settings.control) {
    for (const c of controlPoints()) {
      const sides = new Set(state.units.filter((u) => inside(u, c, CONTROL_RADIUS)).map((u) => u.owner));
      if (sides.size === 1) obj.control[[...sides][0]]++;
    }
    for (const p of [0, 1] as PlayerId[]) if (obj.control[p] >= settings.control) control.push(p);
  }
  return { goal, control };
}

/** 依分數比高下：先比 first（例如據點分），再比擊墜分 */
export function byScore(state: GameState, first?: [number, number]): PlayerId | 'draw' {
  const k: [number, number] = [killScoreOf(state, 0), killScoreOf(state, 1)];
  for (const s of [first, k]) {
    if (!s || s[0] === s[1]) continue;
    return s[0] > s[1] ? 0 : 1;
  }
  return 'draw';
}

/** 一組同時達成的一方 → 勝方（雙方同時達成就比分數） */
export const settleBoth = (state: GameState, sides: PlayerId[], first?: [number, number]): PlayerId | 'draw' => (sides.length === 1 ? sides[0] : byScore(state, first));
