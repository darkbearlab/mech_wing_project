export type Vec = { x: number; y: number };
export type PlayerId = 0 | 1;
/** shoot：射擊姿態，撞到別人只是擦撞；melee：近戰姿態，接觸就出手（慢咬住、快一擊脫離），射擊命中下降 */
export type Stance = 'shoot' | 'melee';
export type Hand = 'right' | 'left';
export type RangeBand = 0 | 1 | 2 | 3;
export type GrappleChoice = 'slash' | 'parry' | 'grab' | 'push' | 'disengage';
export type DamageMode = 'focused' | 'scattered';
/** 人形範本的部位 id；其他機型可以自訂部位 id */
export type BodyPartId = string;
/**
 * 部位功能：規則只看功能、不看部位名稱。同一個功能可以分給多個部位，全部被打壞效果才發生。
 * core 核心（壞了整台退場）、rightHand/leftHand 手（壞了不能握持）、propulsion 推進（壞了加速能力降到最低）、
 * legs 腳（壞了不能急轉急停）、sensor 感測（壞了遠距離命中下降、不能鎖定、視野變短）
 */
export type PartRole = 'core' | 'rightHand' | 'leftHand' | 'propulsion' | 'legs' | 'sensor';

export interface ChassisPart {
  /** 顯示名稱；沒填就用人形範本的名稱或 id */
  name?: string;
  /** 沒填時依人形範本的 id 推斷（torso→core…）；null 表示沒有特別功能 */
  role?: PartRole | null;
  weight: number;
  durability: number;
}

// ---- 靜態資料 ----

/**
 * 武器標籤：quickDraw 拔出不佔行動；secondary 副武裝（觸發規則之後再定，目前可當一般武器）；volatile 被打壞可能引爆；
 * overflow 溢出傷害（打壞部位後多出來的傷害，每 1 點再擲一次命中部位、造成 1 點傷害，例如火箭砲）；
 * dazzle 眩光（命中的目標本回合射擊命中下降；用它的行動最先結算，例如德姆的擴散光束砲）
 */
export type EquipTag = 'quickDraw' | 'secondary' | 'volatile' | 'overflow' | 'dazzle';

/**
 * 安裝方式：
 * hand 手持（要拿在手上才能用，本身是命中表裡的部位）；
 * mounted 外掛（掛在肩、背、腿，不用拿；是命中表裡的部位，宿主破壞就掉落）；
 * integrated 內建（四肢、頭、軀幹的一部分，不用拿；不在命中表，與宿主共存亡）；
 * housed 內藏（藏在宿主裡，拔出來拿在手上才能用；不在命中表，與宿主共存亡，第一次拔出前對手看不到）
 */
export type EquipMount = 'hand' | 'mounted' | 'integrated' | 'housed';

export interface EquipDef {
  id: string;
  name: string;
  kind: 'ranged' | 'melee' | 'shield' | 'tank';
  mount?: EquipMount;
  /** 固定射界的半角（度），射界外打不到；沒有就照手持規則（正面外 −20） */
  arc?: number;
  /** false：不能在接觸距離開火 */
  pointBlank?: boolean;
  /** 佔手的手臂內建武器：那隻手完全不能握持 */
  blocksHand?: boolean;
  tags?: EquipTag[];
  /** 彈數；沒有就是無限 */
  ammo?: number;
  weight: number; // 命中部位權重
  durability: number;
  damage?: number;
  shots?: number;
  mode?: DamageMode;
  /** 各距離帶的命中修正；沒有列出的距離帶不能射擊。Range 0 一律可用（零距離射擊）。 */
  ranges?: Partial<Record<1 | 2 | 3, number>>;
  /** 盾牌的防護範圍：中心相對機體正面的角度（度，負＝左、正＝右）；手持盾沒填就照持盾那隻手的側面 */
  shieldOffset?: number;
  /** 盾牌防護範圍的半角（度）；沒填是 config.SHIELD_ARC_HALF_DEG */
  shieldArc?: number;
  /** 近戰對決的額外骰數（重武器較多） */
  meleeDice?: number;
  fuel?: number;
}

export type ManeuverKind = 'straight' | 'bank' | 'turn' | 'arc' | 'kturn' | 'hover' | 'reverse' | 'rbank';

export interface ChassisDef {
  id: string;
  name: string;
  weightClass: number;
  propellant: number;
  /** 每回合免費的速度變化量 */
  baseThrust: number;
  /** 一回合最多能改變的速度 */
  maxAccel: number;
  power: number;
  aim: number;
  evasion: number;
  parts: Record<BodyPartId, ChassisPart>;
  dial: string[]; // 機動 id
  /** 機型自帶的內建武裝 */
  builtIn?: { defId: string; host: BodyPartId }[];
  /** 底座半徑；沒填是 config.BASE_RADIUS（MS 大小） */
  radius?: number;
  /** 最低速度：動能不能低於這個值（戰機用）；沒填是 0 */
  minSpeed?: number;
  /** 能近身戰鬥：false 時只能選射擊姿態，被纏鬥時只能選脫離；沒填是 true */
  closeCombat?: boolean;
}

export interface PilotDef {
  id: string;
  name: string;
  skill: number;
  maxStress: number;
  recovery: number;
  abilities: 'quick_draw'[];
}

// ---- 動態狀態 ----

export interface PartState {
  id: string;
  name: string;
  kind: 'body' | 'equip';
  /** 機體部位的功能（裝備沒有） */
  role?: PartRole | null;
  weight: number;
  durability: number;
  damage: number;
  destroyed: boolean;
}

export interface EquipState {
  /** 手持與外掛裝備的 id 同時是命中表裡的部位 id；內建與內藏沒有自己的部位 */
  id: string;
  defId: string;
  /** stowed：收在機體上；mount：外掛；builtin：內建；housed：藏在宿主裡 */
  location: Hand | 'stowed' | 'mount' | 'builtin' | 'housed';
  /** 宿主部位（外掛、內建、內藏才有） */
  host?: string;
  /** 從手上收起時要放回哪裡（內藏武器放回 housed） */
  home?: 'stowed' | 'housed';
  /** 剩餘彈數（有彈數限制的武器才有） */
  ammo?: number;
  /** 內藏武器已經被對手看過 */
  revealed?: boolean;
}

export type UnitStatus = 'active' | 'destroyed' | 'unconscious' | 'withdrawn';

export interface UnitState {
  id: string;
  owner: PlayerId;
  label: string;
  chassisId: string;
  pilotId: string;
  pos: Vec;
  facing: number; // 弧度；0 = +x，正值為順時針（畫面 y 向下）
  /** 動能：沿朝向的速度，後退為負；會延續到下一回合 */
  momentum: number;
  propellant: number;
  maxPropellant: number;
  stress: number;
  maxStress: number;
  parts: Record<string, PartState>;
  equipment: EquipState[];
  lockOn: string | null;
  status: UnitStatus;
  blackout: boolean;
}

/** rock：大隕石；field：隕石群（碎石區） */
export interface Obstacle {
  id: string;
  kind: 'rock' | 'field';
  x: number;
  y: number;
  r: number;
}

/** 最後一次看到某台敵機時的外觀 */
export interface SeenRecord {
  turn: number;
  pos: Vec;
  facing: number;
  momentum: number;
  parts: Record<string, PartState>;
  equipment: EquipState[];
  status: UnitStatus;
}

export interface GrappleState {
  a: string;
  b: string;
  advantage: string | null;
}

export type TurnPhase = 'move' | 'action';

/** 移動結算後、動作結算前要保留的本回合資訊 */
export interface TurnInfoState {
  stance: Record<string, Stance>;
  /** 本回合的移動向量（終點 − 起點，每回合單位）；中途停下、急停反轉或纏鬥中為 0。射擊用來算相對速度 */
  velocity: Record<string, Vec>;
  /** 擦撞的機體本回合不能執行動作 */
  bumped: string[];
}

export interface GameState {
  turn: number;
  obstacles: Obstacle[];
  /** 各玩家目前看得到的敵機 */
  visible: [string[], string[]];
  /** 各玩家對每台敵機的最後目擊紀錄（看不到時顯示殘影） */
  lastSeen: [Record<string, SeenRecord>, Record<string, SeenRecord>];
  /** 每回合分兩步：先移動，看到結果後再選動作 */
  phase: TurnPhase;
  turnInfo: TurnInfoState | null;
  units: UnitState[];
  grapples: GrappleState[];
  rngState: number;
  /** 開場時使用的資料包版本（重播、對戰都以這版為準） */
  contentVersion: string;
  winner: PlayerId | 'draw' | null;
}

// ---- 指令 ----

export type Action =
  | { type: 'none' }
  | { type: 'shoot'; weapon: string; target: string }
  | { type: 'lock'; target: string };

/** 第一步：移動（纏鬥中的機體改選纏鬥選項） */
export interface MovePlan {
  maneuver: string;
  stance: Stance;
  facingOffset: number;
  limiter: boolean;
  grapple?: GrappleChoice;
}

/** 第二步：移動結算後選的動作 */
export interface ActionPlan {
  swap?: { hand: Hand; equip: string | null };
  action: Action;
}

export type PlayerMoves = Record<string, MovePlan>;
export type PlayerActions = Record<string, ActionPlan>;

// ---- 事件 ----

export type ContactResult = 'none' | 'bump' | 'clinch' | 'hitrun' | 'ram';

export type GameEvent =
  | { type: 'turnStart'; turn: number }
  /** 對手看不到的那幾個時間點，取樣為 null */
  | { type: 'move'; unit: string; samples: ([number, number, number] | null)[] }
  | { type: 'obstacle'; t: number; unit: string; obstacle: string; damage: number }
  | { type: 'debris'; unit: string; obstacle: string; damage: number }
  | { type: 'contact'; t: number; a: string; b: string; vc: number; result: ContactResult }
  | {
      type: 'clash';
      t: number;
      attacker: string;
      defender: string;
      angle: 'front' | 'side' | 'back';
      /** blade：雙方對砍；shield：用盾格擋；dodge：只能閃避；none：被從背後砍中 */
      defense: 'blade' | 'shield' | 'dodge' | 'none';
      attDice: number[];
      defDice: number[];
      attHits: number;
      defHits: number;
      winner: string | null;
      damage: number;
      /** 防守方承受衝擊並把攻擊方拖進纏鬥 */
      caught: boolean;
    }
  | { type: 'shot'; attacker: string; target: string; weapon: string; band: RangeBand; shots: number; hits: number; blocked: number; chance?: number }
  | { type: 'damage'; unit: string; part: string; amount: number; destroyed: boolean }
  | { type: 'knockback'; unit: string; to: Vec; facing: number }
  | { type: 'stress'; unit: string; amount: number; total: number; reason: string }
  | { type: 'propellant'; unit: string; amount: number; total: number }
  | { type: 'pilot'; unit: string; state: 'blackout' | 'injured' | 'unconscious' | 'sluggish' }
  | { type: 'status'; unit: string; status: 'destroyed' | 'withdrawn' | 'disabled' }
  | { type: 'grapple'; a: string; b: string; choiceA: GrappleChoice; choiceB: GrappleChoice; summary: string; advantage: string | null; ended: boolean }
  | { type: 'reposition'; unit: string; to: Vec }
  | { type: 'swap'; unit: string; hand: Hand; equip: string | null }
  | { type: 'lock'; unit: string; target: string }
  | { type: 'dazzle'; unit: string; by: string }
  | { type: 'actionFail'; unit: string; reason: string }
  | { type: 'fuelFire'; unit: string }
  | { type: 'gameOver'; winner: PlayerId | 'draw' };
