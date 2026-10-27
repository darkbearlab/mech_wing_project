import { FACING_OFFSETS, G_FREE_DV, LIMITER_STRESS, PACK_BROKEN_ACCEL, SLIDE_MAX_MOMENTUM, SLIDE2_MIN_ACCEL } from './config';
import { closeCombatOf, handOfPart, handPart, minSpeedOf, roleLost } from './body';
import { CHASSIS, EQUIPMENT, PILOTS } from './data';
import { parseManeuver, type ManeuverSpec } from './maneuvers';
import type { ActionPlan, ChassisDef, EquipDef, EquipState, Hand, MovePlan, PartState, PilotDef, UnitState } from './types';

export const chassisOf = (u: { chassisId: string }): ChassisDef => CHASSIS[u.chassisId];
export const pilotOf = (u: { pilotId: string }): PilotDef => PILOTS[u.pilotId];
export const equipDef = (e: EquipState): EquipDef => EQUIPMENT[e.defId];

export const isActive = (u: UnitState): boolean => u.status === 'active';

/** 該部位或裝備仍存在 */
export const partAlive = (u: { parts: Record<string, PartState> }, id: string): boolean => !!u.parts[id] && !u.parts[id].destroyed;

/** 這隻手還在而且能握持（沒有手的機型永遠不行） */
export function handUsable(u: Gear, hand: Hand): boolean {
  const p = handPart(u, hand);
  return !!p && partAlive(u, p) && !handBlocked(u, hand);
}

type Gear = { parts: Record<string, PartState>; equipment: EquipState[] };

/** 裝備還能不能用：有自己部位的看部位，沒有的（內建、內藏）看宿主 */
export function equipAlive(u: Gear, e: EquipState): boolean {
  if (u.parts[e.id]) return !u.parts[e.id].destroyed && (!e.host || partAlive(u, e.host));
  return e.host ? partAlive(u, e.host) : true;
}

/** 這隻手被佔手的內建武器（手指光束砲）佔住，完全不能握持 */
export const handBlocked = (u: Gear, hand: Hand): boolean => u.equipment.some((e) => EQUIPMENT[e.defId].blocksHand && !!e.host && handOfPart(u, e.host) === hand);

/** 不用拿在手上、隨時可用的武器（外掛、內建） */
export const alwaysReady = (e: EquipState): boolean => e.location === 'mount' || e.location === 'builtin';

/** 拔出不佔行動：駕駛有快速拔刀，或武器本身是快速拔出 */
export const freeDraw = (u: { pilotId: string }, e: EquipState): boolean =>
  pilotOf(u).abilities.includes('quick_draw') || !!EQUIPMENT[e.defId].tags?.includes('quickDraw');

export function heldItem(u: Gear, hand: Hand): EquipState | null {
  if (!handUsable(u, hand)) return null;
  return u.equipment.find((e) => e.location === hand && equipAlive(u, e)) ?? null;
}

export function heldOfKind(u: UnitState, kind: EquipDef['kind']): EquipState | null {
  for (const hand of ['right', 'left'] as Hand[]) {
    const item = heldItem(u, hand);
    if (item && equipDef(item).kind === kind) return item;
  }
  return null;
}

export function hasFreeHand(u: UnitState): boolean {
  return (['right', 'left'] as Hand[]).some((h) => handUsable(u, h) && !heldItem(u, h));
}

/** 現在能開火的射擊武器：手上的，加上外掛與內建的 */
export function readyRanged(u: Gear): EquipState[] {
  const held = (['right', 'left'] as Hand[]).map((h) => heldItem(u, h)).filter((e): e is EquipState => !!e);
  const fixed = u.equipment.filter((e) => alwaysReady(e) && equipAlive(u, e));
  return [...held, ...fixed].filter((e) => EQUIPMENT[e.defId].kind === 'ranged');
}

/** 能用的近戰武器：手上的優先，沒有就用外掛或內建的（薩克的肩部尖刺、古夫的熱能鞭） */
export function readyMelee(u: Gear): EquipState | null {
  for (const hand of ['right', 'left'] as Hand[]) {
    const item = heldItem(u, hand);
    if (item && equipDef(item).kind === 'melee') return item;
  }
  return u.equipment.find((e) => alwaysReady(e) && equipAlive(u, e) && EQUIPMENT[e.defId].kind === 'melee') ?? null;
}

/** 能擋的盾牌：手上拿的，加上固定在機體上的（薩克的肩盾） */
export function activeShields(u: Gear): { equip: EquipState; hand: Hand | null }[] {
  const out: { equip: EquipState; hand: Hand | null }[] = [];
  for (const hand of ['right', 'left'] as Hand[]) {
    const item = heldItem(u, hand);
    if (item && equipDef(item).kind === 'shield') out.push({ equip: item, hand });
  }
  for (const e of u.equipment) if (alwaysReady(e) && equipAlive(u, e) && EQUIPMENT[e.defId].kind === 'shield') out.push({ equip: e, hand: null });
  return out;
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
  /** 不適合目前環境：機動盤最高速度減掉這麼多 */
  speedCut?: number;
  parts: Record<string, PartState>;
  /** 目前的動能（沿朝向，後退為負） */
  momentum: number;
  propellant?: number;
  blackout?: boolean;
}

export interface ManeuverCost {
  /** 這回合的速度變化量（含急停反轉的煞車） */
  dv: number;
  propellant: number;
  stress: number;
  /** 不能用的原因；可以用則為 null */
  blocked: string | null;
}

/** 推進背包破壞時：最大加減速只剩 1，而且不能用推進劑 */
function thrustLimits(u: ManeuverLimits) {
  const ch = CHASSIS[u.chassisId];
  if (roleLost(u, 'propulsion')) return { base: PACK_BROKEN_ACCEL, max: PACK_BROKEN_ACCEL, canBurn: false };
  return { base: ch.baseThrust, max: ch.maxAccel, canBurn: true };
}

/** 轉向也算加速：速度越快，轉彎要的側向推力和 G 負荷越大 */
function turnCost(m: ManeuverSpec): { propellant: number; stress: number } {
  const s = m.speed;
  switch (m.kind) {
    case 'bank':
      return { propellant: (s >= 3 ? 1 : 0) + (s >= 5 ? 1 : 0), stress: 0 };
    case 'turn':
      return { propellant: 1 + (s >= 3 ? 1 : 0) + (s >= 5 ? 1 : 0), stress: (s >= 3 ? 1 : 0) + (s >= 5 ? 1 : 0) };
    case 'arc':
      return { propellant: 1, stress: 1 };
    case 'rbank':
      return { propellant: 1, stress: 0 };
    case 'kturn':
      return { propellant: 1, stress: 1 };
    case 'slide':
      return { propellant: s, stress: s - 1 };
    default:
      return { propellant: 0, stress: 0 };
  }
}

/** 推進劑付的是速度變化：超過基本推力的部分每 1 點花 1；壓力來自超過 G_FREE_DV 的加減速與高速轉向 */
export function maneuverCost(u: ManeuverLimits, m: ManeuverSpec, limiter = false): ManeuverCost {
  const lim = thrustLimits(u);
  // 急停反轉：先加減速到這個速度跑完，再煞到 0 並轉身
  const dv = m.kind === 'kturn' ? Math.abs(m.speed - u.momentum) + m.speed : Math.abs(m.endMomentum - u.momentum);
  const turn = turnCost(m);
  const propellant = Math.max(0, dv - lim.base) + turn.propellant;
  const stress = Math.max(0, dv - G_FREE_DV) + turn.stress + (limiter ? LIMITER_STRESS : 0);
  const maxDv = lim.max + (limiter ? 1 : 0);
  let blocked: string | null = null;
  const min = minSpeedOf(u);
  const slow = m.kind === 'hover' || m.kind === 'kturn' || m.kind === 'reverse' || m.kind === 'rbank' || m.kind === 'slide' || m.speed < min;
  if (min > 0 && slow) blocked = `最低速度 ${min}，不能懸停、後退、側移或慢於 ${min}`;
  else if (m.kind === 'slide' && Math.abs(u.momentum) > SLIDE_MAX_MOMENTUM) blocked = `側移只能在懸停或慢速（動能 ±${SLIDE_MAX_MOMENTUM} 以內）時使用`;
  else if (m.hard && (roleLost(u, 'legs') || u.blackout)) blocked = '腳部損壞或黑視，不能急轉、急停';
  else if (dv > maxDv) blocked = `速度變化 ${dv} 超過這台機體一回合的極限 ${maxDv}`;
  else if (propellant > 0 && !lim.canBurn) blocked = '推進背包損壞，不能耗用推進劑';
  else if (u.propellant !== undefined && propellant > u.propellant) blocked = '推進劑不足';
  return { dv, propellant, stress, blocked };
}

/** 這回合做得到的機動（依動能、最大加減速、部位損壞、黑視與剩餘推進劑） */
export function availableManeuvers(u: ManeuverLimits, limiter = false): ManeuverSpec[] {
  return dialOf(u).map(parseManeuver).filter((m) => maneuverCost(u, m, limiter).blocked === null);
}

/**
 * 這台機體實際的機動盤：機型的機動盤＋通用的側移（會停的機體才有；最大加減速 3 以上可以側移 2），
 * 不適合目前環境時拿掉最快的那幾段
 */
export function dialOf(u: Pick<ManeuverLimits, 'chassisId' | 'speedCut'>): string[] {
  const ch = CHASSIS[u.chassisId];
  const dial = [...ch.dial];
  if (!(ch.minSpeed ?? 0)) {
    dial.push('slide-L-1', 'slide-R-1');
    if (ch.maxAccel >= SLIDE2_MIN_ACCEL) dial.push('slide-L-2', 'slide-R-2');
  }
  const cut = u.speedCut ?? 0;
  if (!cut) return dial;
  const top = Math.max(...ch.dial.map((id) => parseManeuver(id).speed));
  const keep = dial.filter((id) => parseManeuver(id).speed <= top - cut);
  return keep.length ? keep : dial;
}

/** 這回合走的速度大小（近戰姿態判斷快慢用） */
export function moveSpeed(plan: Pick<MovePlan, 'maneuver'>): number {
  const m = parseManeuver(plan.maneuver);
  return m.kind === 'hover' ? 0 : m.speed;
}

export function planCost(u: ManeuverLimits, plan: Pick<MovePlan, 'maneuver' | 'limiter'>): ManeuverCost {
  return maneuverCost(u, parseManeuver(plan.maneuver), plan.limiter);
}

/** 預設機動：維持目前動能、最省推進劑的那個 */
export function cruiseManeuver(u: ManeuverLimits): string {
  const options = availableManeuvers(u).map((m) => ({ m, c: maneuverCost(u, m) }));
  options.sort((a, b) => a.c.propellant - b.c.propellant || a.c.dv - b.c.dv || Number(b.m.kind === 'straight') - Number(a.m.kind === 'straight'));
  if (options[0]) return options[0].m.id;
  // 什麼都做不到時：會停的懸停，不能停的（戰機）沿機動盤上最接近目前動能的直線滑行
  const dial = dialOf(u).map(parseManeuver);
  if (minSpeedOf(u) === 0 || !dial.some((m) => m.kind === 'straight')) return 'hover-S-0';
  return dial.filter((m) => m.kind === 'straight').sort((a, b) => Math.abs(a.speed - u.momentum) - Math.abs(b.speed - u.momentum))[0].id;
}

export function validateMove(u: UnitState, plan: MovePlan, grappled: boolean): string[] {
  const errors: string[] = [];
  if (plan.defer) {
    if (!pilotOf(u).abilities.includes('ace_move')) errors.push(`${u.label}：駕駛沒有王牌移動能力，不能擱置`);
    else if (grappled) errors.push(`${u.label}：纏鬥中不能擱置移動`);
    return errors;
  }
  if (!grappled) {
    if (!dialOf(u).includes(plan.maneuver)) errors.push(`${u.label}：沒有機動 ${plan.maneuver}`);
    else {
      const blocked = planCost(u, plan).blocked;
      if (blocked) errors.push(`${u.label}：${blocked}`);
    }
  }
  if (!['shoot', 'melee'].includes(plan.stance)) errors.push(`${u.label}：姿態不正確`);
  else if (plan.stance === 'melee' && !closeCombatOf(u)) errors.push(`${u.label}：這台機體只能選射擊姿態`);
  if (!(FACING_OFFSETS as readonly number[]).includes(plan.facingOffset)) errors.push(`${u.label}：轉身角度不正確`);
  else if (plan.facingOffset !== 0 && !grappled && parseManeuver(plan.maneuver).kind !== 'hover') errors.push(`${u.label}：只有懸停時可以轉身`);
  return errors;
}

export function validateAction(u: UnitState, plan: ActionPlan): string[] {
  const errors: string[] = [];
  if (plan.swap) {
    const target = plan.swap.equip;
    if (target !== null && !u.equipment.some((e) => e.id === target && !alwaysReady(e))) errors.push(`${u.label}：沒有這件裝備`);
    if (handBlocked(u, plan.swap.hand)) errors.push(`${u.label}：這隻手不能握持`);
  }
  return errors;
}

export function defaultMove(u: UnitState): MovePlan {
  return { maneuver: cruiseManeuver(u), stance: 'shoot', facingOffset: 0, limiter: false, grapple: 'push' };
}

export const defaultAction = (): ActionPlan => ({ action: { type: 'none' } });
