import { FUEL_IGNITE_CHANCE, FUEL_IGNITE_DAMAGE } from './config';
import type { Rng } from './rng';
import type { DamageMode, GameEvent, GameState, UnitState } from './types';
import { armOf, equipDef, heldItem } from './unit';

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

export function damageUnit(ctx: Ctx, u: UnitState, amount: number, mode: DamageMode, forcePart?: string): void {
  if (amount <= 0) return;
  if (mode === 'focused') {
    hitPart(ctx, u, forcePart ?? rollPart(ctx.rng, u), amount);
  } else {
    for (let i = 0; i < amount; i++) hitPart(ctx, u, forcePart ?? rollPart(ctx.rng, u), 1);
  }
}

function hitPart(ctx: Ctx, u: UnitState, partId: string, amount: number): void {
  if (u.status === 'destroyed') return;
  let part = u.parts[partId];
  if (part.kind === 'body' && part.destroyed) part = u.parts.torso;
  // 打到持盾手臂的傷害先由盾牌承受
  if (part.id === 'rarm' || part.id === 'larm') {
    const held = heldItem(u, part.id === 'rarm' ? 'right' : 'left');
    if (held && equipDef(held).kind === 'shield') part = u.parts[held.id];
  }
  part.damage = Math.min(part.durability, part.damage + amount);
  const destroyed = part.damage >= part.durability;
  const newlyDestroyed = destroyed && !part.destroyed;
  part.destroyed = destroyed;
  ctx.events.push({ type: 'damage', unit: u.id, part: part.id, amount, destroyed: newlyDestroyed });
  if (part.id === 'torso') addStress(ctx, u, amount, '軀幹受創');
  if (newlyDestroyed) onDestroyed(ctx, u, part.id);
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
  if (partId === 'torso') {
    u.status = 'destroyed';
    ctx.events.push({ type: 'status', unit: u.id, status: 'destroyed' });
    return;
  }
  if (partId === 'rarm' || partId === 'larm') {
    const hand = partId === 'rarm' ? 'right' : 'left';
    for (const e of u.equipment) if (e.location === hand && armOf(hand) === partId) destroyPart(ctx, u, e.id);
    return;
  }
  if (partId === 'head') {
    u.lockOn = null;
    return;
  }
  const equip = u.equipment.find((e) => e.id === partId);
  if (equip && equipDef(equip).kind === 'tank') {
    const fuel = equipDef(equip).fuel ?? 0;
    u.maxPropellant -= fuel;
    if (u.propellant > u.maxPropellant) spendPropellant(ctx, u, u.propellant - u.maxPropellant);
    if (ctx.rng.d100() <= FUEL_IGNITE_CHANCE) {
      ctx.events.push({ type: 'fuelFire', unit: u.id });
      hitPart(ctx, u, 'torso', FUEL_IGNITE_DAMAGE);
    }
  }
}
