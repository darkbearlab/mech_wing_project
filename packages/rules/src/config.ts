// 所有佔位數值集中在這裡，說明見 docs/placeholders.md。

export const MAP_SIZE = 24;
export const BASE_RADIUS = 0.5;
export const MOVE_STEPS = 40;
export const TURN_LIMIT = 12;

// 地形（以地圖中心點對稱產生）
export const ROCK_PAIRS = 1;
export const FIELD_PAIRS = 1;
export const ROCK_RADIUS = [1, 2] as const;
export const FIELD_RADIUS = [2.5, 3.5] as const;
export const OBSTACLE_GAP = 1.5;
/** 地形離部署區（地圖上下緣）至少這麼遠 */
export const DEPLOY_CLEAR = 5;
/** 撞上大隕石：傷害與壓力 = 速度 − 這個值 */
export const ROCK_SAFE_SPEED = 2;
/** 撞上大隕石後被彈開，和隕石表面留這麼多空隙（才轉得出來） */
export const ROCK_BOUNCE_GAP = 0.3;
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
export const HIT_PER_SKILL = 5;
export const EVADE_PER_SKILL = 3;
/** 近戰骰、纏鬥推擠、盾牌擋下率只算到這個技能（傳奇駕駛的優勢主要在射擊與迴避） */
export const SKILL_CAP_CLOSE = 5;
/** 技能差距：目標比射擊方高出這麼多以內不另外修正 */
export const SKILL_GAP_FREE = 3;
/** 技能差距超過 SKILL_GAP_FREE 的每一級，命中再 −這麼多（只有身手相當的人才打得到傳奇駕駛） */
export const SKILL_GAP_PENALTY = 6;
/** 爆擊傷害倍率 */
export const CRIT_MULTIPLIER = 2;
/** 瞄準要害（called_shot）：命中時抽部位，核心部位的權重加這麼多 */
export const CALLED_SHOT_CORE_BONUS = 10;
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

// ---- 側移與環境 ----
/** 側移只能在動能 ±這個值以內使用 */
export const SLIDE_MAX_MOMENTUM = 1;
/** 最大加減速達到這個值的機體可以側移 2 */
export const SLIDE2_MIN_ACCEL = 3;
/** 重力圈：每回合結束時動能往 0 回正多少（地面滑行的機體不受影響） */
export const GRAVITY_DECAY = 1;
/** 水中（之後的水中戰用）：動能回正多少 */
export const WATER_DECAY = 2;
/** 不適合的環境：機動盤最高速度減掉多少 */
export const UNSUITED_SPEED_CUT = 1;

// ---- 口袋裡的戰爭：煙霧、欺敵氣球、外裝甲 ----
/** 射擊線穿過煙霧或目標在煙霧裡：命中 −這麼多 */
export const SMOKE_SHOT_PENALTY = 30;
/** 煙霧半徑 */
export const SMOKE_RADIUS = 2;
/** 煙霧持續回合：重力圈、宇宙（宇宙裡不會沉降，散得比較慢） */
export const SMOKE_TURNS_GRAVITY = 4;
export const SMOKE_TURNS_SPACE = 5;
/** 隔著煙霧只在這個距離以內認得出是什麼 */
export const SMOKE_ID_RANGE = 1;
/** 丟煙霧彈的最遠距離（底板邊緣距離，中距離帶） */
export const SMOKE_THROW_RANGE = 6;
/** 放欺敵氣球的最遠距離 */
export const DECOY_PLACE_RANGE = 2;
/** 敵機靠到這個距離以內，氣球就被識破 */
export const DECOY_EXPOSE_RANGE = 2;

// ---- 王牌移動、追擊、新人類 ----
/** 新人類擱置移動、而對方也有新人類在場時付的壓力 */
export const ACE_DEFER_STRESS = 1;
/** 追擊：射擊方要在目標背後 ±PURSUIT_ARC_DEG，而且面向目標 ±PURSUIT_ARC_DEG */
export const PURSUIT_ARC_DEG = 45;
/** 追擊只在這個距離帶以內成立（0 零距離、1 近、2 中） */
export const PURSUIT_MAX_BAND = 2;
/** 新人類擊墜一般機體的壓力 */
export const NT_KILL_STRESS = { numb: 0, strong: 1, sensitive: 2, fragile: 1 } as const;
/** 新人類擊墜船艦的壓力（船上人很多） */
export const NT_KILL_SHIP_STRESS = { numb: 2, strong: 3, sensitive: 5, fragile: 3 } as const;
/** 擊墜的是另一個新人類：額外壓力 */
export const NT_KILL_NT_EXTRA = 2;
/** 纖細（fragile）的新人類每擊墜一架有人機，最大壓力永久 −1（最低 1） */
export const NT_FRAGILE_MAX_LOSS = 1;
/** 被眩光照到：本回合射擊命中下降 */
export const DAZZLE_PENALTY = 20;
export const HEAD_LONG_PENALTY = 15;
export const ZERO_RANGE_BONUS = 25;
export const ZERO_RANGE_SELF_DAMAGE = 20;
export const HIT_MIN = 0;
/** 命中率可以超過 100：超過的部分是爆擊率（115 → 骰 1–15 爆擊），到 200 就每發都爆擊 */
export const HIT_MAX = 200;
export const SHIELD_ARC_HALF_DEG = 60;
export const SHIELD_ARC_OFFSET_DEG = 30;
export const SHIELD_BLOCK_BASE = 50;
export const SHIELD_BLOCK_PER_SKILL = 5;

// 纏鬥
/** 纏鬥：被剋的一方對手多幾顆骰（脫離、不擅長的徒手肉搏一律算被剋）——暫定，模擬後調整 */
export const COUNTER_DICE = 2;
/** 纏鬥優勢（從側面或背後抓住、互相纏繞僵持時較重的一方）多幾顆骰 */
export const GRAPPLE_ADV_DICE = 1;
/** 徒手肉搏的三種手法（拳、掌、摔） */
export const BARE_HANDS = { cleave: { dice: -1, damage: 1 }, thrust: { dice: -1, damage: 1 }, entangle: { dice: 1, damage: 1 } } as const;
/** 劈砍、穿刺得手時把對方擊退的距離（纏繞得手是 THROW_DISTANCE） */
export const KNOCKBACK_GAP = 1.5;
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
