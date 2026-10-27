import { CLIMB_MAX_SPEED, CLIMB_PROPELLANT, FACING_OFFSETS, G_FREE_DV, LIMITER_STRESS, PACK_BROKEN_ACCEL, SHIP_TURN_MAX_DEG, SLIDE_MAX_MOMENTUM, SLIDE2_MIN_ACCEL } from './config';
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

/** 穿著中的外裝甲（還沒被打掉、也沒拋棄） */
export function armorOf(u: { parts: Record<string, PartState>; equipment?: EquipState[] }): EquipDef | null {
  const e = u.equipment?.find((x) => EQUIPMENT[x.defId]?.kind === 'armor' && x.location === 'mount' && u.parts[x.id] && !u.parts[x.id].destroyed);
  return e ? EQUIPMENT[e.defId] : null;
}

/** 外裝甲鎖住武器時：只有裝在頭部（感測部位）的武器能用 */
const weaponsLocked = (u: Gear): boolean => !!armorOf(u)?.lockWeapons;
const onHead = (u: Gear, e: EquipState): boolean => !!e.host && u.parts[e.host]?.role === 'sensor';

/** 這隻手還在而且能握持（沒有手的機型永遠不行；外裝甲鎖住武器時也不行） */
export function handUsable(u: Gear, hand: Hand): boolean {
  const p = handPart(u, hand);
  return !!p && partAlive(u, p) && !handBlocked(u, hand) && !weaponsLocked(u) && !armOut(u, hand);
}

/** 這隻手（有線臂）放出去了 */
export const armOut = (u: Gear, hand: Hand): boolean => u.equipment.some((e) => !!e.pod && !!EQUIPMENT[e.defId].psycommu?.wired && !!e.host && handOfPart(u, e.host) === hand);

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

/** 收著的武器放在哪一側的武器架（宿主是哪隻手臂）；null 表示放在中間（背上），哪隻手都拿得到 */
export function rackSide(u: Gear, e: EquipState): Hand | null {
  return e.host ? handOfPart(u, e.host) : null;
}

/** 這回合的換武器：每一側換成什麼（null 收起來）；相容舊格式 swap */
export function swapOrders(plan: Pick<ActionPlan, 'swap' | 'swaps'>): [Hand, string | null][] {
  const out: Partial<Record<Hand, string | null>> = { ...(plan.swap ? { [plan.swap.hand]: plan.swap.equip } : {}), ...plan.swaps };
  return (['right', 'left'] as Hand[]).filter((h) => h in out).map((h) => [h, out[h] ?? null]);
}

/** 換武器那一側的手這回合不能開火（拔出不佔行動的武器除外，見 freeDraw） */
export function busyHands(u: Gear & { pilotId: string }, plan: Pick<ActionPlan, 'swap' | 'swaps'>): Set<Hand> {
  const busy = new Set<Hand>();
  for (const [hand, id] of swapOrders(plan)) {
    const e = id ? u.equipment.find((x) => x.id === id) : null;
    if (!e || !freeDraw(u, e)) busy.add(hand);
  }
  return busy;
}

/** 射擊動作用到的所有武器（主武器加上一起開火的） */
export const shotWeapons = (a: { weapon: string; also?: string[] }): string[] => [...new Set([a.weapon, ...(a.also ?? [])])];

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
  const fixed = u.equipment.filter((e) => alwaysReady(e) && equipAlive(u, e) && (!weaponsLocked(u) || onHead(u, e)));
  // 放出去的炮群只能用指揮的方式開火
  return [...held, ...fixed].filter((e) => EQUIPMENT[e.defId].kind === 'ranged' && !e.pod);
}

/** 能用的近戰武器：手上的優先，沒有就用外掛或內建的（薩克的肩部尖刺、古夫的熱能鞭） */
export function readyMelee(u: Gear): EquipState | null {
  for (const hand of ['right', 'left'] as Hand[]) {
    const item = heldItem(u, hand);
    if (item && equipDef(item).kind === 'melee') return item;
  }
  return u.equipment.find((e) => alwaysReady(e) && equipAlive(u, e) && EQUIPMENT[e.defId].kind === 'melee' && (!weaponsLocked(u) || onHead(u, e))) ?? null;
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
  /** 外裝甲會降低最大加減速 */
  equipment?: EquipState[];
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
  const armor = armorOf(u);
  return { base: ch.baseThrust, max: Math.max(1, ch.maxAccel - (armor?.accelPenalty ?? 0)), canBurn: true };
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
  // 側移：會停的機體才有（戰艦沒有）
  if (!(ch.minSpeed ?? 0) && ch.crew !== 'ship') {
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
  if (plan.purge && !armorOf(u)) errors.push(`${u.label}：沒有可以拋棄的外裝甲`);
  if (plan.climb) {
    const why = climbBlocked(u, plan);
    if (why) errors.push(`${u.label}：${why}`);
  }
  for (const id of Object.keys(plan.pods ?? {})) {
    const e = u.equipment.find((x) => x.id === id);
    if (!e || !EQUIPMENT[e.defId].psycommu) errors.push(`${u.label}：沒有這個感應武器`);
    else if (!pilotOf(u).abilities.some((x) => x === 'newtype' || x === 'cyber_newtype')) errors.push(`${u.label}：駕駛不是新人類或強化人，不能用感應武器`);
  }
  if (!['shoot', 'melee'].includes(plan.stance)) errors.push(`${u.label}：姿態不正確`);
  else if (plan.stance === 'melee' && !closeCombatOf(u)) errors.push(`${u.label}：這台機體只能選射擊姿態`);
  if (!(FACING_OFFSETS as readonly number[]).includes(plan.facingOffset)) errors.push(`${u.label}：轉身角度不正確`);
  else if (CHASSIS[u.chassisId]?.crew === 'ship' && Math.abs(plan.facingOffset) > SHIP_TURN_MAX_DEG) errors.push(`${u.label}：戰艦原地轉身最多 ${SHIP_TURN_MAX_DEG}°`);
  else if (plan.facingOffset !== 0 && !grappled && parseManeuver(plan.maneuver).kind !== 'hover') errors.push(`${u.label}：只有懸停時可以轉身`);
  return errors;
}

export function validateAction(u: UnitState, plan: ActionPlan): string[] {
  const errors: string[] = [];
  const a = plan.action;
  if (plan.salvo && Object.keys(plan.salvo).length) {
    if (CHASSIS[u.chassisId]?.crew !== 'ship') errors.push(`${u.label}：只有戰艦能齊射`);
    else for (const id of Object.keys(plan.salvo)) if (!u.equipment.some((e) => e.id === id && EQUIPMENT[e.defId].tags?.includes('turret'))) errors.push(`${u.label}：沒有這座砲塔`);
  }
  for (const [id, targets] of Object.entries(plan.pods ?? {})) {
    const e = u.equipment.find((x) => x.id === id);
    const ps = e && EQUIPMENT[e.defId].psycommu;
    if (!ps) errors.push(`${u.label}：沒有這個炮群`);
    else if (!Array.isArray(targets) || targets.length > 2) errors.push(`${u.label}：炮群最多分給兩個目標`);
    else if (!ps.wired && targets.length && a.type !== 'none') errors.push(`${u.label}：指揮無線炮群會用掉這回合的動作`);
  }
  if ((a.type === 'smoke' || a.type === 'decoy') && !u.equipment.some((e) => e.id === a.weapon && EQUIPMENT[e.defId].utility === a.type)) errors.push(`${u.label}：沒有這個道具`);
  for (const [hand, target] of swapOrders(plan)) {
    const e = target === null ? null : u.equipment.find((x) => x.id === target && !alwaysReady(x));
    if (target !== null && !e) errors.push(`${u.label}：沒有這件裝備`);
    else if (e && e.location !== 'right' && e.location !== 'left' && rackSide(u, e) && rackSide(u, e) !== hand) errors.push(`${u.label}：${EQUIPMENT[e.defId].name}在另一側的武器架上，要用${rackSide(u, e) === 'right' ? '右' : '左'}手拿`);
    if (handBlocked(u, hand)) errors.push(`${u.label}：這隻手不能握持`);
  }
  if (a.type === 'shoot') for (const id of shotWeapons(a)) if (!u.equipment.some((e) => e.id === id)) errors.push(`${u.label}：沒有這件武器`);
  return errors;
}

/** 不能攀升的原因（可以就是 null）：速度太快、腳壞了、推進劑不夠，戰艦與不能停的機體不能爬 */
export function climbBlocked(u: UnitState | ManeuverLimits, plan: Pick<MovePlan, 'maneuver'>): string | null {
  const ch = CHASSIS[u.chassisId];
  if (ch.crew === 'ship' || (ch.minSpeed ?? 0) > 0) return '這台機體不能攀升';
  if (moveSpeed(plan) > CLIMB_MAX_SPEED) return `速度 ${CLIMB_MAX_SPEED} 以下才能攀升（太快蹬不了牆）`;
  if (roleLost(u, 'legs')) return '腳部損壞，不能攀升';
  if ((u.propellant ?? 0) < CLIMB_PROPELLANT) return '推進劑不足，不能攀升';
  return null;
}

export function defaultMove(u: UnitState): MovePlan {
  return { maneuver: cruiseManeuver(u), stance: 'shoot', facingOffset: 0, limiter: false };
}

export const defaultAction = (): ActionPlan => ({ action: { type: 'none' } });
