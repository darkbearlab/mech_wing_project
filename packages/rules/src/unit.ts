import { FACING_OFFSETS, LIMITER_STRESS } from './config';
import { CHASSIS, EQUIPMENT, PILOTS } from './data';
import { parseManeuver, type ManeuverSpec } from './maneuvers';
import type { ActionPlan, ChassisDef, EquipDef, EquipState, Hand, MovePlan, PartState, PilotDef, UnitState } from './types';

export const chassisOf = (u: { chassisId: string }): ChassisDef => CHASSIS[u.chassisId];
export const pilotOf = (u: { pilotId: string }): PilotDef => PILOTS[u.pilotId];
export const equipDef = (e: EquipState): EquipDef => EQUIPMENT[e.defId];

export const isActive = (u: UnitState): boolean => u.status === 'active';

/** 該部位或裝備仍存在 */
export const partAlive = (u: { parts: Record<string, PartState> }, id: string): boolean => !!u.parts[id] && !u.parts[id].destroyed;

export const armOf = (hand: Hand): 'rarm' | 'larm' => (hand === 'right' ? 'rarm' : 'larm');

export function heldItem(u: { parts: Record<string, PartState>; equipment: EquipState[] }, hand: Hand): EquipState | null {
  if (!partAlive(u, armOf(hand))) return null;
  return u.equipment.find((e) => e.location === hand && partAlive(u, e.id)) ?? null;
}

export function heldOfKind(u: UnitState, kind: EquipDef['kind']): EquipState | null {
  for (const hand of ['right', 'left'] as Hand[]) {
    const item = heldItem(u, hand);
    if (item && equipDef(item).kind === kind) return item;
  }
  return null;
}

export function hasFreeHand(u: UnitState): boolean {
  return (['right', 'left'] as Hand[]).some((h) => partAlive(u, armOf(h)) && !heldItem(u, h));
}

export function shieldHand(u: UnitState): Hand | null {
  for (const hand of ['right', 'left'] as Hand[]) {
    const item = heldItem(u, hand);
    if (item && equipDef(item).kind === 'shield') return hand;
  }
  return null;
}

export interface ManeuverLimits {
  chassisId: string;
  parts: Record<string, PartState>;
  propellant?: number;
  blackout?: boolean;
}

/** 依部位損壞與黑視過濾；propellant 有提供時也過濾推進劑不足的機動 */
export function availableManeuvers(u: ManeuverLimits): ManeuverSpec[] {
  const packOk = partAlive(u, 'pack');
  const legsOk = partAlive(u, 'legs');
  return CHASSIS[u.chassisId].dial
    .map(parseManeuver)
    .filter((m) => (packOk || !m.highSpeed) && ((legsOk && !u.blackout) || !m.hard))
    .filter((m) => u.propellant === undefined || m.propellant <= u.propellant);
}

export function planCost(plan: MovePlan): { propellant: number; stress: number } {
  const m = parseManeuver(plan.maneuver);
  return {
    propellant: m.propellant,
    stress: m.stress + (plan.limiter && m.kind !== 'hover' ? LIMITER_STRESS : 0),
  };
}

export function validateMove(u: UnitState, plan: MovePlan, grappled: boolean): string[] {
  const errors: string[] = [];
  if (!grappled) {
    if (!availableManeuvers({ ...u, propellant: undefined }).some((m) => m.id === plan.maneuver)) errors.push(`${u.label}：無法使用機動 ${plan.maneuver}`);
    else if (planCost(plan).propellant > u.propellant) errors.push(`${u.label}：推進劑不足`);
  }
  if (!['normal', 'charge', 'evade'].includes(plan.stance)) errors.push(`${u.label}：姿態不正確`);
  if (!(FACING_OFFSETS as readonly number[]).includes(plan.facingOffset)) errors.push(`${u.label}：轉身角度不正確`);
  else if (plan.facingOffset !== 0 && !grappled && parseManeuver(plan.maneuver).kind !== 'hover') errors.push(`${u.label}：只有懸停時可以轉身`);
  return errors;
}

export function validateAction(u: UnitState, plan: ActionPlan): string[] {
  const errors: string[] = [];
  if (plan.swap) {
    const target = plan.swap.equip;
    if (target !== null && !u.equipment.some((e) => e.id === target && e.location !== 'mount')) errors.push(`${u.label}：沒有這件裝備`);
  }
  return errors;
}

export function defaultMove(u: UnitState): MovePlan {
  const options = availableManeuvers(u);
  const pick = options.find((m) => m.propellant === 0) ?? options[0];
  return { maneuver: pick?.id ?? 'hover-S-0', stance: 'normal', facingOffset: 0, limiter: false, soften: false, grapple: 'push' };
}

export const defaultAction = (): ActionPlan => ({ action: { type: 'none' } });
