// 電子干擾與地雷：干擾範圍內的我方機體不能被標定、也標定不了別人；地雷埋在地上，敵方地面機體經過就引爆。
import * as C from './config';
import { EQUIPMENT } from './data';
import { radiusOf } from './body';
import { dist } from './geometry';
import { wallPenetration } from './terrain';
import type { EquipState, Mine, Obstacle, PartState, PlayerId, Vec } from './types';

type Jammer = { owner: PlayerId; pos: Vec; status?: string; equipment?: EquipState[]; parts: Record<string, PartState> };

/** 這台身上還在運作的電子干擾器（機體退場或干擾器被打壞就沒有） */
export function ecmOf(u: Pick<Jammer, 'status' | 'equipment' | 'parts'>): EquipState | undefined {
  if (u.status && u.status !== 'active') return undefined;
  return (u.equipment ?? []).find((e) => EQUIPMENT[e.defId]?.utility === 'ecm' && !u.parts[e.id]?.destroyed);
}

/** u 在自己這一方的電子干擾範圍內（干擾機自己也算） */
export function jammed(units: Jammer[], u: { owner: PlayerId; pos: Vec }): boolean {
  return units.some((j) => j.owner === u.owner && dist(j.pos, u.pos) <= C.ECM_RADIUS && !!ecmOf(j));
}

/** 這裡埋得了地雷（不在大隕石、建築裡） */
export function mineSpotOk(obstacles: Obstacle[], at: Vec): boolean {
  return !obstacles.some((o) => (o.kind === 'rock' && dist(at, o) < o.r) || (o.kind === 'building' && wallPenetration(o, at, C.MINE_RADIUS) > 0));
}

/** 從 from 往 at 架的路障：高 1 層的矮牆，橫擋在這個方向上（沿地圖的 x 或 y 軸擺） */
export function barricadeWall(from: Vec, at: Vec, id: string): Obstacle & { hx: number; hy: number } {
  const alongX = Math.abs(at.y - from.y) >= Math.abs(at.x - from.x);
  const hx = alongX ? C.BARRICADE_HALF_LENGTH : C.BARRICADE_HALF_THICK;
  const hy = alongX ? C.BARRICADE_HALF_THICK : C.BARRICADE_HALF_LENGTH;
  return { id, kind: 'building', x: at.x, y: at.y, r: Math.hypot(hx, hy), hx, hy, levels: 1 };
}

/** 路障放得下：不壓到機體、大隕石或別的建築 */
export function barricadeSpotOk(obstacles: Obstacle[], units: { pos: Vec; chassisId: string; status: string }[], wall: Obstacle & { hx: number; hy: number }): string | null {
  if (units.some((x) => x.status === 'active' && wallPenetration(wall, x.pos, radiusOf(x)) > 0)) return '那裡有機體，架不了路障';
  const blocked = obstacles.some((o) => {
    if (o.kind === 'rock') return wallPenetration(wall, o, o.r) > 0;
    if (o.kind !== 'building') return false;
    // 方形建築：兩個長方形有重疊；圓形的照外接圓
    if (o.hx !== undefined && o.hy !== undefined) return Math.abs(o.x - wall.x) < o.hx + wall.hx && Math.abs(o.y - wall.y) < o.hy + wall.hy;
    return wallPenetration(wall, o, o.r) > 0;
  });
  return blocked ? '那裡架不了路障' : null;
}

/** viewer 這一方知道的地雷：自己埋的，加上自己機體附近（MINE_DETECT_RANGE 以內）的敵方地雷 */
export function knownMines(mines: Mine[], eyes: { owner: PlayerId; pos: Vec; status: string }[], viewer: PlayerId): Mine[] {
  return mines.filter((m) => m.owner === viewer || eyes.some((u) => u.owner === viewer && u.status === 'active' && dist(u.pos, m) <= C.MINE_DETECT_RANGE));
}
