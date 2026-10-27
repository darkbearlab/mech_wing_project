import * as C from './config';
import { FUEL_IGNITE_CHANCE, FUEL_IGNITE_DAMAGE } from './config';
import { CHASSIS, EQUIPMENT } from './data';
import type { Rng } from './rng';
import type { DamageMode, GameEvent, GameState, UnitState, Vec } from './types';
import { isShip, shipPartMultiplier } from './ship';
import { corePart, handOfPart, roleLost } from './body';
import { equipDef, heldItem, pilotOf } from './unit';

export interface Ctx {
  state: GameState;
  rng: Rng;
  events: GameEvent[];
  /** 目前這筆傷害是誰造成的（擊墜記在他身上）；撞隕石、自傷等沒有 */
  by?: string;
  /** 射擊瞄準的機體：瞄準要害只加在它身上（誤擊到旁邊纏鬥的機體不算） */
  aimAt?: string;
  /** 沒辦法瞄準的傷害（撞擊）：瞄準要害不生效 */
  unaimed?: boolean;
  /** 射擊位置（打戰艦時決定比較容易打到哪裡） */
  from?: Vec;
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
export function shotBy(ctx: Ctx, by: UnitState, aim: UnitState, fn: () => void): void {
  const prev = ctx.aimAt;
  const prevFrom = ctx.from;
  ctx.aimAt = aim.id;
  ctx.from = { ...by.pos };
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
  if (mode === 'focused') {
    const spill = hitPart(ctx, u, forcePart ?? rollPart(ctx.rng, u, bonus, mult), amount);
    if (overflow) for (let i = 0; i < spill && u.status !== 'destroyed'; i++) hitPart(ctx, u, rollPart(ctx.rng, u, bonus, mult), 1);
  } else {
    for (let i = 0; i < amount; i++) hitPart(ctx, u, forcePart ?? rollPart(ctx.rng, u, bonus, mult), 1);
  }
}

/** 回傳打壞部位後多出來的傷害 */
function hitPart(ctx: Ctx, u: UnitState, partId: string, amount: number): number {
  if (u.status === 'destroyed') return 0;
  let part = u.parts[partId];
  if (part.kind === 'body' && part.destroyed) part = u.parts[corePart(u)];
  // 打到持盾那隻手的傷害先由盾牌承受
  const shieldHand = handOfPart(u, part.id);
  if (shieldHand) {
    const held = heldItem(u, shieldHand);
    if (held && equipDef(held).kind === 'shield') part = u.parts[held.id];
  }
  const spill = Math.max(0, amount - (part.durability - part.damage));
  part.damage = Math.min(part.durability, part.damage + amount);
  const destroyed = part.damage >= part.durability;
  const newlyDestroyed = destroyed && !part.destroyed;
  part.destroyed = destroyed;
  ctx.events.push({ type: 'damage', unit: u.id, part: part.id, amount, destroyed: newlyDestroyed });
  // 戰艦的艦體很大，挨打不會讓艦長受衝擊
  if (part.role === 'core' && !isShip(u)) addStress(ctx, u, amount, `${part.name}受創`);
  if (newlyDestroyed) onDestroyed(ctx, u, part.id);
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
