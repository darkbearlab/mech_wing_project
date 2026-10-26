import * as C from './config';
import { damageUnit, type Ctx } from './damage';
import { lineOfFire, type Cover } from './terrain';
import { DEG, angleDiff, angleOf, dist, sub } from './geometry';
import type { EquipDef, EquipState, PartState, RangeBand, Stance, UnitState, Vec } from './types';
import { radiusOf, roleLost } from './body';
import { activeShields, chassisOf, equipDef, pilotOf } from './unit';

export interface Positioned {
  id: string;
  chassisId: string;
  pos: Vec;
  facing: number;
  parts: Record<string, PartState>;
}

export function edgeDistance(a: { pos: Vec; chassisId?: string }, b: { pos: Vec; chassisId?: string }): number {
  return dist(a.pos, b.pos) - radiusOf(a) - radiusOf(b);
}

export function rangeBand(a: { pos: Vec; chassisId?: string }, b: { pos: Vec; chassisId?: string }): RangeBand | null {
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
  /** 雙方本回合移動向量差的長度；不知道時（例如移動步驟）為 null */
  relSpeed: number | null;
  /** 射擊方是近戰姿態 */
  shooterMelee: boolean;
  /** 射擊線：被大隕石擋住就打不到，穿過隕石群命中下降；不知道時視為暢通 */
  cover?: Cover;
}

export function hitChance(h: HitInput): { band: RangeBand; chance: number } | null {
  const band = rangeBand(h.attacker, h.target);
  if (band === null) return null;
  if (band === 0 && h.weapon.pointBlank === false) return null;
  // 固定射界：射界外打不到
  const rel = relativeAngle(h.attacker, h.target.pos);
  if (h.weapon.arc !== undefined && rel > h.weapon.arc * DEG) return null;
  const rangeMod = band === 0 ? C.ZERO_RANGE_BONUS : h.weapon.ranges?.[band];
  if (rangeMod === undefined) return null;
  const atk = chassisOf(h.attacker);
  const def = chassisOf(h.target);
  let chance = C.HIT_BASE + atk.aim + h.attackerSkill * C.HIT_PER_SKILL + rangeMod - def.evasion;
  if (h.targetSkill !== null) chance -= h.targetSkill * C.EVADE_PER_SKILL;
  if (h.relSpeed !== null) chance += relativeSpeedMod(h.relSpeed);
  if (h.shooterMelee) chance -= C.MELEE_STANCE_SHOT_PENALTY;
  if (h.cover === 'blocked') return null;
  if (h.cover === 'field') chance -= C.FIELD_SHOT_PENALTY;
  if (h.weapon.arc === undefined && band > 0 && rel > C.OFF_FRONT_DEG * DEG) chance -= C.OFF_FRONT_PENALTY;
  if (h.attacker.lockOn === h.target.id) chance += C.LOCK_BONUS;
  if (band === 3 && roleLost(h.attacker, 'sensor')) chance -= C.HEAD_LONG_PENALTY;
  return { band, chance: Math.max(C.HIT_MIN, Math.min(C.HIT_MAX, chance)) };
}

/** 每面盾牌的防護範圍（弧度）：手持盾預設在持盾那側，固定盾照資料的角度 */
export function shieldArcs(u: { parts: Record<string, PartState>; equipment: EquipState[] }, facing: number): { equip: EquipState; center: number; half: number }[] {
  return activeShields(u).map(({ equip, hand }) => {
    const def = equipDef(equip);
    const offset = def.shieldOffset ?? (hand ? (hand === 'right' ? 1 : -1) * C.SHIELD_ARC_OFFSET_DEG : 0);
    return { equip, center: facing + offset * DEG, half: (def.shieldArc ?? C.SHIELD_ARC_HALF_DEG) * DEG };
  });
}

/** 從 from 打過來時擋得到的盾牌（沒有就 null） */
export function coveringShield(def: UnitState, from: Vec): EquipState | null {
  const dir = angleOf(sub(from, def.pos));
  return shieldArcs(def, def.facing).find((s) => Math.abs(angleDiff(dir, s.center)) <= s.half)?.equip ?? null;
}

export const inShieldArc = (def: UnitState, from: Vec): boolean => coveringShield(def, from) !== null;

const blockChance = (def: UnitState): number => C.SHIELD_BLOCK_BASE + pilotOf(def).skill * C.SHIELD_BLOCK_PER_SKILL;

export const relativeSpeedMod = (r: number): number => C.RELATIVE_SPEED_HIT.find(([max]) => r <= max)![1];

export function relativeSpeed(velocity: Record<string, Vec>, a: string, b: string): number {
  const va = velocity[a] ?? { x: 0, y: 0 };
  const vb = velocity[b] ?? { x: 0, y: 0 };
  return Math.hypot(va.x - vb.x, va.y - vb.y);
}

export interface TurnInfo {
  stance: Record<string, Stance>;
  velocity: Record<string, Vec>;
}

export function shoot(ctx: Ctx, turn: TurnInfo, attacker: UnitState, weapon: EquipState, target: UnitState): boolean {
  const def = equipDef(weapon);
  const h = hitChance({
    attacker,
    attackerSkill: pilotOf(attacker).skill,
    weapon: def,
    target,
    targetSkill: pilotOf(target).skill,
    relSpeed: relativeSpeed(turn.velocity, attacker.id, target.id),
    shooterMelee: turn.stance[attacker.id] === 'melee',
    cover: lineOfFire(ctx.state.obstacles, attacker.pos, target.pos),
  });
  if (!h) return false;
  if (weapon.ammo !== undefined) weapon.ammo--;
  if (attacker.lockOn === target.id) attacker.lockOn = null;
  const shots = def.shots ?? 1;
  const overflow = !!def.tags?.includes('overflow');
  let hits = 0;
  let blocked = 0;
  const pending: (() => void)[] = [];
  for (let i = 0; i < shots; i++) {
    if (ctx.rng.d100() > h.chance) continue;
    hits++;
    const shield = coveringShield(target, attacker.pos)?.id;
    if (shield && ctx.rng.d100() <= blockChance(target)) {
      blocked++;
      pending.push(() => damageUnit(ctx, target, def.damage ?? 1, 'focused', shield, overflow));
    } else {
      pending.push(() => damageUnit(ctx, target, def.damage ?? 1, def.mode ?? 'focused', undefined, overflow));
    }
  }
  ctx.events.push({ type: 'shot', attacker: attacker.id, target: target.id, weapon: def.id, band: h.band, shots, hits, blocked, chance: h.chance });
  for (const p of pending) p();
  // 零距離開火可能傷到自己的武器；內建武器沒有自己的部位，傷到宿主
  const selfPart = attacker.parts[weapon.id] ? weapon.id : weapon.host;
  if (h.band === 0 && selfPart && ctx.rng.d100() <= C.ZERO_RANGE_SELF_DAMAGE) damageUnit(ctx, attacker, 1, 'focused', selfPart);
  return true;
}

export type AngleClass = 'front' | 'side' | 'back';

export function contactAngle(def: UnitState, from: Vec): AngleClass {
  const rel = relativeAngle(def, from);
  if (rel <= C.FRONT_ARC_DEG * DEG) return 'front';
  if (rel >= C.BACK_ARC_DEG * DEG) return 'back';
  return 'side';
}
