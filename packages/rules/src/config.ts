// 所有佔位數值集中在這裡，說明見 docs/placeholders.md。

export const MAP_SIZE = 24;
export const BASE_RADIUS = 0.5;
export const MOVE_STEPS = 40;
export const TURN_LIMIT = 12;

// 地形（以地圖中心點對稱產生）
export const ROCK_PAIRS = 2;
export const FIELD_PAIRS = 1;
export const ROCK_RADIUS = [1, 2] as const;
export const FIELD_RADIUS = [2.5, 3.5] as const;
export const OBSTACLE_GAP = 1.5;
/** 地形離部署區（地圖上下緣）至少這麼遠 */
export const DEPLOY_CLEAR = 5;
/** 撞上大隕石：傷害與壓力 = 速度 − 這個值 */
export const ROCK_SAFE_SPEED = 2;
/** 射擊線穿過隕石群或目標在裡面：命中 − */
export const FIELD_SHOT_PENALTY = 20;
/** 高速穿越隕石群：速度超過這個值，每多 1 點有這麼多 % 機率被碎石打中 1 點 */
export const DEBRIS_SAFE_SPEED = 2;
export const DEBRIS_CHANCE_PER_SPEED = 15;

// 視野（底板邊緣距離）
export const SENSOR_RANGE = 10;
export const SENSOR_RANGE_NO_HEAD = 6;
/** 躲在隕石群裡的機體，要這麼近才看得到 */
export const FIELD_SPOT_RANGE = 4;

/** 陣容：default 固定、random 雙方各自隨機、mirror 雙方同一套隨機陣容 */
export const ROSTER_MODE: 'default' | 'random' | 'mirror' = 'random';
/** 測試用的快速勝負：先失去一台機體（擊毀、昏迷或飛出地圖）的一方輸 */
export const WIN_ON_FIRST_LOSS = true;

// 距離帶（底板邊緣距離的上限）
export const RANGE_LIMITS = { r0: 0.2, r1: 3, r2: 6, r3: 10 } as const;

// 機動
/** 懸停時可原地轉身的角度（不另外消耗推進劑） */
export const FACING_OFFSETS = [0, 45, -45, 90, -90, 180] as const;
/** 限制器解除：最大加減速 +1，壓力 +LIMITER_STRESS */
export const LIMITER_STRESS = 2;
/** 開場時各機的動能 */
export const START_MOMENTUM = 2;
/** 一回合內不加壓力的速度變化量（超過的部分每 1 點壓力 +1） */
export const G_FREE_DV = 2;
/** 推進背包破壞後的最大加減速（也不能耗用推進劑） */
export const PACK_BROKEN_ACCEL = 1;
/** 技能達到此值的駕駛算王牌（高速出刀的負荷門檻較高） */
export const ACE_SKILL = 5;

// 接觸
/** 近戰姿態的接觸：相對接近速度 ≤ 這個值就咬住（纏鬥），以上是一擊脫離（沒拿近戰武器則是撞擊） */
export const CLINCH_MAX_VC = 2;
/** 自己這回合的速度 ≤ 這個值算慢速：近戰姿態慢速時不主動出刀，被高速衝進來就承受衝擊 */
export const SLOW_MAX_SPEED = 2;
/** 機動盤上單一機動的速度上限（資料檢查用；VOB 之類的高速裝備之後再談） */
export const MAX_DIAL_SPEED = 12;
/** 一擊脫離的高速負荷：相對速度達到這個值起，每多 1 點出手方壓力 +1（王牌門檻較高） */
export const HIGH_SPEED_FROM = 5;
export const ACE_HIGH_SPEED_FROM = 6;
/** 承受衝擊（慢速近戰被高速衝進來）：對決時骰數 +1 再加重量差；撞擊傷害與被撞開距離減半 */
export const BRACE_DIE = 1;
// 近戰對決（骰池，D6 擲出 5 以上算成功）
export const MELEE_BASE_DICE = 2;
export const MELEE_CHARGE_DIE = 1;
export const MELEE_SIDE_PENALTY = 1;
export const MELEE_SLUGGISH_PENALTY = 2;
export const MELEE_SUCCESS_ON = 5;
export const MELEE_TIE_STRESS = 1;
export const BACKSTAB_STRESS = 2;
export const FRONT_ARC_DEG = 60;
export const BACK_ARC_DEG = 120;

// 射擊
export const HIT_BASE = 60;
export const HIT_PER_SKILL = 3;
export const EVADE_PER_SKILL = 2;
/** 射擊的相對速度修正：雙方本回合移動向量差的長度 ≤ 第一個數字時，命中 + 第二個數字 */
export const RELATIVE_SPEED_HIT: [number, number][] = [
  [1, 15],
  [2, 5],
  [3, 0],
  [4, -10],
  [Infinity, -20],
];
/** 近戰姿態下射擊的命中懲罰 */
export const MELEE_STANCE_SHOT_PENALTY = 20;
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
