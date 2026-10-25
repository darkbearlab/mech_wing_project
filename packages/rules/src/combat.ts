import * as C from './config';
import { addStress, damageUnit, type Ctx } from './damage';
import { DEG, angleDiff, angleOf, dist, sub } from './geometry';
import { EQUIPMENT } from './data';
import type { EquipDef, EquipState, PartState, RangeBand, Stance, UnitState, Vec } from './types';
import { chassisOf, equipDef, heldOfKind, partAlive, pilotOf, shieldHand } from './unit';

export interface Positioned {
  id: string;
  chassisId: string;
  pos: Vec;
  facing: number;
  parts: Record<string, PartState>;
}

export function edgeDistance(a: { pos: Vec }, b: { pos: Vec }): number {
  return dist(a.pos, b.pos) - 2 * C.BASE_RADIUS;
}

export function rangeBand(a: { pos: Vec }, b: { pos: Vec }): RangeBand | null {
  const d = edgeDistance(a, b);
  if (d <= C.RANGE_LIMITS.r0) return 0;
  if (d <= C.RANGE_LIMITS.r1) return 1;
  if (d <= C.RANGE_LIMITS.r2) return 2;
  if (d <= C.RANGE_LIMITS.r3) return 3;
  return null;
}

export const bandName = (b: RangeBand): string => ['零距離', 'Range 1', '中距離', '遠距離'][b];

/** 從 from 看 to 的方向，相對於 from 朝向的角度（絕對值，弧度） */
export function relativeAngle(from: { pos: Vec; facing: number }, to: Vec): number {
  return Math.abs(angleDiff(angleOf(sub(to, from.pos)), from.facing));
}

export interface HitInput {
  attacker: Positioned & { lockOn?: string | null };
  attackerSkill: number;
  weapon: EquipDef;
  target: Positioned;
  /** 未知時（對手視角）為 null */
  targetSkill: number | null;
  targetStance: Stance | null;
  targetHovered: boolean;
}

export function hitChance(h: HitInput): { band: RangeBand; chance: number } | null {
  const band = rangeBand(h.attacker, h.target);
  if (band === null) return null;
  const rangeMod = band === 0 ? C.ZERO_RANGE_BONUS : h.weapon.ranges?.[band];
  if (rangeMod === undefined) return null;
  const atk = chassisOf(h.attacker);
  const def = chassisOf(h.target);
  let chance = C.HIT_BASE + atk.aim + h.attackerSkill * C.HIT_PER_SKILL + rangeMod - def.evasion;
  if (h.targetSkill !== null) chance -= h.targetSkill * C.EVADE_PER_SKILL;
  if (h.targetStance === 'evade') chance -= C.EVADE_STANCE_BONUS;
  if (h.targetHovered) chance += C.HOVER_EVASION_PENALTY;
  if (band > 0 && relativeAngle(h.attacker, h.target.pos) > C.OFF_FRONT_DEG * DEG) chance -= C.OFF_FRONT_PENALTY;
  if (h.attacker.lockOn === h.target.id) chance += C.LOCK_BONUS;
  if (band === 3 && !partAlive(h.attacker, 'head')) chance -= C.HEAD_LONG_PENALTY;
  return { band, chance: Math.max(C.HIT_MIN, Math.min(C.HIT_MAX, chance)) };
}

export function inShieldArc(def: UnitState, from: Vec): boolean {
  const hand = shieldHand(def);
  if (!hand) return false;
  const center = def.facing + (hand === 'right' ? 1 : -1) * C.SHIELD_ARC_OFFSET_DEG * DEG;
  return Math.abs(angleDiff(angleOf(sub(from, def.pos)), center)) <= C.SHIELD_ARC_HALF_DEG * DEG;
}

function shieldPart(def: UnitState): string | null {
  return heldOfKind(def, 'shield')?.id ?? null;
}

const blockChance = (def: UnitState): number => C.SHIELD_BLOCK_BASE + pilotOf(def).skill * C.SHIELD_BLOCK_PER_SKILL;

export interface TurnInfo {
  stance: Record<string, Stance>;
  hovered: Set<string>;
}

export function shoot(ctx: Ctx, turn: TurnInfo, attacker: UnitState, weapon: EquipState, target: UnitState): boolean {
  const def = equipDef(weapon);
  const h = hitChance({
    attacker,
    attackerSkill: pilotOf(attacker).skill,
    weapon: def,
    target,
    targetSkill: pilotOf(target).skill,
    targetStance: turn.stance[target.id] ?? 'normal',
    targetHovered: turn.hovered.has(target.id),
  });
  if (!h) return false;
  if (attacker.lockOn === target.id) attacker.lockOn = null;
  const shots = def.shots ?? 1;
  let hits = 0;
  let blocked = 0;
  const pending: (() => void)[] = [];
  for (let i = 0; i < shots; i++) {
    if (ctx.rng.d100() > h.chance) continue;
    hits++;
    const shield = shieldPart(target);
    if (shield && inShieldArc(target, attacker.pos) && ctx.rng.d100() <= blockChance(target)) {
      blocked++;
      pending.push(() => damageUnit(ctx, target, def.damage ?? 1, 'focused', shield));
    } else {
      pending.push(() => damageUnit(ctx, target, def.damage ?? 1, def.mode ?? 'focused'));
    }
  }
  ctx.events.push({ type: 'shot', attacker: attacker.id, target: target.id, weapon: def.id, band: h.band, shots, hits, blocked, chance: h.chance });
  for (const p of pending) p();
  if (h.band === 0 && ctx.rng.d100() <= C.ZERO_RANGE_SELF_DAMAGE) damageUnit(ctx, attacker, 1, 'focused', weapon.id);
  return true;
}

export type AngleClass = 'front' | 'side' | 'back';

export function contactAngle(def: UnitState, from: Vec): AngleClass {
  const rel = relativeAngle(def, from);
  if (rel <= C.FRONT_ARC_DEG * DEG) return 'front';
  if (rel >= C.BACK_ARC_DEG * DEG) return 'back';
  return 'side';
}

/** 一擊脫離的斬擊（含防守方的自動反應） */
export function strike(ctx: Ctx, attacker: UnitState, defender: UnitState, t: number): void {
  const blade = heldOfKind(attacker, 'melee');
  if (!blade) return;
  const def = EQUIPMENT[blade.defId];
  const angle = contactAngle(defender, attacker.pos);
  if (angle === 'front' && heldOfKind(defender, 'melee')) {
    const chance = C.PARRY_BASE + pilotOf(defender).skill * C.PARRY_PER_SKILL;
    if (ctx.rng.d100() <= chance) {
      ctx.events.push({ type: 'strike', t, attacker: attacker.id, defender: defender.id, weapon: def.id, outcome: 'parried', angle, chance });
      return;
    }
  }
  const shield = shieldPart(defender);
  if (shield && angle !== 'back' && inShieldArc(defender, attacker.pos)) {
    const chance = blockChance(defender);
    if (ctx.rng.d100() <= chance) {
      ctx.events.push({ type: 'strike', t, attacker: attacker.id, defender: defender.id, weapon: def.id, outcome: 'blocked', angle, chance });
      damageUnit(ctx, defender, def.damage ?? 1, 'focused', shield);
      return;
    }
  }
  ctx.events.push({ type: 'strike', t, attacker: attacker.id, defender: defender.id, weapon: def.id, outcome: 'hit', angle });
  if (angle === 'back') addStress(ctx, defender, C.BACKSTAB_STRESS, '背後偷襲');
  damageUnit(ctx, defender, def.damage ?? 1, 'focused');
}
