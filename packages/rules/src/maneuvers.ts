import { DEG, add, fromAngle, rotate } from './geometry';
import type { ManeuverKind, Vec } from './types';

export interface ManeuverSpec {
  id: string;
  name: string;
  kind: ManeuverKind;
  dir: -1 | 0 | 1; // -1 左、1 右
  speed: number;
  propellant: number;
  stress: number;
  /** 急轉、急停類：腿部破壞或黑視時不可用 */
  hard: boolean;
  /** 高速與突進類：推進背包破壞時不可用 */
  highSpeed: boolean;
}

const TURN_ANGLE: Partial<Record<ManeuverKind, number>> = { bank: 45 * DEG, turn: 90 * DEG, arc: 30 * DEG };
const KIND_NAMES: Record<ManeuverKind, string> = { straight: '直線', bank: '緩轉', turn: '急轉', arc: '弧線突進', kturn: '急停反轉', hover: '懸停' };

export function parseManeuver(id: string): ManeuverSpec {
  const [kindStr, dirStr, speedStr] = id.split('-');
  const kind = kindStr as ManeuverKind;
  if (!(kind in KIND_NAMES)) throw new Error(`unknown maneuver ${id}`);
  const dir = dirStr === 'L' ? -1 : dirStr === 'R' ? 1 : 0;
  const speed = Number(speedStr);
  let propellant = 0;
  let stress = 0;
  switch (kind) {
    case 'straight':
      propellant = speed >= 4 ? 1 : 0;
      stress = speed >= 5 ? 1 : 0;
      break;
    case 'bank':
      propellant = speed >= 3 ? 1 : 0;
      break;
    case 'turn':
      propellant = 1;
      stress = 1;
      break;
    case 'arc':
      propellant = 2;
      stress = speed - 2;
      break;
    case 'kturn':
      propellant = 2;
      stress = 2;
      break;
    case 'hover':
      propellant = 1;
      break;
  }
  const side = dir === -1 ? '左' : dir === 1 ? '右' : '';
  return {
    id,
    name: kind === 'hover' ? '懸停' : `${KIND_NAMES[kind]}${side}${speed}`,
    kind,
    dir,
    speed,
    propellant,
    stress,
    hard: kind === 'turn' || kind === 'kturn',
    highSpeed: kind === 'arc' || speed >= 4,
  };
}

export interface LocalPose {
  pos: Vec;
  facing: number;
  /** 移動方向（速度向量的角度） */
  tangent: number;
}

/** 機體座標系下的姿態：起點在原點、朝 +x。length 為整條路徑長度。 */
export function localPose(spec: ManeuverSpec, length: number, t: number): LocalPose {
  const phi = TURN_ANGLE[spec.kind];
  if (spec.kind === 'hover' || length <= 0) return { pos: { x: 0, y: 0 }, facing: 0, tangent: 0 };
  if (phi !== undefined) {
    const r = length / phi;
    const a = phi * t;
    return { pos: { x: r * Math.sin(a), y: spec.dir * r * (1 - Math.cos(a)) }, facing: spec.dir * a, tangent: spec.dir * a };
  }
  // straight / kturn
  const facing = spec.kind === 'kturn' && t >= 1 ? Math.PI : 0;
  return { pos: { x: length * t, y: 0 }, facing, tangent: 0 };
}

export interface PathParams {
  spec: ManeuverSpec;
  start: Vec;
  startFacing: number;
  length: number;
}

export function pathLength(spec: ManeuverSpec, limiter: boolean): number {
  if (spec.kind === 'hover') return 0;
  return spec.speed + (limiter ? 1 : 0);
}

export interface WorldPose {
  pos: Vec;
  facing: number;
  velocity: Vec;
}

export function worldPose(p: PathParams, t: number): WorldPose {
  const lp = localPose(p.spec, p.length, t);
  return {
    pos: add(p.start, rotate(lp.pos, p.startFacing)),
    facing: p.startFacing + lp.facing,
    velocity: p.length > 0 ? fromAngle(p.startFacing + lp.tangent, p.length) : { x: 0, y: 0 },
  };
}

/** 給客戶端預覽用的取樣點 */
export function samplePath(p: PathParams, steps = 20): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i <= steps; i++) out.push(worldPose(p, i / steps).pos);
  return out;
}
