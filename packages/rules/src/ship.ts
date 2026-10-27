// 戰艦：體型大、迴避低、艦體很硬，但有弱點。
// 艦橋（感測部位）被打掉：射擊命中大降、防禦彈幕失效；引擎（推進部位）被打掉：擲殉爆，成功就擊沉。
// 命中部位看射擊方位：從艦尾打容易打到引擎，貼近（近距離以內）容易打到艦橋；對艦特效、瞄準要害再加重弱點。
// 防禦彈幕：艦首、兩舷一定範圍內（艦尾沒有），有敵機進入才生效；生效時打彈幕裡的非戰艦目標命中下降（射擊線只是穿過不算），
// 彈幕裡的非戰艦單位（友軍也一樣）每回合有機會被打傷。強度跟著還能用的砲塔數量，艦橋被打掉就沒了。
import * as C from './config';
import { radiusOf, roleLost } from './body';
import { CHASSIS, EQUIPMENT } from './data';
import { angleDiff, angleOf, dist, sub } from './geometry';
import type { EquipState, PartState, PlayerId, Vec } from './types';

type ShipLike = { id: string; chassisId: string; owner: PlayerId; pos: Vec; facing: number; status: string; parts: Record<string, PartState>; equipment: EquipState[] };

export const isShip = (u: { chassisId?: string }): boolean => !!u.chassisId && CHASSIS[u.chassisId]?.crew === 'ship';

/** 戰艦的艦橋被打掉了 */
export const bridgeLost = (u: { chassisId?: string; parts: Record<string, PartState> }): boolean => isShip(u) && roleLost(u, 'sensor');

const turretAlive = (u: ShipLike, e: EquipState): boolean => {
  if (!EQUIPMENT[e.defId]?.tags?.includes('turret')) return false;
  if (u.parts[e.id]) return !u.parts[e.id].destroyed;
  return !e.host || !u.parts[e.host]?.destroyed;
};

/** 這艘戰艦的彈幕強度（打彈幕裡的目標命中下降多少）；0 表示沒有彈幕 */
export function barrageStrength(u: ShipLike): number {
  const b = CHASSIS[u.chassisId]?.barrage;
  if (!b || u.status !== 'active' || bridgeLost(u)) return 0;
  const turrets = u.equipment.filter((e) => turretAlive(u, e)).length;
  return Math.min(b.max, turrets * b.perTurret);
}

/** pos（半徑 r）在不在這艘戰艦的彈幕範圍：艦首、兩舷，艦尾 ±BARRAGE_REAR_DEG 沒有 */
export function inBarrage(ship: ShipLike, pos: Vec, r: number): boolean {
  const b = CHASSIS[ship.chassisId]?.barrage;
  if (!b) return false;
  if (dist(ship.pos, pos) - radiusOf(ship) - r > b.range) return false;
  const off = Math.abs(angleDiff(angleOf(sub(pos, ship.pos)), ship.facing));
  return off <= Math.PI - (C.BARRAGE_REAR_DEG * Math.PI) / 180;
}

/** 彈幕生效：有強度，而且有敵方的非戰艦單位在範圍內 */
export function barrageActive(units: ShipLike[], ship: ShipLike): boolean {
  if (!barrageStrength(ship)) return false;
  return units.some((u) => u.owner !== ship.owner && u.status === 'active' && !isShip(u) && inBarrage(ship, u.pos, radiusOf(u)));
}

/** 打這個目標要扣多少（目標在哪艘生效中的彈幕裡；戰艦本身不受影響） */
export function barragePenalty(units: ShipLike[], target: ShipLike): number {
  if (isShip(target)) return 0;
  let best = 0;
  for (const s of units) if (isShip(s) && inBarrage(s, target.pos, radiusOf(target)) && barrageActive(units, s)) best = Math.max(best, barrageStrength(s));
  return best;
}

/**
 * 打戰艦時各部位權重的倍率：從艦尾打引擎、貼近打艦橋、對艦特效（或瞄準要害）再加重弱點
 * from：射擊位置（不知道就不調整）；aimed：射擊方有對艦特效或瞄準要害
 */
export function shipPartMultiplier(ship: ShipLike, from: Vec | undefined, aimed: boolean): (p: PartState) => number {
  const rear = !!from && Math.abs(angleDiff(angleOf(sub(from, ship.pos)), ship.facing)) >= Math.PI - (C.SHIP_REAR_ARC_DEG * Math.PI) / 180;
  const close = !!from && dist(from, ship.pos) - radiusOf(ship) - C.BASE_RADIUS <= C.RANGE_LIMITS.r1;
  return (p) => {
    if (p.kind !== 'body' || p.destroyed) return 1;
    if (p.role === 'propulsion') return (rear ? C.SHIP_REAR_ENGINE_MULT : 1) * (aimed ? C.SHIP_WEAK_AIM_MULT : 1);
    if (p.role === 'sensor') return (close ? C.SHIP_CLOSE_BRIDGE_MULT : 1) * (aimed ? C.SHIP_WEAK_AIM_MULT : 1);
    return 1;
  };
}
