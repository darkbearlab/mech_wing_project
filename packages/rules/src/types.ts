import type { BattleSettings, ObjectiveState, WinReason } from './objectives';
export type Vec = { x: number; y: number };
export type PlayerId = 0 | 1;
/** shoot：射擊姿態，撞到別人只是擦撞；melee：近戰姿態，接觸就出手（慢咬住、快一擊脫離），射擊命中下降 */
export type Stance = 'shoot' | 'melee';
export type Hand = 'right' | 'left';
/** 距離帶：0 零距離、1 近、2 中、3 遠、4 超遠（戰艦主砲） */
export type RangeBand = 0 | 1 | 2 | 3 | 4;
/** 纏鬥的手法：劈砍、穿刺、纏繞（剋制環：纏繞剋劈砍、劈砍剋穿刺、穿刺剋纏繞） */
export type Technique = 'cleave' | 'thrust' | 'entangle';
export type GrappleChoice = Technique | 'disengage';
export type DamageMode = 'focused' | 'scattered';
/** 傷害屬性：kinetic 動能（實彈、實體刀、撞擊）、energy 能量（光束）、chemical 化學能（爆炸物） */
export type DamageType = 'kinetic' | 'energy' | 'chemical';
/** 裝甲：composite 複合（擋動能、怕化學能）、reflective 反射（擋能量、怕動能）、ceramic 陶瓷（擋化學能、怕能量） */
export type ArmorType = 'composite' | 'reflective' | 'ceramic';
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
/** turret：戰艦的砲塔（各自選目標開火，見 ActionPlan.salvo） */
export type EquipTag = 'quickDraw' | 'secondary' | 'volatile' | 'overflow' | 'dazzle' | 'turret';

/**
 * 安裝方式：
 * hand 手持（要拿在手上才能用，本身是命中表裡的部位）；
 * mounted 外掛（掛在肩、背、腿，不用拿；是命中表裡的部位，宿主破壞就掉落）；
 * integrated 內建（四肢、頭、軀幹的一部分，不用拿；不在命中表，與宿主共存亡）；
 * housed 內藏（藏在宿主裡，拔出來拿在手上才能用；不在命中表，與宿主共存亡，第一次拔出前對手看不到）
 */
export type EquipMount = 'hand' | 'mounted' | 'integrated' | 'housed';

export interface EquipDef {
  /** 費用：出擊時帶上就加（機型的標準裝備不算） */
  cost?: number;
  id: string;
  name: string;
  kind: 'ranged' | 'melee' | 'shield' | 'tank' | 'armor' | 'utility' | 'module';
  /** 輔助模組（kind module）：錨鉤這類被動裝備，攀升能多爬幾層、速度上限多多少 */
  climbBoost?: { levels: number; speed: number };
  /** 外裝甲（kind armor）：穿著時迴避減少、最大加減速減少；lockWeapons 為 true 時只有頭部武器能用 */
  evasionPenalty?: number;
  accelPenalty?: number;
  lockWeapons?: boolean;
  /**
   * 戰術道具（kind utility）：smoke 煙霧彈、decoy 欺敵氣球、mark 標定器、ecm 電子干擾器（一直開著）、
   * mine 佈雷器、barricade 路障；會用完的用 ammo 表示數量
   */
  utility?: 'smoke' | 'decoy' | 'mark' | 'ecm' | 'mine' | 'barricade';
  /** 標定器：一次標定前方幾台敵機（隨機挑） */
  markCount?: number;
  /**
   * 導引武器：mortar 迫擊砲（曲射越頂，沒打中會散布、炸到落點附近）、vls 垂直飛彈（越頂）、missile 平射飛彈（要射擊線）。
   * 都只能打被標定的目標，命中只看機器：不算射手駕駛的技能、沒有標定加成（目標駕駛的閃避照算）
   */
  fire?: 'mortar' | 'vls' | 'missile' | 'antiRadiation';
  /** 展開盾：可以在機體正面展開成一道矮牆 */
  deployable?: boolean;
  /** 武器的傷害屬性（沒寫照動能） */
  damageType?: DamageType;
  /** 盾牌、外裝甲的裝甲種類（沒寫的裝備不受屬性影響） */
  armorType?: ArmorType;
  mount?: EquipMount;
  /** 固定射界的半角（度），射界外打不到；沒有就照手持規則（正面外 −20） */
  arc?: number;
  /** 固定射界的中心相對機體正面的角度（度，負＝左、正＝右）；戰艦的舷側、艦尾砲塔用 */
  arcOffset?: number;
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
  ranges?: Partial<Record<1 | 2 | 3 | 4, number>>;
  /** 盾牌的防護範圍：中心相對機體正面的角度（度，負＝左、正＝右）；手持盾沒填就照持盾那隻手的側面 */
  shieldOffset?: number;
  /** 盾牌防護範圍的半角（度）；沒填是 config.SHIELD_ARC_HALF_DEG */
  shieldArc?: number;
  /** 近戰對決的額外骰數（重武器較多） */
  meleeDice?: number;
  /** 纏鬥的三種手法：骰數修正與得手時的傷害；有寫就照寫的（沒寫的手法不能用），沒寫照 meleeDice 與 damage 劈砍、穿刺 */
  melee?: Partial<Record<Technique, { dice: number; damage: number }>>;
  fuel?: number;
  /** 感應武器（炮群）：只有新人類、強化人能用；只能在宇宙用。射擊照這件武器的 damage、shots（每支每次）與 ranges */
  psycommu?: PsycommuDef;
}

export interface PsycommuDef {
  /** 支數（有線臂是 1） */
  count: number;
  /** 每支能攻擊幾次，用完要收回母機充能；沒寫是線控、母機供能，不限 */
  charge?: number;
  /** 控制距離：炮群離母機超過這個距離就不受控制 */
  range: number;
  /** 炮群每回合最多移動多遠 */
  move: number;
  /** 線控（吉翁克的有線臂）：宿主部位（手臂）就是炮群；指揮不佔母機的行動；被打中是打那隻手臂 */
  wired?: boolean;
  /** 被射擊時的迴避（很小的感應炮很難打中） */
  evasion?: number;
}

/** 放出去的炮群（掛在那件感應武器上） */
export interface PodState {
  pos: Vec;
  /** 剩餘攻擊次數（線控沒有） */
  charge?: number;
}

export type ManeuverKind = 'straight' | 'bank' | 'turn' | 'arc' | 'kturn' | 'hover' | 'reverse' | 'rbank' | 'slide';

export interface ChassisDef {
  id: string;
  name: string;
  /** 機體部位的裝甲種類（一個機型只有一種；沒寫的不受屬性影響） */
  armorType?: ArmorType;
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
  /** 機上人員：unmanned 無人（飛彈、無人機），pilot 一般駕駛（預設），ship 船艦（大量人員）；新人類擊墜時的壓力依此計算 */
  crew?: 'unmanned' | 'pilot' | 'ship';
  /** 感測距離（沒寫照 config.SENSOR_RANGE；戰艦的雷達看得比較遠） */
  sensorRange?: number;
  /** 戰艦的防禦彈幕：range 範圍（艦體邊緣起算）、每座還能用的砲塔扣多少命中、最多扣多少 */
  barrage?: { range: number; perTurret: number; max: number };
  /** 適合的環境（沒寫＝宇宙與重力圈都可以）；不適合時機動盤最高速度 −1 */
  envs?: Environment[];
  /** 地面滑行（德姆）：重力圈裡動能不會回正 */
  hover?: boolean;
  /** 費用（不含駕駛與另外帶的裝備；標準裝備已含在內） */
  cost?: number;
}

/**
 * 駕駛能力：quick_draw 快拔；ace_move 王牌移動（移動步驟可以等其他人動完再決定）；
 * called_shot 瞄準要害（命中時比較容易打到核心部位）；brawler 擅長肉搏（纏鬥徒手不吃虧）；
 * newtype 新人類（要搭配 ntSense，擊墜會累積壓力；有王牌移動時，對方也有新人類就要付壓力才能擱置）
 */
/** 戰場環境：宇宙、重力圈（地面）；水中之後再做 */
export type Environment = 'space' | 'gravity' | 'water';

/** cyber_newtype 強化人：和新人類一樣能用感應武器（Z 鋼彈之後才有） */
/** ship_killer 對艦特效：打戰艦時艦橋與引擎的權重大幅提高 */
export type PilotAbility = 'quick_draw' | 'ace_move' | 'newtype' | 'called_shot' | 'brawler' | 'cyber_newtype' | 'ship_killer';
/** 新人類對擊墜的感受：numb 麻木（後期阿姆羅、夏亞）、strong 心智堅強（捷度）、sensitive 敏感（剛上戰場）、fragile 纖細（卡蜜兒） */
export type NtSense = 'numb' | 'strong' | 'sensitive' | 'fragile';

export interface PilotDef {
  id: string;
  name: string;
  skill: number;
  maxStress: number;
  recovery: number;
  abilities: PilotAbility[];
  /** 新人類才需要 */
  ntSense?: NtSense;
  /** 費用（組隊預算與擊墜分） */
  cost?: number;
  /** 具名駕駛：一隊只能出擊一次 */
  unique?: boolean;
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
  /** 感應武器：放出去的炮群（收在母機上時沒有） */
  pod?: PodState;
  /** 感應武器：還剩幾支（被打掉就少；沒有表示滿的） */
  bits?: number;
  /** 感應武器：充能完畢、可以再放出去的回合 */
  readyTurn?: number;
  /** 展開盾：展開中 */
  deployed?: boolean;
}

export type UnitStatus = 'active' | 'destroyed' | 'unconscious' | 'withdrawn';

export interface UnitState {
  /** 不適合目前環境：機動盤最高速度減掉這麼多 */
  speedCut?: number;
  /** 出擊費用（機型＋駕駛＋裝備），擊墜分與旗艦用 */
  cost?: number;
  id: string;
  owner: PlayerId;
  /** 同一方裡歸哪個小隊指揮；沒寫是 0。視野、勝負都還是照整方算 */
  squad?: number;
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
  /** 高度（層）：站在幾層樓高的樓頂；沒寫是地面 0 */
  z?: number;
  /** 被敵方標定：by 是標定的機體。敵方看得到它（不用視線）、射擊命中 +MARK_BONUS；超出標定機的感測距離就解除 */
  mark?: { by: string };
}

/** rock：大隕石；field：隕石群（碎石區）；building：建築（長方形、有高度） */
export interface Obstacle {
  id: string;
  /** rock 大隕石（地面是岩石）；field 隕石群（地面是森林）；smoke 煙霧（會散）；building 建築 */
  kind: 'rock' | 'field' | 'smoke' | 'building';
  x: number;
  y: number;
  /** 半徑；建築是外接圓半徑（擺放地形、粗略判斷用） */
  r: number;
  /** 建築：長、寬的一半（沿地圖 x、y 軸） */
  hx?: number;
  hy?: number;
  /** 建築：幾層樓高（1 層約等於一台機體的高度） */
  levels?: number;
  /** 煙霧：最後一個還在的回合 */
  until?: number;
  /** 建築：最上面那層還剩的耐久（沒寫是滿的） */
  hp?: number;
}

/** 地雷：敵方的地面機體移動經過就引爆（自己這一方不會觸發） */
export interface Mine {
  id: string;
  owner: PlayerId;
  x: number;
  y: number;
}

/** 欺敵氣球：外觀照放的那台機體；在煙霧裡對手分不出真假，出了煙霧就是氣球 */
export interface Decoy {
  id: string;
  owner: PlayerId;
  pos: Vec;
  facing: number;
  /** 模仿的機體外觀 */
  chassisId: string;
  parts: Record<string, PartState>;
  equipment: EquipState[];
}

/** 增援：第 turn 回合開始時從指定位置進場 */
export interface Reserve {
  turn: number;
  unit: UnitState;
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
  z?: number;
}

export interface GrappleState {
  a: string;
  b: string;
  advantage: string | null;
}

/**
 * deploy 開戰前的部署（自由部署才有，只在第 1 回合前）；
 * 每回合的步驟：move 移動 → ace 王牌移動（有人擱置才有）→ pursuit 追擊（有機體咬住敵機背後才有）→ action 動作
 */
export type TurnPhase = 'deploy' | 'move' | 'ace' | 'pursuit' | 'action';

/** 移動結算後、動作結算前要保留的本回合資訊 */
export interface TurnInfoState {
  stance: Record<string, Stance>;
  /** 本回合的移動向量（終點 − 起點，每回合單位）；中途停下、急停反轉或纏鬥中為 0。射擊用來算相對速度 */
  velocity: Record<string, Vec>;
  /** 擦撞的機體本回合不能執行動作 */
  bumped: string[];
  /** 擱置移動、等王牌移動步驟才動的機體 */
  deferred?: string[];
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
  /** 開戰前選的勝利條件與部署方式（舊紀錄沒有，照 DEFAULT_SETTINGS） */
  settings?: BattleSettings;
  /** 達陣、據點的進度 */
  objectives?: ObjectiveState;
  /** 欺敵氣球 */
  decoys?: Decoy[];
  /** 埋在地上的地雷 */
  mines?: Mine[];
  /** 還沒進場的增援 */
  reserves?: Reserve[];
  /** 各方看得到但分不出是什麼的機體（隔著煙霧） */
  obscured?: [string[], string[]];
  winReason?: WinReason;
}

// ---- 指令 ----

export type Action =
  | { type: 'none' }
  /** 射擊：weapon 加上 also 裡的武器一起打同一個目標 */
  | { type: 'shoot'; weapon: string; target: string; also?: string[] }
  | { type: 'lock'; target: string }
  /** 突進：衝到 1.5 格內的敵機身邊砍一刀；目標比自己低就是跳劈（要近戰姿態、手上有近戰武器） */
  | { type: 'lunge'; target: string }
  /** 展開盾：展開成正面的矮牆（已經展開就收起） */
  | { type: 'deploy'; weapon: string }
  /** 補給：停在自己的補給點上（動能 0），補滿彈藥與推進劑 */
  | { type: 'resupply' }
  /** 標定：用標定器掃描前方，隨機標定幾台敵機（weapon 是標定器；不用選目標、不用視線） */
  | { type: 'mark'; weapon: string }
  /** 丟煙霧彈、放欺敵氣球：at 是落點 */
  | { type: 'smoke'; weapon: string; at: Vec }
  | { type: 'decoy'; weapon: string; at: Vec }
  /** 埋地雷、架路障：at 是位置（路障橫擋在自己和 at 之間的方向上） */
  | { type: 'mine'; weapon: string; at: Vec }
  | { type: 'barricade'; weapon: string; at: Vec };

/** 第一步：移動（纏鬥中的機體不移動） */
export interface MovePlan {
  maneuver: string;
  stance: Stance;
  facingOffset: number;
  limiter: boolean;
  /** 王牌移動：這一步先不動，等其他人動完再決定（要有 ace_move 能力） */
  defer?: boolean;
  /** 拋棄外裝甲（免費，和限制器同一層級的操作） */
  purge?: boolean;
  /** 攀升（跳躍、蹬牆）：這回合撞到不太高的建築就爬上樓頂；速度要在 config.CLIMB_MAX_SPEED 以下才能用 */
  climb?: boolean;
  /** 感應武器（key 是裝備 id）：放出或移動到 to，或收回 */
  pods?: Record<string, PodOrder>;
}

export type PodOrder = { to: Vec } | { recall: true };

/** 第二步：移動結算後選的動作 */
export interface ActionPlan {
  /** 換武器（舊格式，只換一側）；新格式用 swaps */
  swap?: { hand: Hand; equip: string | null };
  /** 換武器：每一側的手和同側的武器架交換（null 收起來）；換武器的那一側這回合不能開火，另一側照常 */
  swaps?: Partial<Record<Hand, string | null>>;
  action: Action;
  /** 纏鬥中的機體選的手法（所有射擊結算完才結算纏鬥） */
  grapple?: GrappleChoice;
  /** 戰艦：每座砲塔各自的目標（key 是砲塔的裝備 id）；和本體的動作分開，不算連鎖動作 */
  salvo?: Record<string, string>;
  /** 指揮炮群攻擊（key 是裝備 id，值是 1–2 個目標）：無線的佔這回合的行動，線控的不佔 */
  pods?: Record<string, string[]>;
}

export type PlayerMoves = Record<string, MovePlan>;
/** 追擊：咬住敵機背後的機體多開一槍；沒寫或 null 表示放棄 */
export interface PursuitPlan {
  weapon: string;
  target: string;
}
export type PlayerPursuits = Record<string, PursuitPlan | null>;
/** 部署：位置、朝向（弧度，45° 的倍數）與起始動能 */
export interface DeployPlan {
  x: number;
  y: number;
  facing: number;
  momentum: number;
}
export type PlayerDeploy = Record<string, DeployPlan>;
export type PlayerActions = Record<string, ActionPlan>;

// ---- 事件 ----

export type ContactResult = 'none' | 'bump' | 'clinch' | 'hitrun' | 'ram';

export type GameEvent =
  | { type: 'turnStart'; turn: number }
  /** 對手看不到的那幾個時間點，取樣為 null */
  | { type: 'move'; unit: string; samples: ([number, number, number] | null)[] }
  | { type: 'obstacle'; t: number; unit: string; obstacle: string; damage: number }
  /** 高度改變：攀升上樓頂或從樓頂邊緣落下 */
  | { type: 'elevate'; t: number; unit: string; z: number; how: 'climb' | 'drop' }
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
  | { type: 'shot'; attacker: string; target: string; weapon: string; band: RangeBand; shots: number; hits: number; blocked: number; chance?: number; pursuit?: boolean; crits?: number; strays?: number; pod?: string; from?: Vec }
  /** typed：屬性相剋（weak 打在弱點上加傷、resist 被抵抗減傷） */
  | { type: 'damage'; unit: string; part: string; amount: number; destroyed: boolean; typed?: 'weak' | 'resist' }
  | { type: 'knockback'; unit: string; to: Vec; facing: number }
  | { type: 'stress'; unit: string; amount: number; total: number; reason: string }
  | { type: 'propellant'; unit: string; amount: number; total: number }
  | { type: 'pilot'; unit: string; state: 'blackout' | 'injured' | 'unconscious' | 'sluggish' }
  | { type: 'status'; unit: string; status: 'destroyed' | 'withdrawn' | 'disabled'; by?: string }
  | { type: 'defer'; unit: string }
  | { type: 'purge'; unit: string }
  /** 戰艦引擎被打壞後殉爆 */
  | { type: 'shipExplode'; unit: string; by?: string }
  /** 防禦彈幕打傷彈幕裡的單位 */
  | { type: 'barrage'; ship: string; unit: string }
  /** 炮群：放出、收回、失控（離母機太遠或母機不能指揮）、全滅 */
  | { type: 'pod'; unit: string; equip: string; what: 'launch' | 'recall' | 'lost' | 'destroyed'; at?: Vec; reason?: string }
  | { type: 'podHit'; unit: string; equip: string; by: string; bits: number }
  | { type: 'smoke'; unit: string; at: Vec; r: number }
  | { type: 'decoy'; unit: string; decoy: string }
  /** 埋地雷（對手看不到）；引爆 */
  | { type: 'mine'; unit: string; at: Vec }
  | { type: 'mineBlast'; unit: string; at: Vec; mine: string }
  /** 射擊建築：打掉一層就 levels 少一，collapsed 是整棟打平（變成瓦礫） */
  | { type: 'buildingShot'; attacker: string; obstacle: string; weapon: string; shots: number; hits: number; chance: number; amount: number; levels: number; collapsed: boolean }
  /** 在補給點補滿彈藥與推進劑 */
  | { type: 'resupply'; unit: string }
  /** 架路障（obstacle 是新的建築 id） */
  | { type: 'barricade'; unit: string; obstacle: string }
  | { type: 'decoyPop'; decoy: string; by?: string; reason: string }
  | { type: 'arrive'; unit: string }
  | { type: 'phase'; phase: TurnPhase }
  | { type: 'grapple'; a: string; b: string; choiceA: GrappleChoice; choiceB: GrappleChoice; summary: string; advantage: string | null; ended: boolean }
  | { type: 'reposition'; unit: string; to: Vec }
  | { type: 'swap'; unit: string; hand: Hand; equip: string | null }
  | { type: 'lock'; unit: string; target: string }
  /** 迫擊砲沒打中：砲彈落在 at，炸到附近的 units */
  | { type: 'blast'; by: string; at: Vec; units: string[] }
  /** 展開盾展開（up）或收起 */
  | { type: 'deploy'; unit: string; equip: string; up: boolean }
  /** 突進／跳劈：from 是出發位置；jump 是跳劈的落差（層），一般突進是 0 */
  | { type: 'lunge'; unit: string; target: string; from: Vec; to: Vec; jump: number }
  /** 標定；被標定的一方看不到標定的機體時 unit 是空字串 */
  | { type: 'mark'; unit: string; target: string }
  | { type: 'dazzle'; unit: string; by: string }
  | { type: 'actionFail'; unit: string; reason: string }
  | { type: 'fuelFire'; unit: string }
  | { type: 'gameOver'; winner: PlayerId | 'draw'; reason?: WinReason }
  | { type: 'objective'; side: PlayerId; text: string }
