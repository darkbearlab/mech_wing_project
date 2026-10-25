// 所有佔位數值集中在這裡，說明見 docs/placeholders.md。

export const MAP_SIZE = 24;
export const BASE_RADIUS = 0.5;
export const EVADE_RADIUS_REDUCTION = 0.15;
export const MOVE_STEPS = 40;
export const TURN_LIMIT = 12;
/** 測試用的快速勝負：先失去一台機體（擊毀、昏迷或飛出地圖）的一方輸 */
export const WIN_ON_FIRST_LOSS = true;

// 距離帶（底板邊緣距離的上限）
export const RANGE_LIMITS = { r0: 0.2, r1: 3, r2: 6, r3: 10 } as const;

// 機動
/** 懸停時可原地轉身的角度（不另外消耗推進劑） */
export const FACING_OFFSETS = [0, 45, -45, 90, -90, 180] as const;
export const HOVER_EVASION_PENALTY = 10;
export const LIMITER_STRESS = 2;
/** 技能達到此值的駕駛，一擊脫離的 Vc 上限 +1 */
export const ACE_SKILL = 5;

// 接觸
export const CLINCH_MAX_VC = 1;
export const HIT_RUN_MAX_VC = 3;
export const RAM_MIN_VC = 4;
export const SOFTEN_STRESS = 1;
export const PARRY_BASE = 30;
export const PARRY_PER_SKILL = 5;
export const BACKSTAB_STRESS = 2;
export const FRONT_ARC_DEG = 60;
export const BACK_ARC_DEG = 120;

// 射擊
export const HIT_BASE = 60;
export const HIT_PER_SKILL = 3;
export const EVADE_PER_SKILL = 2;
export const EVADE_STANCE_BONUS = 15;
export const OFF_FRONT_DEG = 45;
export const OFF_FRONT_PENALTY = 20;
export const LOCK_BONUS = 20;
export const HEAD_LONG_PENALTY = 15;
export const ZERO_RANGE_BONUS = 25;
export const ZERO_RANGE_SELF_DAMAGE = 20;
export const HIT_MIN = 5;
export const HIT_MAX = 95;
export const SHIELD_ARC_HALF_DEG = 60;
export const SHIELD_ARC_OFFSET_DEG = 30;
export const SHIELD_BLOCK_BASE = 50;
export const SHIELD_BLOCK_PER_SKILL = 5;

// 纏鬥
export const ADVANTAGE_PUSH = 2;
export const ADVANTAGE_SLASH = 1;
export const PUSH_AWAY_MARGIN = 3;
export const THROW_DISTANCE = 2;
export const THROW_DAMAGE = 1;
export const THROW_STRESS = 2;
export const DISENGAGE_STRESS = 1;
export const DISENGAGE_GAP = 0.5;

// 壓力
export const BLACKOUT_OVER = 0; // 超過上限 > 0
export const INJURED_OVER = 3;
export const UNCONSCIOUS_OVER = 6;
export const INJURY_MAX_PENALTY = 2;

// 部位
export const FUEL_IGNITE_CHANCE = 30;
export const FUEL_IGNITE_DAMAGE = 2;
