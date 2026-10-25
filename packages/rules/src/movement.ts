import * as C from './config';
import { strike } from './combat';
import { addStress, damageUnit, type Ctx } from './damage';
import { DEG, add, dist, dot, normalize, scale, sub } from './geometry';
import { parseManeuver, pathLength, worldPose, type PathParams } from './maneuvers';
import type { ContactResult, MovePlan, Stance, UnitState, Vec } from './types';
import { chassisOf, heldOfKind, pilotOf } from './unit';

interface Mover {
  unit: UnitState;
  path: PathParams | null; // null = 本回合不動（纏鬥中）
  plan: MovePlan | null;
  moving: boolean;
  /** 被撞開時朝向已隨機改變，懸停轉身中斷 */
  knocked: boolean;
  samples: [number, number, number][];
}

export interface MoveResult {
  bumped: Set<string>;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function buildPath(u: { pos: Vec; facing: number }, plan: Pick<MovePlan, 'maneuver' | 'limiter'>): PathParams {
  const spec = parseManeuver(plan.maneuver);
  return { spec, start: { ...u.pos }, startFacing: u.facing, length: pathLength(spec, plan.limiter) };
}

export function contactRadius(stance: Stance | undefined): number {
  return C.BASE_RADIUS - (stance === 'evade' ? C.EVADE_RADIUS_REDUCTION : 0);
}

/**
 * 同時移動：所有機體在 [0,1] 時間內沿各自路徑前進，逐時間步檢查新的接觸。
 * 只有「新出現」的接觸會觸發結果；回合開始就已接觸（例如纏鬥）的配對不重複觸發。
 */
export function simulateMovement(
  ctx: Ctx,
  plans: Record<string, MovePlan>,
  stance: Record<string, Stance>,
  frozen: Set<string>,
): MoveResult {
  const bumped = new Set<string>();
  const units = ctx.state.units.filter((u) => u.status === 'active');
  const movers: Mover[] = units.map((u) => {
    const plan = plans[u.id] ?? null;
    const path = plan && !frozen.has(u.id) ? buildPath(u, plan) : null;
    return { unit: u, path, plan, moving: !!path && path.length > 0, knocked: false, samples: [[u.pos.x, u.pos.y, u.facing]] };
  });

  const ignore = new Set<string>(ctx.state.grapples.map((g) => pairKey(g.a, g.b)));
  const touching = new Set<string>();
  const radius = (m: Mover) => contactRadius(stance[m.unit.id]);
  for (let i = 0; i < movers.length; i++)
    for (let j = i + 1; j < movers.length; j++)
      if (dist(movers[i].unit.pos, movers[j].unit.pos) < radius(movers[i]) + radius(movers[j]) + 1e-6) touching.add(pairKey(movers[i].unit.id, movers[j].unit.id));

  const velocity = (m: Mover, t: number): Vec => (m.moving && m.path ? worldPose(m.path, t).velocity : { x: 0, y: 0 });
  const stop = (m: Mover) => {
    m.moving = false;
  };

  for (let k = 1; k <= C.MOVE_STEPS; k++) {
    const t = k / C.MOVE_STEPS;
    const prev = new Map(movers.map((m) => [m.unit.id, { ...m.unit.pos }]));
    for (const m of movers) {
      if (!m.path) continue;
      if (m.moving) {
        const p = worldPose(m.path, t);
        m.unit.pos = p.pos;
        m.unit.facing = p.facing;
      } else if (m.path.length === 0 && m.plan?.facingOffset && !m.knocked && m.unit.status === 'active') {
        // 懸停時原地轉身，在整段時間內慢慢轉過去
        m.unit.facing = m.path.startFacing + m.plan.facingOffset * DEG * t;
      }
    }

    const live = movers.filter((m) => m.unit.status === 'active');
    const contacts: { a: Mover; b: Mover; d: number }[] = [];
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        const key = pairKey(a.unit.id, b.unit.id);
        const d = dist(a.unit.pos, b.unit.pos);
        const rr = radius(a) + radius(b);
        if (d >= rr) {
          touching.delete(key);
          continue;
        }
        if (touching.has(key) || ignore.has(key)) continue;
        contacts.push({ a, b, d });
      }
    }
    contacts.sort((x, y) => x.d - y.d);

    for (const { a, b } of contacts) {
      const key = pairKey(a.unit.id, b.unit.id);
      touching.add(key);
      if (a.unit.status !== 'active' || b.unit.status !== 'active') continue;
      const va = velocity(a, t);
      const vb = velocity(b, t);
      const result = resolveContact(ctx, a, b, va, vb, t, prev, stance, bumped);
      if (result !== 'none') ignore.add(key);
    }

    for (const m of movers) m.samples.push([m.unit.pos.x, m.unit.pos.y, m.unit.facing]);
  }

  separateOverlaps(ctx, movers);
  for (const m of movers) {
    const last = m.samples[m.samples.length - 1];
    last[0] = m.unit.pos.x;
    last[1] = m.unit.pos.y;
    ctx.events.push({ type: 'move', unit: m.unit.id, samples: m.samples.map(([x, y, f]) => [round(x), round(y), round(f)]) });
  }
  return { bumped };

  function resolveContact(
    ctx: Ctx,
    a: Mover,
    b: Mover,
    va: Vec,
    vb: Vec,
    t: number,
    prev: Map<string, Vec>,
    stance: Record<string, Stance>,
    bumped: Set<string>,
  ): ContactResult {
    const u = normalize(sub(b.unit.pos, a.unit.pos));
    const vcRaw = dot(sub(va, vb), u);
    const emit = (vc: number, result: ContactResult) => ctx.events.push({ type: 'contact', t, a: a.unit.id, b: b.unit.id, vc, result });
    if (vcRaw <= 0) {
      emit(0, 'none');
      return 'none';
    }
    const vc = Math.round(vcRaw);
    const attackers = [a, b].filter((m) => stance[m.unit.id] === 'charge');
    const halt = (...ms: Mover[]) => {
      for (const m of ms) {
        if (m.moving) m.unit.pos = prev.get(m.unit.id)!;
        stop(m);
      }
    };

    let result: ContactResult;
    if (attackers.length === 0) {
      result = vc >= C.RAM_MIN_VC ? 'ram' : 'bump';
    } else {
      const bands = attackers.map((m) => {
        const hitRunMax = C.HIT_RUN_MAX_VC + (pilotOf(m.unit).skill >= C.ACE_SKILL ? 1 : 0);
        let band = vc <= C.CLINCH_MAX_VC ? 0 : vc <= hitRunMax ? 1 : 2;
        if (m.plan?.soften && band > 0) {
          band--;
          addStress(ctx, m.unit, C.SOFTEN_STRESS, '收刀');
        }
        return band;
      });
      const band = Math.min(...bands);
      result = band === 0 ? 'clinch' : band === 1 ? 'hitrun' : 'ram';
      if (result === 'hitrun' && !attackers.some((m) => heldOfKind(m.unit, 'melee'))) result = vc >= C.RAM_MIN_VC ? 'ram' : 'bump';
    }
    emit(vc, result);

    switch (result) {
      case 'bump':
        halt(a, b);
        bumped.add(a.unit.id);
        bumped.add(b.unit.id);
        break;
      case 'clinch':
        halt(a, b);
        ctx.state.grapples.push({ a: a.unit.id, b: b.unit.id, advantage: null });
        break;
      case 'hitrun':
        for (const m of attackers) {
          const other = m === a ? b : a;
          if (heldOfKind(m.unit, 'melee')) strike(ctx, m.unit, other.unit, t);
        }
        break;
      case 'ram':
        halt(a, b);
        ram(ctx, a, b, vc);
        break;
    }
    return result;
  }

  function ram(ctx: Ctx, a: Mover, b: Mover, vc: number) {
    const wa = chassisOf(a.unit).weightClass;
    const wb = chassisOf(b.unit).weightClass;
    damageUnit(ctx, a.unit, Math.max(1, vc + wb - wa), 'scattered');
    damageUnit(ctx, b.unit, Math.max(1, vc + wa - wb), 'scattered');
    addStress(ctx, a.unit, vc + Math.max(0, wb - wa), '撞擊');
    addStress(ctx, b.unit, vc + Math.max(0, wa - wb), '撞擊');
    if (wa === wb) return;
    const [heavy, light] = wa > wb ? [a, b] : [b, a];
    const dir = normalize(sub(light.unit.pos, heavy.unit.pos));
    light.unit.pos = add(light.unit.pos, scale(dir, Math.abs(wa - wb) + 1));
    light.unit.facing += ctx.rng.range(-45, 45) * DEG;
    light.knocked = true;
    ctx.events.push({ type: 'knockback', unit: light.unit.id, to: { ...light.unit.pos }, facing: light.unit.facing });
  }
}

/** 移動結束後，把仍重疊的機體沿圓心連線推開（纏鬥中的配對除外） */
function separateOverlaps(ctx: Ctx, movers: Mover[]) {
  const grappled = new Set(ctx.state.grapples.map((g) => pairKey(g.a, g.b)));
  for (let iter = 0; iter < 8; iter++) {
    let moved = false;
    for (let i = 0; i < movers.length; i++) {
      for (let j = i + 1; j < movers.length; j++) {
        const a = movers[i].unit;
        const b = movers[j].unit;
        if (a.status !== 'active' && a.status !== 'unconscious') continue;
        if (b.status !== 'active' && b.status !== 'unconscious') continue;
        if (grappled.has(pairKey(a.id, b.id))) continue;
        const d = dist(a.pos, b.pos);
        const need = 2 * C.BASE_RADIUS;
        if (d >= need - 1e-6) continue;
        const dir = d < 1e-6 ? { x: 1, y: 0 } : normalize(sub(b.pos, a.pos));
        const push = (need - d) / 2 + 1e-4;
        a.pos = sub(a.pos, scale(dir, push));
        b.pos = add(b.pos, scale(dir, push));
        moved = true;
      }
    }
    if (!moved) break;
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
