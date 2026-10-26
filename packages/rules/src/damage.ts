import { FUEL_IGNITE_CHANCE, FUEL_IGNITE_DAMAGE } from './config';
import type { Rng } from './rng';
import type { DamageMode, GameEvent, GameState, UnitState } from './types';
import { corePart, handOfPart, roleLost } from './body';
import { equipDef, heldItem } from './unit';

export interface Ctx {
  state: GameState;
  rng: Rng;
  events: GameEvent[];
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
export function rollPart(rng: Rng, u: UnitState): string {
  const candidates = Object.values(u.parts).filter((p) => p.kind === 'body' || !p.destroyed);
  return rng.pickWeighted(candidates, (p) => p.weight).id;
}

/** overflow：打壞部位後多出來的傷害，每 1 點再擲一次命中部位、各造成 1 點（火箭砲的爆風） */
export function damageUnit(ctx: Ctx, u: UnitState, amount: number, mode: DamageMode, forcePart?: string, overflow = false): void {
  if (amount <= 0) return;
  if (mode === 'focused') {
    const spill = hitPart(ctx, u, forcePart ?? rollPart(ctx.rng, u), amount);
    if (overflow) for (let i = 0; i < spill && u.status !== 'destroyed'; i++) hitPart(ctx, u, rollPart(ctx.rng, u), 1);
  } else {
    for (let i = 0; i < amount; i++) hitPart(ctx, u, forcePart ?? rollPart(ctx.rng, u), 1);
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
  if (part.role === 'core') addStress(ctx, u, amount, `${part.name}受創`);
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
  if (role === 'core' && roleLost(u, 'core')) {
    u.status = 'destroyed';
    ctx.events.push({ type: 'status', unit: u.id, status: 'destroyed' });
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
