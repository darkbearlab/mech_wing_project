// 簡單的規則式 AI：只看自己席位的可見資訊（看不到對手駕駛、壓力、推進劑），不作弊。
// 移動：對每個可用機動估算終點，依武器擅長的距離、朝向、邊界、壓力與推進劑打分。
// 行動：挑期望傷害最高的射擊；沒得打就拔刀、拔槍或鎖定。
import { DEG, angleDiff, angleOf, dist, sub } from './geometry';
import { EQUIPMENT, PILOTS } from './data';
import { hitChance } from './combat';
import { grappleOptions } from './grapple';
import { parseManeuver, worldPose, type ManeuverSpec } from './maneuvers';
import { buildPath } from './movement';
import { MAP_SIZE, FACING_OFFSETS } from './config';
import type { Rng } from './rng';
import type { ActionPlan, EquipState, GrappleChoice, Hand, MovePlan, PlayerActions, PlayerMoves, Stance, UnitState, Vec } from './types';
import { availableManeuvers } from './unit';
import type { PlayerView } from './match';
import type { UnitView } from './visibility';

const RANGE_TARGET: Record<1 | 2 | 3, number> = { 1: 2, 2: 4.5, 3: 8 };

const alive = (u: UnitView, id: string) => !!u.parts[id] && !u.parts[id].destroyed;
const armOk = (u: UnitView, h: Hand) => alive(u, h === 'right' ? 'rarm' : 'larm');
const heldItems = (u: UnitView) => u.equipment.filter((e) => (e.location === 'right' || e.location === 'left') && armOk(u, e.location) && alive(u, e.id));
const heldOf = (u: UnitView, kind: 'ranged' | 'melee') => heldItems(u).filter((e) => EQUIPMENT[e.defId].kind === kind);
const stowedOf = (u: UnitView, kind: 'ranged' | 'melee') => u.equipment.filter((e) => e.location === 'stowed' && alive(u, e.id) && EQUIPMENT[e.defId].kind === kind);
const edge = (a: Vec, b: Vec) => dist(a, b) - 1;

/** 拔出的武器放到哪隻手：先找空手，再找沒拿盾、也不是 keep 的那隻 */
export function drawHand(u: Pick<UnitView, 'parts' | 'equipment'>, keep?: string): Hand {
  const v = u as UnitView;
  const hands = (['right', 'left'] as Hand[]).filter((h) => armOk(v, h));
  const held = (h: Hand) => v.equipment.find((e) => e.location === h && alive(v, e.id));
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

/** 猜敵機下一步大概會到哪：沿目前朝向前進 2 格 */
const predict = (e: UnitView): Vec => ({ x: e.pos.x + Math.cos(e.facing) * 2, y: e.pos.y + Math.sin(e.facing) * 2 });

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

function scoreManeuver(u: UnitView, m: ManeuverSpec, enemies: UnitView[], planned: Vec[], rng: Rng): { score: number; end: Vec; facing: number } {
  const path = buildPath(u, { maneuver: m.id, limiter: false });
  const end = worldPose(path, 1);
  const pos = end.pos;
  const margin = 1.2;
  if (pos.x < margin || pos.y < margin || pos.x > MAP_SIZE - margin || pos.y > MAP_SIZE - margin) return { score: -1000, end: pos, facing: end.facing };
  const pref = preferredRange(u);
  const target = nearest(pos, enemies, predict);
  let score = 0;
  if (target) {
    const tp = predict(target);
    const d = edge(pos, tp);
    score -= Math.abs(d - pref.range) * 2;
    const ang = Math.abs(angleDiff(angleOf(sub(tp, pos)), end.facing));
    if (pref.melee) score += ang < 60 * DEG ? 2 : 0;
    else score += ang < 45 * DEG ? 3 : -ang * 1.5;
  }
  const stress = u.stress ?? 0;
  if (stress + m.stress > (u.maxStress ?? 5)) score -= 8;
  score -= m.stress * 0.7;
  score -= m.propellant * ((u.propellant ?? 0) < 4 ? 2 : 0.4);
  for (const p of planned) if (dist(p, pos) < 1.3) score -= 6;
  score += rng.next() * 1.5;
  return { score, end: pos, facing: end.facing };
}

const GRAPPLE_WEIGHT: Record<GrappleChoice, number> = { slash: 4, grab: 3, push: 2, parry: 2, disengage: 1 };

function pickGrapple(u: UnitView, rng: Rng): GrappleChoice {
  const opts = grappleOptions(u as unknown as UnitState);
  const tired = (u.stress ?? 0) >= (u.maxStress ?? 5) - 1;
  return rng.pickWeighted(opts, (o) => (o === 'disengage' && tired ? 3 : GRAPPLE_WEIGHT[o]));
}

export function aiMoves(view: PlayerView, rng: Rng): PlayerMoves {
  const own = view.state.units.filter((u) => u.owner === view.you && u.status === 'active');
  const enemies = view.state.units.filter((u) => u.owner !== view.you && u.status === 'active');
  const grappled = new Set(view.state.grapples.flatMap((g) => [g.a, g.b]));
  const planned: Vec[] = [];
  const out: PlayerMoves = {};
  for (const u of own) {
    const base: MovePlan = { maneuver: 'hover-S-0', stance: 'normal', facingOffset: 0, limiter: false, soften: false };
    if (grappled.has(u.id)) {
      out[u.id] = { ...base, grapple: pickGrapple(u, rng) };
      continue;
    }
    const options = availableManeuvers(u);
    let best = { score: -Infinity, end: u.pos, facing: u.facing, m: options[0] ?? parseManeuver('hover-S-0') };
    for (const m of options) {
      const s = scoreManeuver(u, m, enemies, planned, rng);
      if (s.score > best.score) best = { ...s, m };
    }
    planned.push(best.end);
    const plan: MovePlan = { ...base, maneuver: best.m.id };
    const target = nearest(u.pos, enemies);
    const d = target ? edge(u.pos, target.pos) : Infinity;
    // 懸停時轉身面向最近的敵人
    if (best.m.kind === 'hover' && target) {
      const want = angleOf(sub(target.pos, u.pos));
      plan.facingOffset = [...FACING_OFFSETS].sort((a, b) => Math.abs(angleDiff(want, u.facing + a * DEG)) - Math.abs(angleDiff(want, u.facing + b * DEG)))[0];
    }
    const stance: Stance = heldOf(u, 'melee').length && d < 8 ? 'charge' : d < 10 && rng.next() < 0.35 ? 'evade' : 'normal';
    plan.stance = stance;
    out[u.id] = plan;
  }
  return out;
}

export function aiActions(view: PlayerView, rng: Rng): PlayerActions {
  const own = view.state.units.filter((u) => u.owner === view.you && u.status === 'active' && !view.state.bumped.includes(u.id));
  const enemies = view.state.units.filter((u) => u.owner !== view.you && u.status === 'active');
  const out: PlayerActions = {};
  for (const u of own) {
    const skill = PILOTS[u.pilotId!]?.skill ?? 1;
    let shot: { weapon: EquipState; target: UnitView; value: number; chance: number } | null = null;
    for (const w of heldOf(u, 'ranged')) {
      const def = EQUIPMENT[w.defId];
      for (const t of enemies) {
        const h = hitChance({ attacker: u, attackerSkill: skill, weapon: def, target: t, targetSkill: null, targetStance: null, targetHovered: false });
        if (!h) continue;
        const value = (h.chance / 100) * (def.damage ?? 1) * (def.shots ?? 1) + rng.next() * 0.2;
        if (!shot || value > shot.value) shot = { weapon: w, target: t, value, chance: h.chance };
      }
    }
    const plan: ActionPlan = { action: { type: 'none' } };
    const near = nearest(u.pos, enemies);
    const d = near ? edge(u.pos, near.pos) : Infinity;
    if (shot && shot.chance >= 12) {
      plan.action = { type: 'shoot', weapon: shot.weapon.id, target: shot.target.id };
    } else if (!heldOf(u, 'melee').length && stowedOf(u, 'melee').length && d < 7) {
      plan.swap = { hand: drawHand(u), equip: stowedOf(u, 'melee')[0].id };
    } else if (!heldOf(u, 'ranged').length && !heldOf(u, 'melee').length && stowedOf(u, 'ranged').length) {
      plan.swap = { hand: drawHand(u), equip: stowedOf(u, 'ranged')[0].id };
    } else if (alive(u, 'head') && near && d <= 10 && u.lockOn !== near.id) {
      plan.action = { type: 'lock', target: near.id };
    }
    out[u.id] = plan;
  }
  return out;
}
