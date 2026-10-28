import * as C from './config';
import { FUEL_IGNITE_CHANCE, FUEL_IGNITE_DAMAGE } from './config';
import { CHASSIS, EQUIPMENT } from './data';
import type { Rng } from './rng';
import type { ArmorType, DamageMode, DamageType, GameEvent, GameState, UnitState, Vec } from './types';
import { isShip, shipPartMultiplier } from './ship';
import { corePart, handOfPart, handPart, roleLost } from './body';
import { DEG, angleDiff, angleOf, sub } from './geometry';
import { equipDef, heldItem, pilotOf } from './unit';

export interface Ctx {
  state: GameState;
  rng: Rng;
  events: GameEvent[];
  /** 目前這筆傷害是誰造成的（擊墜記在他身上）；撞隕石、自傷等沒有 */
  by?: string;
  /** 射擊瞄準的機體：瞄準要害只加在它身上（誤擊到旁邊纏鬥的機體不算） */
  aimAt?: string;
  /** 從上方打下來的傷害：部位照頂部攻擊表（腿部很難中） */
  topAttack?: boolean;
  /** 這筆傷害的屬性（沒寫的不受裝甲相剋影響：墜落、撞牆、自傷等） */
  damageType?: DamageType;
  /** 沒辦法瞄準的傷害（撞擊）：瞄準要害不生效 */
  unaimed?: boolean;
  /** 射擊位置（打戰艦時決定比較容易打到哪裡；也決定打中哪個方向的部位） */
  from?: Vec;
  /** 沒有方向的傷害（樓塌下來）：部位不看攻擊方向 */
  undirected?: boolean;
}

/** 以 by 的名義造成傷害（擊墜歸屬），結束後還原 */
export function dealtBy(ctx: Ctx, by: UnitState | null | undefined, fn: () => void, aimed = true): void {
  const prev = ctx.by;
  const prevUnaimed = ctx.unaimed;
  ctx.by = by?.id;
  ctx.unaimed = !aimed;
  try {
    fn();
  } finally {
    ctx.by = prev;
    ctx.unaimed = prevUnaimed;
  }
}

/** 新人類擊墜的壓力：依對方機上人員、自己的感受，擊墜新人類另外加；纖細的還會降低最大壓力 */
function killStress(ctx: Ctx, killer: UnitState, victim: UnitState): void {
  const p = pilotOf(killer);
  if (!p.abilities.includes('newtype') || !p.ntSense || killer.status !== 'active' || killer.owner === victim.owner) return;
  const crew = CHASSIS[victim.chassisId]?.crew ?? 'pilot';
  if (crew === 'unmanned') return;
  let amount = (crew === 'ship' ? C.NT_KILL_SHIP_STRESS : C.NT_KILL_STRESS)[p.ntSense];
  if (pilotOf(victim).abilities.includes('newtype')) amount += C.NT_KILL_NT_EXTRA;
  addStress(ctx, killer, amount, `擊墜 ${victim.label}（新人類的感應）`);
  if (p.ntSense === 'fragile') killer.maxStress = Math.max(1, killer.maxStress - C.NT_FRAGILE_MAX_LOSS);
}

export function unitById(ctx: Ctx, id: string): UnitState {
  const u = ctx.state.units.find((x) => x.id === id);
  if (!u) throw new Error(`no unit ${id}`);
  return u;
}

export function addStress(ctx: Ctx, u: UnitState, amount: number, reason: string): void {
  if (amount === 0 || u.status !== 'active') return;
  u.stress = Math.max(0, u.stress + amount);
  ctx.events.push({ type: 'stress', unit: u.id, amount, total: u.stress, reason });
}

export function spendPropellant(ctx: Ctx, u: UnitState, amount: number): void {
  if (amount === 0) return;
  u.propellant = Math.max(0, u.propellant - amount);
  ctx.events.push({ type: 'propellant', unit: u.id, amount: -amount, total: u.propellant });
}

/** 部位所在的功能位置：機體部位照自己的功能；外掛照掛的部位；手上拿的照那隻手 */
function partRole(u: UnitState, p: UnitState['parts'][string]): string | null {
  if (p.kind === 'body') return p.role ?? null;
  const e = u.equipment.find((x) => x.id === p.id);
  if (!e) return null;
  if (e.location === 'right') return 'rightHand';
  if (e.location === 'left') return 'leftHand';
  const host = e.host ? u.parts[e.host] : undefined;
  return host?.role ?? null;
}

/** 從 from 打過來是目標的正面、側面還是背後 */
export function attackSide(u: Pick<UnitState, 'pos' | 'facing'>, from: Vec): 'front' | 'side' | 'back' {
  const abs = Math.abs(angleDiff(angleOf(sub(from, u.pos)), u.facing));
  return abs <= C.FRONT_ARC_DEG * DEG ? 'front' : abs >= C.BACK_ARC_DEG * DEG ? 'back' : 'side';
}

/** 從 from 打過來時各部位的權重倍率（HIT_DIRECTION_WEIGHT） */
export function directionWeight(u: UnitState, from: Vec): (p: UnitState['parts'][string]) => number {
  // 正值 = 順時針 = 目標的右手邊
  const rel = angleDiff(angleOf(sub(from, u.pos)), u.facing);
  const side = attackSide(u, from);
  const w = C.HIT_DIRECTION_WEIGHT[side];
  const near = rel > 0 ? 'rightHand' : 'leftHand';
  return (p) => {
    const role = partRole(u, p);
    if (!role) return 1;
    if (role === 'rightHand' || role === 'leftHand') return side === 'side' ? ((role === near ? w.near : w.far) ?? 1) : 1;
    return w[role as 'core' | 'sensor' | 'propulsion' | 'legs'] ?? 1;
  };
}

/** 依權重擲命中部位。機體部位永遠在表內（已破壞→轉軀幹）；已破壞的裝備移出權重表。 */
const partCandidates = (u: UnitState) => Object.values(u.parts).filter((p) => p.kind === 'body' || !p.destroyed);
const partWeight = (p: UnitState['parts'][string], coreBonus: number) => p.weight + (p.kind === 'body' && p.role === 'core' && !p.destroyed ? coreBonus : 0);

/** 抽命中部位；coreBonus：核心部位多加的權重（瞄準要害） */
export function rollPart(rng: Rng, u: UnitState, coreBonus = 0, mult?: (p: UnitState['parts'][string]) => number): string {
  return rng.pickWeighted(partCandidates(u), (p) => partWeight(p, coreBonus) * (mult ? mult(p) : 1)).id;
}

/** 這台機體的部位權重總和（射進纏鬥時決定打到誰） */
export const bodyWeight = (u: UnitState, coreBonus = 0): number => partCandidates(u).reduce((n, p) => n + partWeight(p, coreBonus), 0);

/** 這筆傷害的來源有瞄準要害能力的話，核心部位加權 */
function calledShotBonus(ctx: Ctx): number {
  const by = ctx.by ? ctx.state.units.find((x) => x.id === ctx.by) : undefined;
  return by && pilotOf(by).abilities.includes('called_shot') ? C.CALLED_SHOT_CORE_BONUS : 0;
}

/** 以 by 的名義、瞄準 aim 造成傷害 */
export function shotBy(ctx: Ctx, by: UnitState, aim: UnitState, fn: () => void, from: Vec = by.pos): void {
  const prev = ctx.aimAt;
  const prevFrom = ctx.from;
  ctx.aimAt = aim.id;
  ctx.from = { ...from };
  try {
    dealtBy(ctx, by, fn);
  } finally {
    ctx.aimAt = prev;
    ctx.from = prevFrom;
  }
}

/** overflow：打壞部位後多出來的傷害，每 1 點再擲一次命中部位、各造成 1 點（火箭砲的爆風） */
export function damageUnit(ctx: Ctx, u: UnitState, amount: number, mode: DamageMode, forcePart?: string, overflow = false): void {
  if (amount <= 0) return;
  let bonus = ctx.unaimed || (ctx.aimAt && ctx.aimAt !== u.id) ? 0 : calledShotBonus(ctx);
  // 戰艦：不加核心權重，改成看方位與對艦特效加重弱點
  let mult: ((p: UnitState['parts'][string]) => number) | undefined;
  if (isShip(u)) {
    const by = ctx.by ? ctx.state.units.find((x) => x.id === ctx.by) : undefined;
    const aimed = !ctx.unaimed && (!ctx.aimAt || ctx.aimAt === u.id) && !!by && (pilotOf(by).abilities.includes('ship_killer') || pilotOf(by).abilities.includes('called_shot'));
    mult = shipPartMultiplier(u, ctx.unaimed ? undefined : ctx.from, aimed, !!by && isShip(by));
    bonus = 0;
  } else if (ctx.topAttack) {
    mult = (p) => (p.kind === 'body' && p.role ? (C.TOP_ATTACK_WEIGHT[p.role] ?? 1) : 1);
  } else {
    // 從哪個方向打過來：射擊照射擊位置，近戰、撞擊照造成傷害的機體位置（墜落、地雷、自傷等沒有方向）
    const by = ctx.by ? ctx.state.units.find((x) => x.id === ctx.by) : undefined;
    const from = ctx.from ?? (by && by.id !== u.id ? by.pos : undefined);
    if (from && !ctx.undirected) {
      mult = directionWeight(u, from);
      // 正面裝甲最厚：從正面打過來的傷害打折
      if (attackSide(u, from) === 'front') amount = Math.max(1, Math.round(amount * C.FRONT_DAMAGE_MULT));
    }
  }
  // 外裝甲先吸收（盾牌擋下的照樣打盾）；打掉就自動脫落
  if (forcePart === undefined) {
    const armor = u.equipment.find((e) => EQUIPMENT[e.defId]?.kind === 'armor' && e.location === 'mount' && u.parts[e.id] && !u.parts[e.id].destroyed);
    if (armor) {
      const part = u.parts[armor.id];
      const absorb = Math.min(amount, part.durability - part.damage);
      if (absorb > 0) hitPart(ctx, u, armor.id, absorb);
      amount -= absorb;
      if (amount <= 0) return;
    }
  }
  // 分散傷害、溢出的傷害：每 DAMAGE_SCALE（舊的 1 點）抽一次部位
  if (mode === 'focused') {
    const spill = hitPart(ctx, u, forcePart ?? rollPart(ctx.rng, u, bonus, mult), amount);
    if (overflow) for (const n of chunks(spill)) if (u.status !== 'destroyed') hitPart(ctx, u, rollPart(ctx.rng, u, bonus, mult), n);
  } else {
    for (const n of chunks(amount)) hitPart(ctx, u, forcePart ?? rollPart(ctx.rng, u, bonus, mult), n);
  }
}

const chunks = (n: number): number[] => {
  const out: number[] = [];
  for (let left = n; left > 0; left -= C.DAMAGE_SCALE) out.push(Math.min(C.DAMAGE_SCALE, left));
  return out;
};

/** 這個部位的裝甲種類：機體部位照機型，盾牌與外裝甲照裝備；武器和其他裝備沒有（不剋也不被剋） */
export function partArmor(u: Pick<UnitState, 'chassisId' | 'equipment'>, part: { id: string; kind: string }): ArmorType | undefined {
  if (part.kind === 'body') return CHASSIS[u.chassisId]?.armorType;
  const e = u.equipment.find((x) => x.id === part.id);
  return e ? EQUIPMENT[e.defId]?.armorType : undefined;
}

export const DAMAGE_TYPE_NAMES: Record<DamageType, string> = { kinetic: '動能', energy: '能量', chemical: '化學能' };
export const ARMOR_NAMES: Record<ArmorType, string> = { composite: '複合裝甲', reflective: '反射裝甲', ceramic: '陶瓷裝甲' };

/** 這種屬性打這種裝甲的說明（例：「抵抗 −25%」）；不相剋是空字串 */
export function matchupText(armor: ArmorType | undefined, type: DamageType | undefined): string {
  const m = typeMultiplier(armor, type);
  if (m === 1) return '';
  return `${ARMOR_NAMES[armor!]}${m > 1 ? '弱點' : '抵抗'} ${m > 1 ? '+' : '−'}${Math.round(Math.abs(m - 1) * 100)}%`;
}

/** 屬性相剋的倍率（沒有屬性或沒有裝甲是 1） */
export function typeMultiplier(armor: ArmorType | undefined, type: DamageType | undefined): number {
  if (!armor || !type) return 1;
  if (C.ARMOR_RESISTS[armor] === type) return 1 - C.TYPE_MULT;
  if (C.ARMOR_WEAK[armor] === type) return 1 + C.TYPE_MULT;
  return 1;
}

/** 機械外露：還沒壞的機體部位，耐久剩 EXPOSED_RATIO 以下 */
export const exposed = (p: { kind: string; durability: number; damage: number; destroyed?: boolean }): boolean =>
  p.kind === 'body' && !p.destroyed && p.durability > 0 && p.durability - p.damage <= p.durability * C.EXPOSED_RATIO + 1e-9;

/** 以 type 屬性造成傷害 */
export function typed(ctx: Ctx, type: DamageType | undefined, fn: () => void): void {
  const prev = ctx.damageType;
  ctx.damageType = type;
  try {
    fn();
  } finally {
    ctx.damageType = prev;
  }
}

/** 回傳打壞部位後多出來的傷害（還沒乘屬性倍率的原始值） */
function hitPart(ctx: Ctx, u: UnitState, partId: string, raw: number): number {
  if (u.status === 'destroyed') return 0;
  let part = u.parts[partId];
  if (part.kind === 'body' && part.destroyed) part = u.parts[corePart(u)];
  // 打到持盾那隻手的傷害先由盾牌承受（從上方打下來的不會，盾是擋在前面的）
  const shieldHand = ctx.topAttack ? null : handOfPart(u, part.id);
  if (shieldHand) {
    const held = heldItem(u, shieldHand);
    if (held && equipDef(held).kind === 'shield') part = u.parts[held.id];
  }
  // 屬性相剋：照這個部位的裝甲加減傷；打穿多出來的傷害換回原始值，再照下一個部位的裝甲算
  // 機械外露的部位：不管裝甲與屬性，一律算弱點
  const bare = exposed(part);
  const m = bare ? 1 + C.TYPE_MULT : typeMultiplier(partArmor(u, part), ctx.damageType);
  const amount = m === 1 ? raw : Math.max(1, Math.round(raw * m));
  const over = Math.max(0, amount - (part.durability - part.damage));
  const spill = m === 1 ? over : Math.round(over / m);
  part.damage = Math.min(part.durability, part.damage + amount);
  const destroyed = part.damage >= part.durability;
  const newlyDestroyed = destroyed && !part.destroyed;
  part.destroyed = destroyed;
  ctx.events.push({ type: 'damage', unit: u.id, part: part.id, amount, destroyed: newlyDestroyed, ...(m > 1 ? { typed: 'weak' as const } : m < 1 ? { typed: 'resist' as const } : {}), ...(bare ? { exposed: true } : {}) });
  // 戰艦的艦體很大，挨打不會讓艦長受衝擊；壓力照舊的點數算
  if (part.role === 'core' && !isShip(u)) addStress(ctx, u, Math.max(1, Math.round(amount / C.DAMAGE_SCALE)), `${part.name}受創`);
  if (newlyDestroyed) onDestroyed(ctx, u, part.id);
  // 裝備（武器、盾、收著的東西）被打穿：多出來的傷害打進拿著它或掛著它的部位，不會被一件小裝備整發吸掉
  if (spill > 0 && part.kind === 'equip' && (u.status as string) !== 'destroyed') {
    const e = u.equipment.find((x) => x.id === part.id);
    const carrier = e && (e.location === 'right' || e.location === 'left') ? handPart(u, e.location) : e?.host;
    hitPart(ctx, u, carrier && u.parts[carrier] ? carrier : corePart(u), spill);
    return 0;
  }
  return spill;
}

function destroyPart(ctx: Ctx, u: UnitState, partId: string): void {
  const part = u.parts[partId];
  if (part.destroyed) return;
  part.destroyed = true;
  part.damage = part.durability;
  ctx.events.push({ type: 'damage', unit: u.id, part: partId, amount: 0, destroyed: true });
  onDestroyed(ctx, u, partId);
}

function onDestroyed(ctx: Ctx, u: UnitState, partId: string): void {
  // 掛在這個部位上的外掛武裝一起掉落；內建與內藏的會跟著失效（不需要另外處理）
  for (const e of u.equipment) if (e.host === partId && u.parts[e.id]) destroyPart(ctx, u, e.id);
  const role = u.parts[partId]?.role;
  // 戰艦的引擎全毀：擲殉爆，成功就擊沉
  if (role === 'propulsion' && isShip(u) && roleLost(u, 'propulsion') && u.status === 'active' && ctx.rng.d100() <= C.SHIP_ENGINE_EXPLODE) {
    ctx.events.push({ type: 'shipExplode', unit: u.id, ...(ctx.by ? { by: ctx.by } : {}) });
    for (const p of Object.values(u.parts)) if (p.role === 'core' && !p.destroyed) destroyPart(ctx, u, p.id);
    return;
  }
  if (role === 'core' && roleLost(u, 'core')) {
    u.status = 'destroyed';
    ctx.events.push({ type: 'status', unit: u.id, status: 'destroyed', ...(ctx.by ? { by: ctx.by } : {}) });
    const killer = ctx.by ? ctx.state.units.find((x) => x.id === ctx.by) : undefined;
    if (killer) killStress(ctx, killer, u);
    return;
  }
  const hand = handOfPart(u, partId);
  if (hand) {
    // 手上拿的東西一起失效（內藏武器拿在手上時沒有自己的部位，靠宿主判斷存亡）
    for (const e of u.equipment) if (e.location === hand && u.parts[e.id]) destroyPart(ctx, u, e.id);
    return;
  }
  if (role === 'sensor') {
    if (roleLost(u, 'sensor')) u.lockOn = null;
    return;
  }
  if (u.parts[partId]?.kind === 'body') return;
  const equip = u.equipment.find((e) => e.id === partId);
  if (!equip) return;
  const def = equipDef(equip);
  if (def.kind === 'tank') {
    const fuel = def.fuel ?? 0;
    u.maxPropellant -= fuel;
    if (u.propellant > u.maxPropellant) spendPropellant(ctx, u, u.propellant - u.maxPropellant);
  }
  // 燃料槽與標了 volatile 的武裝（飛彈莢艙等）被打壞時可能引爆，傷到宿主部位
  if ((def.kind === 'tank' || def.tags?.includes('volatile')) && ctx.rng.d100() <= FUEL_IGNITE_CHANCE) {
    ctx.events.push({ type: 'fuelFire', unit: u.id });
    const host = equip.host && u.parts[equip.host] && !u.parts[equip.host].destroyed ? equip.host : corePart(u);
    hitPart(ctx, u, host, FUEL_IGNITE_DAMAGE);
  }
}
