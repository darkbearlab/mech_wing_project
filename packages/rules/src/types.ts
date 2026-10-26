export type Vec = { x: number; y: number };
export type PlayerId = 0 | 1;
/** brace：承受衝擊，站穩等對方撞上來，有機會把一擊脫離拖進纏鬥 */
export type Stance = 'normal' | 'charge' | 'evade' | 'brace';
export type Hand = 'right' | 'left';
export type RangeBand = 0 | 1 | 2 | 3;
export type GrappleChoice = 'slash' | 'parry' | 'grab' | 'push' | 'disengage';
export type DamageMode = 'focused' | 'scattered';
export type BodyPartId = 'torso' | 'rarm' | 'larm' | 'pack' | 'legs' | 'head';

// ---- 靜態資料 ----

export interface EquipDef {
  id: string;
  name: string;
  kind: 'ranged' | 'melee' | 'shield' | 'tank';
  weight: number; // 命中部位權重
  durability: number;
  damage?: number;
  shots?: number;
  mode?: DamageMode;
  /** 各距離帶的命中修正；沒有列出的距離帶不能射擊。Range 0 一律可用（零距離射擊）。 */
  ranges?: Partial<Record<1 | 2 | 3, number>>;
  /** 近戰對決的額外骰數（重武器較多） */
  meleeDice?: number;
  fuel?: number;
}

export type ManeuverKind = 'straight' | 'bank' | 'turn' | 'arc' | 'kturn' | 'hover';

export interface ChassisDef {
  id: string;
  name: string;
  weightClass: number;
  propellant: number;
  power: number;
  aim: number;
  evasion: number;
  parts: Record<BodyPartId, { weight: number; durability: number }>;
  dial: string[]; // 機動 id
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
  weight: number;
  durability: number;
  damage: number;
  destroyed: boolean;
}

export interface EquipState {
  id: string; // 同時是部位 id
  defId: string;
  location: Hand | 'stowed' | 'mount';
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

export interface GrappleState {
  a: string;
  b: string;
  advantage: string | null;
}

export type TurnPhase = 'move' | 'action';

/** 移動結算後、動作結算前要保留的本回合資訊 */
export interface TurnInfoState {
  stance: Record<string, Stance>;
  hovered: string[];
  /** 擦撞的機體本回合不能執行動作 */
  bumped: string[];
}

export interface GameState {
  turn: number;
  /** 每回合分兩步：先移動，看到結果後再選動作 */
  phase: TurnPhase;
  turnInfo: TurnInfoState | null;
  units: UnitState[];
  grapples: GrappleState[];
  rngState: number;
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
  | { type: 'move'; unit: string; samples: [number, number, number][] }
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
  | { type: 'actionFail'; unit: string; reason: string }
  | { type: 'fuelFire'; unit: string }
  | { type: 'gameOver'; winner: PlayerId | 'draw' };
