import { isShip } from './ship';
import { clinchAdvantage } from './grapple';
import { radiusOf } from './body';
import * as C from './config';
import { meleeClash } from './melee';
import { addStress, damageUnit, typed, dealtBy, spendPropellant, type Ctx } from './damage';
import { pushOutOfWall, wallPenetration } from './terrain';
import { CHASSIS } from './data';
import { DEG, add, angleDiff, angleOf, dist, dot, normalize, scale, sub } from './geometry';
import { parseManeuver, pathLength, worldPose, type PathParams } from './maneuvers';
import type { ContactResult, GameState, MovePlan, Obstacle, Stance, UnitState, Vec } from './types';
import { chassisOf, climbLimits, moveSpeed, pilotOf, readyMelee } from './unit';

interface Mover {
  unit: UnitState;
  path: PathParams | null; // null = 本回合不動（纏鬥中）
  plan: MovePlan | null;
  moving: boolean;
  /** 被撞開時朝向已隨機改變，懸停轉身中斷 */
  knocked: boolean;
  /** 中途被擋停（擦撞、咬住、撞擊） */
  halted: boolean;
  samples: [number, number, number][];
}

export interface MoveResult {
  bumped: Set<string>;
  velocity: Record<string, Vec>;
  /** 中途被擋停或撞開的機體：動能歸零 */
  stopped: Set<string>;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** 不能停的機體（戰機）在有建築的地圖上一直在飛，不會落下 */
const flying = (u: { chassisId: string }) => (CHASSIS[u.chassisId]?.minSpeed ?? 0) > 0;

/** 兩台機體在不同高度（一台在樓頂、一台在街上）就不會接觸 */
const sameLevel = (a: UnitState, b: UnitState) => Math.abs((a.z ?? 0) - (b.z ?? 0)) < 1;

/** 底板碰到的建築裡，不比 z 高的最高那棟（站得上去的樓頂）；都沒有就是地面 0 */
function footing(obstacles: Obstacle[], p: Vec, r: number, z: number): number {
  let best = 0;
  for (const o of obstacles) if (o.kind === 'building' && o.levels! <= z && wallPenetration(o, p, r) > 0) best = Math.max(best, o.levels!);
  return best;
}

/** 落到腳下的高度：離開樓頂邊緣（底板完全離開）就掉到下面的樓頂或地面 */
export function settleHeights(state: GameState, events?: Ctx['events'], t = 1): void {
  for (const u of state.units) {
    if (u.status !== 'active' && u.status !== 'unconscious') continue;
    // 被擊退、摔進比自己站的地方高的建築：推到牆外
    for (const o of state.obstacles)
      if (o.kind === 'building' && o.levels! > (u.z ?? 0) && wallPenetration(o, u.pos, radiusOf(u)) > 1e-6) u.pos = pushOutOfWall(o, u.pos, radiusOf(u));
    // 飛行中的戰機不會落下
    if (!u.z || flying(u)) continue;
    const z = footing(state.obstacles, u.pos, radiusOf(u), u.z);
    if (z >= u.z) continue;
    u.z = z || undefined;
    events?.push({ type: 'elevate', t, unit: u.id, z, how: 'drop' });
  }
}

export function buildPath(u: { pos: Vec; facing: number }, plan: Pick<MovePlan, 'maneuver' | 'limiter'>): PathParams {
  const spec = parseManeuver(plan.maneuver);
  return { spec, start: { ...u.pos }, startFacing: u.facing, length: pathLength(spec) };
}

export function contactRadius(u: { chassisId?: string }): number {
  return radiusOf(u);
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
    return { unit: u, path, plan, moving: !!path && path.length > 0, knocked: false, halted: false, samples: [[u.pos.x, u.pos.y, u.facing]] };
  });

  const ignore = new Set<string>(ctx.state.grapples.map((g) => pairKey(g.a, g.b)));
  const touching = new Set<string>();
  const radius = (m: Mover) => contactRadius(m.unit);
  for (let i = 0; i < movers.length; i++)
    for (let j = i + 1; j < movers.length; j++)
      if (sameLevel(movers[i].unit, movers[j].unit) && dist(movers[i].unit.pos, movers[j].unit.pos) < radius(movers[i]) + radius(movers[j]) + 1e-6) touching.add(pairKey(movers[i].unit.id, movers[j].unit.id));

  const velocity = (m: Mover, t: number): Vec => (m.moving && m.path ? worldPose(m.path, t).velocity : { x: 0, y: 0 });
  const stop = (m: Mover) => {
    m.moving = false;
    m.halted = true;
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

    // 撞上大隕石：停在前一步的位置，速度超過安全值的部分化為傷害與壓力
    for (const m of movers) {
      if (!m.moving || !m.path || m.unit.status !== 'active') continue;
      const rock = ctx.state.obstacles.find((o) => o.kind === 'rock' && dist(m.unit.pos, o) < radiusOf(m.unit) + o.r);
      if (!rock) continue;
      m.unit.pos = prev.get(m.unit.id)!;
      stop(m);
      bumped.add(m.unit.id);
      const damage = Math.max(0, Math.round(m.path.length) - C.ROCK_SAFE_SPEED);
      ctx.events.push({ type: 'obstacle', t, unit: m.unit.id, obstacle: rock.id, damage: damage * C.DAMAGE_SCALE });
      // 彈開一點，機頭偏向隕石表面（擦過去的方向），下回合才轉得出來；不能停的戰機尤其需要
      const away = sub(m.unit.pos, rock);
      const n = Math.hypot(away.x, away.y) < 1e-6 ? { x: Math.cos(m.unit.facing + Math.PI), y: Math.sin(m.unit.facing + Math.PI) } : normalize(away);
      const clear = rock.r + radiusOf(m.unit) + C.ROCK_BOUNCE_GAP;
      if (dist(m.unit.pos, rock) < clear) m.unit.pos = add(rock, scale(n, clear));
      const normal = angleOf(n);
      const tangents = [normal + Math.PI / 2, normal - Math.PI / 2];
      m.unit.facing = Math.abs(angleDiff(tangents[0], m.unit.facing)) <= Math.abs(angleDiff(tangents[1], m.unit.facing)) ? tangents[0] : tangents[1];
      ctx.events.push({ type: 'reposition', unit: m.unit.id, to: { ...m.unit.pos } });
      if (damage) {
        damageUnit(ctx, m.unit, damage * C.DAMAGE_SCALE, 'scattered');
        addStress(ctx, m.unit, damage, '撞上隕石');
      }
    }

    // 建築：撞上比自己站的地方高的牆就停下（速度超過安全值的部分化為傷害），攀升中的機體爬得上去就上樓頂；
    // 底板完全離開樓頂邊緣就掉下去（不受速度限制）
    for (const m of movers) {
      if (!m.moving || !m.path || m.unit.status !== 'active') continue;
      const u = m.unit;
      const r = radiusOf(u);
      const before = prev.get(u.id)!;
      for (const o of ctx.state.obstacles) {
        if (o.kind !== 'building' || o.levels! <= (u.z ?? 0)) continue;
        const pen = wallPenetration(o, u.pos, r);
        if (pen <= 0 || pen <= wallPenetration(o, before, r) + 1e-6) continue;
        const z = u.z ?? 0;
        if (m.plan?.climb && o.levels! - z <= climbLimits(u).levels && u.propellant >= C.CLIMB_PROPELLANT) {
          u.z = o.levels;
          spendPropellant(ctx, u, C.CLIMB_PROPELLANT);
          ctx.events.push({ type: 'elevate', t, unit: u.id, z: o.levels!, how: 'climb' });
          continue;
        }
        u.pos = before;
        stop(m);
        bumped.add(u.id);
        const damage = Math.max(0, Math.round(m.path.length) - C.ROCK_SAFE_SPEED);
        ctx.events.push({ type: 'obstacle', t, unit: u.id, obstacle: o.id, damage: damage * C.DAMAGE_SCALE });
        // 彈開一點，機頭轉成沿著牆面（比較接近原本朝向的那一邊），下回合才走得開，不會一直貼著牆卡住
        const out = pushOutOfWall(o, u.pos, r + C.ROCK_BOUNCE_GAP);
        const cx = Math.max(o.x - o.hx!, Math.min(o.x + o.hx!, out.x));
        const cy = Math.max(o.y - o.hy!, Math.min(o.y + o.hy!, out.y));
        const normal = angleOf({ x: out.x - cx, y: out.y - cy });
        const tangents = [normal + Math.PI / 2, normal - Math.PI / 2];
        u.facing = Math.abs(angleDiff(tangents[0], u.facing)) <= Math.abs(angleDiff(tangents[1], u.facing)) ? tangents[0] : tangents[1];
        u.pos = out;
        ctx.events.push({ type: 'reposition', unit: u.id, to: { ...u.pos } });
        if (damage) {
          damageUnit(ctx, u, damage * C.DAMAGE_SCALE, 'scattered');
          addStress(ctx, u, damage, '撞上建築');
        }
        break;
      }
      // 攀升（跳躍）中的機體在空中，移動結束才落下；這樣才跳得過街道到對面的樓頂
      if (u.z && !m.plan?.climb && !flying(u)) {
        const z = footing(ctx.state.obstacles, u.pos, r, u.z);
        if (z < u.z) {
          u.z = z || undefined;
          ctx.events.push({ type: 'elevate', t, unit: u.id, z, how: 'drop' });
        }
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
        if (d >= rr || !sameLevel(a.unit, b.unit)) {
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

  // 高速穿越隕石群：每穿過一片碎石區擲一次，速度越快越容易被打中
  for (const m of movers) {
    if (!m.path || m.unit.status !== 'active') continue;
    const speed = Math.round(m.path.length);
    if (speed <= C.DEBRIS_SAFE_SPEED) continue;
    for (const f of ctx.state.obstacles.filter((o) => o.kind === 'field')) {
      if (!m.samples.some((s) => Math.hypot(s[0] - f.x, s[1] - f.y) <= f.r)) continue;
      if (ctx.rng.d100() > (speed - C.DEBRIS_SAFE_SPEED) * C.DEBRIS_CHANCE_PER_SPEED) continue;
      ctx.events.push({ type: 'debris', unit: m.unit.id, obstacle: f.id, damage: C.DAMAGE_SCALE });
      damageUnit(ctx, m.unit, C.DAMAGE_SCALE, 'scattered');
    }
  }

  // 射擊用的本回合移動向量：中途停下、急停反轉、懸停或纏鬥中都算 0
  const moved: Record<string, Vec> = {};
  for (const m of movers) {
    const start = m.samples[0];
    const kept = m.path && m.moving && m.path.spec.kind !== 'kturn';
    moved[m.unit.id] = kept ? { x: m.unit.pos.x - start[0], y: m.unit.pos.y - start[1] } : { x: 0, y: 0 };
  }
  separateOverlaps(ctx, movers);
  settleHeights(ctx.state, ctx.events);
  for (const m of movers) {
    const last = m.samples[m.samples.length - 1];
    last[0] = m.unit.pos.x;
    last[1] = m.unit.pos.y;
    ctx.events.push({ type: 'move', unit: m.unit.id, samples: m.samples.map(([x, y, f]) => [round(x), round(y), round(f)]) });
  }
  return { bumped, velocity: moved, stopped: new Set(movers.filter((m) => m.halted || m.knocked).map((m) => m.unit.id)) };

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
    // 近戰姿態：自己高速的是出手方，自己慢速的會咬住或承受衝擊；隊友之間只會擦撞
    const allies = a.unit.owner === b.unit.owner;
    const melee = allies ? [] : [a, b].filter((m) => stance[m.unit.id] === 'melee');
    const fast = (m: Mover) => (m.plan ? moveSpeed(m.plan) : 0) > C.SLOW_MAX_SPEED;
    const attackers = melee.filter(fast);
    const halt = (...ms: Mover[]) => {
      for (const m of ms) {
        if (m.moving) m.unit.pos = prev.get(m.unit.id)!;
        stop(m);
      }
    };

    // 沒人近戰：擦撞。近戰：相對速度低就咬住（纏鬥），高速出手方一擊脫離（沒拿近戰武器則撞擊），只有慢速的一方也咬住
    const bladed = attackers.filter((m) => readyMelee(m.unit));
    let result: ContactResult;
    if (melee.length === 0) result = 'bump';
    // 戰艦咬不住也不會被拖進纏鬥：低速接觸只是擦撞
    else if (vc <= C.CLINCH_MAX_VC || attackers.length === 0) result = isShip(a.unit) || isShip(b.unit) ? 'bump' : 'clinch';
    else result = bladed.length ? 'hitrun' : 'ram';
    emit(vc, result);
    // 承受衝擊：慢速近戰被高速衝進來，站穩硬吃，壓力 +相對速度 ÷ 2
    const bracer = [a, b].find((m) => melee.includes(m) && !attackers.includes(m));
    if (bracer && (result === 'hitrun' || result === 'ram')) addStress(ctx, bracer.unit, Math.floor(vc / 2), '承受衝擊');

    switch (result) {
      case 'bump':
        halt(a, b);
        bumped.add(a.unit.id);
        bumped.add(b.unit.id);
        break;
      case 'clinch':
        halt(a, b);
        ctx.state.grapples.push({ a: a.unit.id, b: b.unit.id, advantage: clinchAdvantage(a.unit, b.unit) });
        break;
      case 'hitrun': {
        for (const m of bladed) {
          const from = pilotOf(m.unit).skill >= C.ACE_SKILL ? C.ACE_HIGH_SPEED_FROM : C.HIGH_SPEED_FROM;
          if (vc >= from) addStress(ctx, m.unit, vc - from + 1, '高速出刀');
        }
        const att = bladed[0];
        const def = att === a ? b : a;
        const caught = meleeClash(ctx, att.unit, def.unit, t, attackers.includes(def), def === bracer);
        if (caught) {
          halt(a, b);
          ctx.state.grapples.push({ a: a.unit.id, b: b.unit.id, advantage: clinchAdvantage(a.unit, b.unit) });
        }
        break;
      }
      case 'ram':
        halt(a, b);
        ram(ctx, attackers, a, b, vc, bracer);
        break;
    }
    return result;
  }

  /** 撞擊：被撞的一方受「相對速度＋重量差」傷害，撞人的一方自己承受一半；雙方都突進則各自吃對方的撞擊 */
  function ram(ctx: Ctx, rammers: Mover[], a: Mover, b: Mover, vc: number, bracer?: Mover) {
    const wa = chassisOf(a.unit).weightClass;
    const wb = chassisOf(b.unit).weightClass;
    // 承受衝擊的一方受到的撞擊傷害減半
    const braced = (m: Mover, n: number) => (m === bracer ? Math.max(1, Math.floor(n / 2)) : n);
    const hitA = braced(a, Math.max(1, vc + wb - wa)) * C.DAMAGE_SCALE;
    const hitB = braced(b, Math.max(1, vc + wa - wb)) * C.DAMAGE_SCALE;
    const both = rammers.length === 2;
    // 撞擊是動能；撞人的一方自己吃的一半照舊的點數取整
    const half = (n: number) => Math.floor(n / C.DAMAGE_SCALE / 2) * C.DAMAGE_SCALE;
    dealtBy(ctx, b.unit, () => typed(ctx, 'kinetic', () => damageUnit(ctx, a.unit, both || rammers[0] === b ? hitA : half(hitB), 'scattered')), false);
    dealtBy(ctx, a.unit, () => typed(ctx, 'kinetic', () => damageUnit(ctx, b.unit, both || rammers[0] === a ? hitB : half(hitA), 'scattered')), false);
    addStress(ctx, a.unit, Math.floor(vc / 2), '撞擊');
    addStress(ctx, b.unit, Math.floor(vc / 2), '撞擊');
    if (wa === wb) return;
    const [heavy, light] = wa > wb ? [a, b] : [b, a];
    const dir = normalize(sub(light.unit.pos, heavy.unit.pos));
    light.unit.pos = add(light.unit.pos, scale(dir, (Math.abs(wa - wb) + 1) / (light === bracer ? 2 : 1)));
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
        if (grappled.has(pairKey(a.id, b.id)) || !sameLevel(a, b)) continue;
        const d = dist(a.pos, b.pos);
        const need = radiusOf(a) + radiusOf(b);
        if (d >= need - 1e-6) continue;
        const dir = d < 1e-6 ? { x: 1, y: 0 } : normalize(sub(b.pos, a.pos));
        const push = (need - d) / 2 + 1e-4;
        a.pos = sub(a.pos, scale(dir, push));
        b.pos = add(b.pos, scale(dir, push));
        moved = true;
      }
    }
    for (const m of movers) {
      const u = m.unit;
      for (const o of ctx.state.obstacles) {
        if (o.kind === 'building') {
          if (o.levels! <= (u.z ?? 0) || wallPenetration(o, u.pos, radiusOf(u)) <= 1e-6) continue;
          u.pos = pushOutOfWall(o, u.pos, radiusOf(u));
          moved = true;
          continue;
        }
        if (o.kind !== 'rock') continue;
        const d = dist(u.pos, o);
        if (d >= o.r + radiusOf(u)) continue;
        const dir = d < 1e-6 ? { x: 1, y: 0 } : normalize(sub(u.pos, o));
        u.pos = add(o, scale(dir, o.r + radiusOf(u) + 1e-3));
        moved = true;
      }
    }
    if (!moved) break;
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
