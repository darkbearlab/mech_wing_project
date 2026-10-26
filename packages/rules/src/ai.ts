// 規則式 AI：只看自己席位的可見資訊（看不到對手駕駛、壓力、推進劑），不作弊。
// 移動：對每個可用機動模擬路徑（撞上大隕石就停在撞點），依終點的火力、受威脅程度、與目標的距離、
//       隊形、邊界、下回合會不會撞上、壓力與推進劑打分。受傷越重越重視自保。
// 行動：全隊選一個集火目標，挑期望傷害最高的射擊（集火目標與受傷的敵機加權）；沒得打就拔刀、拔槍或鎖定。
import { DEG, angleDiff, angleOf, dist, sub } from './geometry';
import { closeCombatOf, minSpeedOf, radiusOf, roleLost } from './body';
import { CHASSIS, EQUIPMENT, PILOTS } from './data';
import { hitChance, relativeSpeed } from './combat';
import { grappleOptions } from './grapple';
import { parseManeuver, samplePath, worldPose, type ManeuverSpec } from './maneuvers';
import { lineOfFire } from './terrain';
import { buildPath } from './movement';
import { DEBRIS_SAFE_SPEED, MAP_SIZE, FACING_OFFSETS, ROCK_SAFE_SPEED, SLOW_MAX_SPEED } from './config';
import { insideField } from './terrain';
import type { Rng } from './rng';
import type { ActionPlan, EquipState, GrappleChoice, Hand, MovePlan, Obstacle, PlayerActions, PlayerMoves, Stance, UnitState, Vec } from './types';
import { availableManeuvers, cruiseManeuver, equipAlive, handUsable, maneuverCost, moveSpeed, readyRanged } from './unit';
import type { PlayerView } from './match';
import type { UnitView } from './visibility';

const RANGE_TARGET: Record<1 | 2 | 3, number> = { 1: 2, 2: 4.5, 3: 8 };

const armOk = (u: Pick<UnitView, "parts" | "equipment">, h: Hand) => handUsable(u, h);
const heldItems = (u: UnitView) => u.equipment.filter((e) => (e.location === 'right' || e.location === 'left') && armOk(u, e.location) && equipAlive(u, e));
/** 能用的武器：近戰要拿在手上；射擊包含外掛與內建 */
const heldOf = (u: UnitView, kind: 'ranged' | 'melee') => (kind === 'ranged' ? readyRanged(u) : heldItems(u).filter((e) => EQUIPMENT[e.defId].kind === kind));
const stowedOf = (u: UnitView, kind: 'ranged' | 'melee') =>
  u.equipment.filter((e) => (e.location === 'stowed' || e.location === 'housed') && equipAlive(u, e) && EQUIPMENT[e.defId].kind === kind);
const canHold = (u: UnitView) => (['right', 'left'] as Hand[]).some((h) => armOk(u, h));
const edge = (a: Vec, b: Vec) => dist(a, b) - 1;

/** 拔出的武器放到哪隻手：先找空手，再找沒拿盾、也不是 keep 的那隻 */
export function drawHand(u: Pick<UnitView, 'parts' | 'equipment'>, keep?: string): Hand {
  const v = u as UnitView;
  const hands = (['right', 'left'] as Hand[]).filter((h) => armOk(v, h));
  const held = (h: Hand) => v.equipment.find((e) => e.location === h && equipAlive(v, e));
  return hands.find((h) => !held(h)) ?? hands.find((h) => EQUIPMENT[held(h)!.defId].kind !== 'shield' && held(h)!.id !== keep) ?? hands[0] ?? 'right';
}

/** 這台機體想和敵人保持的底板距離：拿刀就貼上去，拿槍就待在武器最擅長的距離帶 */
function preferredRange(u: UnitView): { range: number; melee: boolean } {
  if (heldOf(u, 'melee').length) return { range: 0, melee: true };
  let best: { range: number; mod: number } | null = null;
  for (const e of heldOf(u, 'ranged')) {
    const ranges = EQUIPMENT[e.defId].ranges ?? {};
    for (const band of [1, 2, 3] as const) {
      const mod = ranges[band];
      if (mod !== undefined && (!best || mod > best.mod)) best = { range: RANGE_TARGET[band], mod };
    }
  }
  return { range: best?.range ?? 4, melee: false };
}

/** 猜敵機下一步大概會到哪：沿目前朝向照動能前進 */
const predict = (e: UnitView): Vec => {
  const step = Math.max(1, Math.min(4, Math.abs(e.momentum ?? 2)));
  return { x: e.pos.x + Math.cos(e.facing) * step, y: e.pos.y + Math.sin(e.facing) * step };
};

function nearest(from: Vec, enemies: UnitView[], at: (e: UnitView) => Vec = (e) => e.pos): UnitView | null {
  let best: UnitView | null = null;
  let d = Infinity;
  for (const e of enemies) {
    const dd = dist(from, at(e));
    if (dd < d) {
      d = dd;
      best = e;
    }
  }
  return best;
}

/** 受傷程度 0–1：核心剩多少為主，其他部位為輔 */
function hurtOf(u: UnitView): number {
  const body = Object.values(u.parts).filter((p) => p.kind === 'body');
  const core = body.filter((p) => p.role === 'core');
  const left = (ps: typeof body) => ps.reduce((n, p) => n + Math.max(0, p.durability - p.damage), 0) / Math.max(1, ps.reduce((n, p) => n + p.durability, 0));
  return Math.min(1, Math.max(1 - left(core), (1 - left(body)) * 0.7));
}

const ASSUMED_SKILL = 3;

/** 從 from 打 target 的最佳期望傷害（attackerFacing 為 null 時假設手持武器會轉向目標） */
function expectedDamage(shooter: UnitView, from: Vec, facing: number | null, target: UnitView, at: Vec, targetFacing: number, obstacles: Obstacle[], skill: number, targetSkill: number | null): number {
  let best = 0;
  for (const w of heldOf(shooter, 'ranged')) {
    const def = EQUIPMENT[w.defId];
    if (def.tags?.includes('dazzle') || (w.ammo !== undefined && w.ammo <= 0)) continue;
    const face = def.arc === undefined && facing === null ? angleOf(sub(at, from)) : (facing ?? shooter.facing);
    const h = hitChance({
      attacker: { ...shooter, pos: from, facing: face },
      attackerSkill: skill,
      weapon: def,
      target: { ...target, pos: at, facing: targetFacing },
      targetSkill,
      relSpeed: null,
      shooterMelee: false,
      cover: lineOfFire(obstacles, from, at),
    });
    if (h) best = Math.max(best, (h.chance / 100) * (def.damage ?? 1) * (def.shots ?? 1));
  }
  return best;
}

interface TeamPlan {
  enemies: UnitView[];
  allies: UnitView[];
  focus: UnitView | null;
  /** 隊友已經決定的機動：終點與路徑上各時間點的位置（同時移動，要錯開） */
  planned: { id: string; pos: Vec; r: number; track: Vec[] }[];
  obstacles: Obstacle[];
}

/** 全隊的集火目標：受傷重、威脅大、離我方近的敵機 */
function pickFocus(own: UnitView[], enemies: UnitView[], obstacles: Obstacle[]): UnitView | null {
  if (!enemies.length || !own.length) return null;
  const cx = own.reduce((n, u) => n + u.pos.x, 0) / own.length;
  const cy = own.reduce((n, u) => n + u.pos.y, 0) / own.length;
  let best: { e: UnitView; v: number } | null = null;
  for (const e of enemies) {
    const danger = own.reduce((n, u) => n + expectedDamage(e, e.pos, null, u, u.pos, u.facing, obstacles, ASSUMED_SKILL, null), 0);
    const v = hurtOf(e) * 4 + danger * 0.8 - dist({ x: cx, y: cy }, e.pos) * 0.25;
    if (!best || v > best.v) best = { e, v };
  }
  return best!.e;
}

const TRACK = 12;
function scoreManeuver(u: UnitView, m: ManeuverSpec, team: TeamPlan, rng: Rng): { score: number; end: Vec; facing: number; track: Vec[] } {
  const path = buildPath(u, { maneuver: m.id, limiter: false });
  const r = radiusOf(u);
  const rocks = team.obstacles.filter((o) => o.kind === 'rock');
  // 模擬路徑：撞上大隕石就停在撞點，動能歸零（戰機只降到最低速度）
  const N = 24;
  let crashAt = -1;
  for (let i = 1; i <= N && crashAt < 0; i++) {
    const p = worldPose(path, i / N).pos;
    if (rocks.some((o) => dist(p, o) < o.r + r)) crashAt = i;
  }
  const endT = crashAt < 0 ? 1 : (crashAt - 1) / N;
  const endPose = worldPose(path, endT);
  const track = Array.from({ length: TRACK + 1 }, (_, k) => worldPose(path, Math.min(endT, k / TRACK)).pos);
  const pos = endPose.pos;
  const facing = endPose.facing;
  const endMomentum = crashAt < 0 ? m.endMomentum : minSpeedOf(u);
  const margin = 1.2;
  if (pos.x < margin || pos.y < margin || pos.x > MAP_SIZE - margin || pos.y > MAP_SIZE - margin) return { score: -1000, end: pos, facing, track };
  let score = 0;
  if (crashAt >= 0) score -= 12 + Math.max(0, Math.round(path.length) - ROCK_SAFE_SPEED) * 8;
  // 高速穿過隕石群可能被碎石打中
  if (m.speed > DEBRIS_SAFE_SPEED && samplePath(path, 8).some((p) => insideField(team.obstacles, p))) score -= (m.speed - DEBRIS_SAFE_SPEED) * 1.5;

  // 有動能就煞不住：速度越快，離邊緣要留越多煞車距離
  const brake = margin + Math.abs(endMomentum) * 1.2;
  const edgeGap = Math.min(pos.x, pos.y, MAP_SIZE - pos.x, MAP_SIZE - pos.y);
  if (edgeGap < brake) score -= (brake - edgeGap) * 15;
  // 往前看一回合：照這個動能直直飛下去會不會撞上大隕石（停不下來的話更危險）
  const ahead = Math.max(1, Math.abs(endMomentum), minSpeedOf(u));
  const dir = endMomentum < 0 ? facing + Math.PI : facing;
  for (let k = 1; k <= 6; k++) {
    const p = { x: pos.x + Math.cos(dir) * ahead * (k / 6), y: pos.y + Math.sin(dir) * ahead * (k / 6) };
    if (rocks.some((o) => dist(p, o) < o.r + r)) {
      score -= 4 + Math.abs(endMomentum) * 1.5;
      break;
    }
  }

  const hurt = hurtOf(u);
  const pref = preferredRange(u);
  const skill = PILOTS[u.pilotId!]?.skill ?? ASSUMED_SKILL;
  const target = team.focus && !team.focus.hidden ? team.focus : nearest(pos, team.enemies, predict);
  if (target) {
    const tp = predict(target);
    const d = edge(pos, tp);
    // 受傷重的往後退：拉開到更遠的距離
    const want = pref.melee ? 0 : pref.range + hurt * 3;
    score -= Math.abs(d - want) * (pref.melee ? 2 : 1);
    const ang = Math.abs(angleDiff(angleOf(sub(tp, pos)), facing));
    if (pref.melee) score += ang < 60 * DEG ? 2 : 0;
    else score += ang < 45 * DEG ? 2 : -ang;
  }
  // 火力：從終點能打到誰、打多痛（集火目標加權）
  if (!pref.melee) {
    let offense = 0;
    for (const e of team.enemies) {
      const v = expectedDamage(u, pos, facing, e, predict(e), e.facing, team.obstacles, skill, null) * (e === team.focus ? 1.4 : 1);
      offense = Math.max(offense, v);
    }
    score += offense * 3;
  }
  // 威脅：敵機下回合從預測位置打過來的期望傷害（找掩蔽、躲射界），受傷越重越在意
  let threat = 0;
  for (const e of team.enemies) {
    threat += expectedDamage(e, predict(e), null, u, pos, facing, team.obstacles, ASSUMED_SKILL, skill);
    if (heldOf(e, 'melee').length && dist(predict(e), pos) < 4) threat += 1;
  }
  score -= threat * (1.2 + hurt * 3);

  // 隊形：不要擠在一起（會互撞），也不要落單
  // 撞到隊友會擦撞、這回合不能行動，代價很大
  for (const pl of team.planned) {
    if (dist(pl.pos, pos) < pl.r + r + 0.3) score -= 15;
    else if (track.some((p, k) => dist(p, pl.track[k]) < pl.r + r + 0.1)) score -= 15;
    else if (dist(pl.pos, pos) < pl.r + r + 0.8) score -= 3;
  }
  const mates = [...team.planned.map((p) => p.pos), ...team.allies.filter((a) => !team.planned.some((p) => p.id === a.id)).map((a) => a.pos)];
  if (mates.length) {
    const near = Math.min(...mates.map((p) => dist(p, pos)));
    if (near > 7) score -= (near - 7) * 0.5;
  }

  const cost = maneuverCost(u, m);
  const stress = u.stress ?? 0;
  if (stress + cost.stress > (u.maxStress ?? 5)) score -= 8;
  score -= cost.stress * 0.7;
  score -= cost.propellant * ((u.propellant ?? 0) < 6 ? 2 : 0.5);
  score += rng.next() * 1;
  return { score, end: pos, facing, track };
}

const GRAPPLE_WEIGHT: Record<GrappleChoice, number> = { slash: 4, grab: 3, push: 2, parry: 2, disengage: 1 };

function pickGrapple(u: UnitView, rng: Rng): GrappleChoice {
  const opts = grappleOptions(u as unknown as UnitState);
  const tired = (u.stress ?? 0) >= (u.maxStress ?? 5) - 1;
  return rng.pickWeighted(opts, (o) => (o === 'disengage' && tired ? 3 : GRAPPLE_WEIGHT[o]));
}

export function aiMoves(view: PlayerView, rng: Rng): PlayerMoves {
  const own = view.state.units.filter((u) => u.owner === view.you && u.status === 'active');
  const seen = view.state.units.filter((u) => u.owner !== view.you && u.status === 'active' && !u.hidden);
  const enemies = seen.length ? seen : view.state.units.filter((u) => u.owner !== view.you && u.status === 'active');
  const grappled = new Set(view.state.grapples.flatMap((g) => [g.a, g.b]));
  const team: TeamPlan = { enemies, allies: own, focus: pickFocus(own, seen, view.state.obstacles), planned: [], obstacles: view.state.obstacles };
  const out: PlayerMoves = {};
  // 受傷重的先決定位置（讓它先找好掩蔽），其餘照順序
  for (const u of [...own].sort((a, b) => hurtOf(b) - hurtOf(a))) {
    const base: MovePlan = { maneuver: 'hover-S-0', stance: 'shoot', facingOffset: 0, limiter: false };
    if (grappled.has(u.id)) {
      out[u.id] = { ...base, grapple: pickGrapple(u, rng) };
      // 纏鬥中的機體留在原地，隊友要繞開
      team.planned.push({ id: u.id, pos: u.pos, r: radiusOf(u), track: Array.from({ length: TRACK + 1 }, () => u.pos) });
      continue;
    }
    const options = availableManeuvers(u);
    let best: { score: number; end: Vec; facing: number; track?: Vec[]; m: ManeuverSpec } = { score: -Infinity, end: u.pos, facing: u.facing, m: options[0] ?? parseManeuver(cruiseManeuver(u)) };
    for (const m of options) {
      const s = scoreManeuver(u, m, team, rng);
      if (s.score > best.score) best = { ...s, m };
    }
    team.planned.push({ id: u.id, pos: best.end, r: radiusOf(u), track: best.track ?? [u.pos] });
    const plan: MovePlan = { ...base, maneuver: best.m.id };
    const target = nearest(u.pos, enemies);
    const d = target ? edge(u.pos, target.pos) : Infinity;
    // 懸停時轉身面向最近的敵人
    if (best.m.kind === 'hover' && target) {
      const want = angleOf(sub(target.pos, u.pos));
      plan.facingOffset = [...FACING_OFFSETS].sort((a, b) => Math.abs(angleDiff(want, u.facing + a * DEG)) - Math.abs(angleDiff(want, u.facing + b * DEG)))[0];
    }
    // 拿刀且敵人在 8 格內就近戰；沒拿刀、附近有拿刀的敵人、而且這回合走得慢，有機會改近戰姿態站穩承受衝擊（重機比較愛用）
    const swordsman = enemies.some((e) => heldOf(e, 'melee').length && edge(u.pos, e.pos) < 8);
    const braceChance = 0.35 + 0.15 * (CHASSIS[u.chassisId].weightClass - 2);
    let stance: Stance = 'shoot';
    if (heldOf(u, 'melee').length && d < 8) stance = 'melee';
    else if (swordsman && moveSpeed(plan) <= SLOW_MAX_SPEED && rng.next() < braceChance) stance = 'melee';
    plan.stance = closeCombatOf(u) ? stance : 'shoot';
    out[u.id] = plan;
  }
  return out;
}

export function aiActions(view: PlayerView, rng: Rng): PlayerActions {
  const own = view.state.units.filter((u) => u.owner === view.you && u.status === 'active' && !view.state.bumped.includes(u.id));
  const enemies = view.state.units.filter((u) => u.owner !== view.you && u.status === 'active' && !u.hidden);
  const out: PlayerActions = {};
  const focus = pickFocus(own, enemies, view.state.obstacles);
  const aimed: Record<string, number> = {};
  for (const u of own) {
    const skill = PILOTS[u.pilotId!]?.skill ?? 1;
    let shot: { weapon: EquipState; target: UnitView; value: number; chance: number } | null = null;
    for (const w of heldOf(u, 'ranged')) {
      const def = EQUIPMENT[w.defId];
      // 眩光要靠隊友接著開火才划算；AI 還不會整體協調，先不用
      if (def.tags?.includes('dazzle')) continue;
      for (const t of enemies) {
        const h = hitChance({ attacker: u, attackerSkill: skill, weapon: def, target: t, targetSkill: null, relSpeed: relativeSpeed(view.state.velocity, u.id, t.id), shooterMelee: view.state.stance[u.id] === 'melee', cover: lineOfFire(view.state.obstacles, u.pos, t.pos) });
        if (!h || (w.ammo !== undefined && w.ammo <= 0)) continue;
        // 集火：集火目標、受傷的、隊友已經瞄準的敵機加權
        const weight = (t === focus ? 1.4 : 1) * (1 + hurtOf(t) * 0.8) * (1 + (aimed[t.id] ?? 0) * 0.2);
        const value = (h.chance / 100) * (def.damage ?? 1) * (def.shots ?? 1) * weight + rng.next() * 0.2;
        if (!shot || value > shot.value) shot = { weapon: w, target: t, value, chance: h.chance };
      }
    }
    const plan: ActionPlan = { action: { type: 'none' } };
    const near = nearest(u.pos, enemies);
    const d = near ? edge(u.pos, near.pos) : Infinity;
    if (shot && shot.chance >= 12) {
      plan.action = { type: 'shoot', weapon: shot.weapon.id, target: shot.target.id };
      aimed[shot.target.id] = (aimed[shot.target.id] ?? 0) + 1;
    } else if (canHold(u) && !heldOf(u, 'melee').length && stowedOf(u, 'melee').length && d < 7) {
      plan.swap = { hand: drawHand(u), equip: stowedOf(u, 'melee')[0].id };
    } else if (canHold(u) && !heldOf(u, 'ranged').length && !heldOf(u, 'melee').length && stowedOf(u, 'ranged').length) {
      plan.swap = { hand: drawHand(u), equip: stowedOf(u, 'ranged')[0].id };
    } else if (!roleLost(u, 'sensor') && near && d <= 10 && u.lockOn !== near.id) {
      plan.action = { type: 'lock', target: near.id };
    }
    out[u.id] = plan;
  }
  return out;
}
