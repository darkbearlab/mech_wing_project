// 垂直噴射器：移動步驟不選機動盤，先沿朝向滑完既有動能，再跳到 1 格內的任一點、面向任選。
// 宇宙裡是急轉向（動能保留、方向改成新的面向）；重力圈裡是跳躍噴射背包（推進劑三倍、落地動能歸零、這回合射擊命中下降），可以跳上 2 層以內的樓頂。
import * as C from './config';
import { radiusOf, roleLost } from './body';
import { CHASSIS, EQUIPMENT } from './data';
import { DEG, dist } from './geometry';
import { worldPose } from './maneuvers';
import { buildPath } from './movement';
import { supportAt, wallPenetration } from './terrain';
import { equipAlive, wholeDegrees } from './unit';
import type { EquipState, GameEvent, MovePlan, Obstacle, PartState, UnitState, Vec } from './types';

type Gear = { parts: Record<string, PartState>; equipment: EquipState[] };
type Jumper = Gear & { pos: Vec; facing: number; momentum: number; chassisId: string; z?: number; propellant?: number };

/** 這台身上還能用的垂直噴射器 */
export function jumpJetOf(u: Gear): EquipState | undefined {
  return u.equipment.find((e) => EQUIPMENT[e.defId]?.jumpJet && equipAlive(u, e));
}

/** 跳一次的推進劑：宇宙 JUMP_PROPELLANT（重型機 JUMP_PROPELLANT_HEAVY），重力圈、水中再 ×JUMP_GRAVITY_MULT */
export function jumpCost(u: { chassisId: string }, environment: string | undefined): number {
  const heavy = (CHASSIS[u.chassisId]?.weightClass ?? 2) >= C.JUMP_HEAVY_CLASS;
  const base = heavy ? C.JUMP_PROPELLANT_HEAVY : C.JUMP_PROPELLANT;
  return (environment ?? 'space') === 'space' ? base : base * C.JUMP_GRAVITY_MULT;
}

/** 滑完既有動能用的機動（沿朝向直線滑行，動能是負的就後退） */
export function coastManeuver(u: { momentum: number }): string {
  const m = Math.round(u.momentum);
  return m > 0 ? `straight-S-${m}` : m < 0 ? `reverse-S-${-m}` : 'hover-S-0';
}

/** 滑完動能後的位置 */
export function coastEnd(u: { pos: Vec; facing: number; momentum: number }): Vec {
  return worldPose(buildPath(u, { maneuver: coastManeuver(u), limiter: false }), 1).pos;
}

/** 落點：在大隕石裡、或是比腳下高超過 JUMP_LEVELS 層的建築裡就落不了；回傳落地後的高度 */
export function landingHeight(obstacles: Obstacle[], u: { chassisId: string; z?: number }, at: Vec): number | null {
  const r = radiusOf(u);
  if (obstacles.some((o) => o.kind === 'rock' && dist(at, o) < o.r + r)) return null;
  const z = supportAt(obstacles, at);
  // 底板碰到但中心不在上面的建築：比落地高度高的就是撞牆
  if (obstacles.some((o) => o.kind === 'building' && o.levels! > z && wallPenetration(o, at, r) > 1e-6)) return null;
  if (z - (u.z ?? 0) > C.JUMP_LEVELS) return null;
  return z;
}

/** 不能這樣跳的原因（可以就是 null） */
/** from：起跳點（沒給就是滑完動能後的位置；結算時機體已經滑完，就給現在的位置） */
export function jumpBlocked(u: Jumper, plan: Pick<MovePlan, 'jump'>, world?: { obstacles: Obstacle[]; environment?: string }, from: Vec = coastEnd(u)): string | null {
  const j = plan.jump;
  if (!j) return null;
  if (!jumpJetOf(u)) return '沒有能用的垂直噴射器';
  if (roleLost(u, 'propulsion')) return '推進背包損壞，不能噴射';
  const env = world?.environment ?? 'space';
  if (env !== 'space' && roleLost(u, 'legs')) return '重力圈裡腳部損壞，不能起跳';
  if ((CHASSIS[u.chassisId]?.minSpeed ?? 0) > 0 || CHASSIS[u.chassisId]?.crew === 'ship') return '這台機體不能用垂直噴射器';
  if (!wholeDegrees(j.facing)) return '噴射後的面向要是整數度';
  const cost = jumpCost(u, env);
  if ((u.propellant ?? 0) < cost) return `推進劑不足（要 ${cost}）`;
  if (!j.to || !Number.isFinite(j.to.x) || !Number.isFinite(j.to.y)) return '落點不正確';
  // 顯示的座標只到小數一位：多給 0.1 格的寬容，照畫面上的數字算剛好 1 格也落得下去
  if (dist(from, j.to) > C.JUMP_RANGE + 0.1) return `落點要在滑完動能後的位置 ${C.JUMP_RANGE} 格以內`;
  if (world && landingHeight(world.obstacles, u, j.to) === null) return `那裡落不下去（大隕石、太高的建築；最多跳上 ${C.JUMP_LEVELS} 層）`;
  return null;
}

interface JumpCtx {
  state: { units: UnitState[]; obstacles: Obstacle[]; settings?: { environment?: string } };
  events: GameEvent[];
}

/**
 * 滑行結束後起跳落地：照指令的落點與面向，宇宙保留動能（改成新面向的方向）、重力圈歸零。
 * 滑行中被擋停或擦撞的就不跳。落點和別的機體重疊就往起跳點退回去。回傳成功跳了的機體
 */
export function applyJumps(ctx: JumpCtx, plans: Record<string, MovePlan>, ids: Iterable<string>, halted: Set<string>, pay: (u: UnitState, propellant: number, stress: number) => void): Set<string> {
  const env = ctx.state.settings?.environment ?? 'space';
  const done = new Set<string>();
  for (const id of ids) {
    const plan = plans[id];
    const u = ctx.state.units.find((x) => x.id === id);
    if (!plan?.jump || !u || u.status !== 'active') continue;
    const fail = (reason: string) => ctx.events.push({ type: 'actionFail', unit: id, reason });
    if (halted.has(id)) {
      fail('滑行中被擋下，沒有起跳');
      continue;
    }
    const why = jumpBlocked(u, plan, { obstacles: ctx.state.obstacles, environment: env }, u.pos);
    // 地形在這一步變了（樓塌、路障）：落不下去就停在原地
    if (why) {
      fail(why);
      continue;
    }
    const start = { ...u.pos };
    let at = { ...plan.jump.to };
    const blocked = (p: Vec, z: number) => ctx.state.units.some((o) => o.id !== id && o.status === 'active' && (o.z ?? 0) === z && dist(o.pos, p) < radiusOf(o) + radiusOf(u));
    let z = landingHeight(ctx.state.obstacles, u, at)!;
    for (let k = 1; k <= 10 && blocked(at, z); k++) {
      at = { x: plan.jump.to.x + (start.x - plan.jump.to.x) * (k / 10), y: plan.jump.to.y + (start.y - plan.jump.to.y) * (k / 10) };
      z = landingHeight(ctx.state.obstacles, u, at) ?? (u.z ?? 0);
    }
    const prevZ = u.z ?? 0;
    u.pos = at;
    u.facing = plan.jump.facing * DEG;
    u.z = z || undefined;
    if (env !== 'space') u.momentum = 0;
    pay(u, jumpCost(u, env), env === 'space' ? C.JUMP_STRESS_SPACE : C.JUMP_STRESS_GRAVITY);
    // 移動的演出：在滑行的軌跡後面接上落點
    const move = [...ctx.events].reverse().find((e): e is Extract<GameEvent, { type: 'move' }> => e.type === 'move' && e.unit === id);
    if (move) move.samples.push([Math.round(at.x * 100) / 100, Math.round(at.y * 100) / 100, Math.round(u.facing * 100) / 100]);
    ctx.events.push({ type: 'jump', unit: id, from: start, to: { ...at }, facing: plan.jump.facing });
    if (z !== prevZ) ctx.events.push({ type: 'elevate', t: 1, unit: id, z, how: z > prevZ ? 'jump' : 'drop' });
    done.add(id);
  }
  return done;
}
