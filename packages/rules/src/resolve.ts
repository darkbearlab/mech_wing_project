import * as C from './config';
import { shoot, hitChance, type TurnInfo } from './combat';
import { addStress, spendPropellant, unitById, type Ctx } from './damage';
import { resolveGrapple } from './grapple';
import { parseManeuver } from './maneuvers';
import { simulateMovement } from './movement';
import { Rng } from './rng';
import type { GameEvent, GameState, PlayerId, PlayerPlans, Stance, UnitPlan, UnitState } from './types';
import { defaultPlan, equipDef, heldItem, partAlive, pilotOf, planCost } from './unit';

export interface TurnResult {
  state: GameState;
  events: GameEvent[];
}

export const inGrapple = (state: GameState, id: string): boolean => state.grapples.some((g) => g.a === id || g.b === id);

export function resolveTurn(input: GameState, plansByPlayer: [PlayerPlans, PlayerPlans]): TurnResult {
  const state: GameState = structuredClone(input);
  const rng = new Rng(state.rngState);
  const ctx: Ctx = { state, rng, events: [{ type: 'turnStart', turn: state.turn }] };

  const plans: Record<string, UnitPlan> = {};
  for (const u of state.units) {
    if (u.status !== 'active') continue;
    plans[u.id] = plansByPlayer[u.owner][u.id] ?? defaultPlan(u);
  }

  const frozen = new Set(state.grapples.flatMap((g) => [g.a, g.b]));
  const stance: Record<string, Stance> = {};
  const hovered = new Set<string>();
  for (const u of state.units) {
    const plan = plans[u.id];
    if (!plan) continue;
    stance[u.id] = frozen.has(u.id) ? 'normal' : plan.stance;
    if (frozen.has(u.id)) continue;
    if (parseManeuver(plan.maneuver).kind === 'hover') hovered.add(u.id);
    const cost = planCost(plan);
    spendPropellant(ctx, u, Math.min(cost.propellant, u.propellant));
    addStress(ctx, u, cost.stress, plan.limiter ? '機動負荷（限制器解除）' : '機動負荷');
  }
  const turn: TurnInfo = { stance, hovered };

  // 1. 纏鬥
  for (const g of [...state.grapples]) {
    const a = unitById(ctx, g.a);
    const b = unitById(ctx, g.b);
    if (a.status !== 'active' || b.status !== 'active') {
      state.grapples = state.grapples.filter((x) => x !== g);
      continue;
    }
    resolveGrapple(ctx, g, a, b, plans[a.id]?.grapple, plans[b.id]?.grapple);
  }

  // 2. 同時移動
  const { bumped } = simulateMovement(ctx, plans, stance, frozen);
  for (const u of state.units) {
    if (u.status === 'active' && (u.pos.x < 0 || u.pos.y < 0 || u.pos.x > C.MAP_SIZE || u.pos.y > C.MAP_SIZE)) {
      u.status = 'withdrawn';
      ctx.events.push({ type: 'status', unit: u.id, status: 'withdrawn' });
    }
  }

  // 3. 動作：技能高者先，同等級由亂數決定
  const order = state.units
    .filter((u) => u.status === 'active')
    .map((u) => ({ u, skill: pilotOf(u).skill, tie: rng.next() }))
    .sort((x, y) => y.skill - x.skill || x.tie - y.tie)
    .map((x) => x.u);
  for (const u of order) {
    if (u.status !== 'active') continue;
    const plan = plans[u.id];
    if (bumped.has(u.id)) {
      if (plan.action.type !== 'none' || plan.swap) ctx.events.push({ type: 'actionFail', unit: u.id, reason: '擦撞，無法行動' });
      continue;
    }
    let actionUsed = false;
    if (plan.swap) {
      doSwap(ctx, u, plan.swap.hand, plan.swap.equip);
      actionUsed = !pilotOf(u).abilities.includes('quick_draw');
    }
    if (plan.action.type === 'none') continue;
    if (actionUsed) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: '換武器用掉了動作' });
      continue;
    }
    doAction(ctx, turn, u, plan);
  }

  // 4. 回合結束：壓力分級、恢復
  for (const u of state.units) {
    if (u.status !== 'active') continue;
    const over = u.stress - u.maxStress;
    u.blackout = over > C.BLACKOUT_OVER;
    if (over >= C.UNCONSCIOUS_OVER) {
      u.status = 'unconscious';
      ctx.events.push({ type: 'pilot', unit: u.id, state: 'unconscious' });
      ctx.events.push({ type: 'status', unit: u.id, status: 'disabled' });
      continue;
    }
    if (over >= C.INJURED_OVER) {
      u.maxStress = Math.max(1, u.maxStress - C.INJURY_MAX_PENALTY);
      ctx.events.push({ type: 'pilot', unit: u.id, state: 'injured' });
    }
    if (u.blackout) ctx.events.push({ type: 'pilot', unit: u.id, state: 'blackout' });
    const rec = Math.min(u.stress, pilotOf(u).recovery);
    if (rec > 0) addStress(ctx, u, -rec, '恢復');
  }
  state.grapples = state.grapples.filter((g) => unitById(ctx, g.a).status === 'active' && unitById(ctx, g.b).status === 'active');

  // 5. 勝負
  const alive = [0, 1].map((p) => state.units.filter((u) => u.owner === p && u.status === 'active').length);
  if (alive[0] === 0 || alive[1] === 0 || state.turn >= C.TURN_LIMIT) {
    state.winner = alive[0] === alive[1] ? 'draw' : ((alive[0] > alive[1] ? 0 : 1) as PlayerId);
    ctx.events.push({ type: 'gameOver', winner: state.winner });
  } else {
    state.turn++;
  }
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

function doSwap(ctx: Ctx, u: UnitState, hand: 'right' | 'left', equipId: string | null) {
  const arm = hand === 'right' ? 'rarm' : 'larm';
  if (!partAlive(u, arm)) return;
  const current = heldItem(u, hand);
  if (current?.id === equipId) return;
  const next = equipId ? u.equipment.find((e) => e.id === equipId && partAlive(u, e.id) && e.location !== 'mount') : null;
  if (equipId && !next) {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '裝備已損壞，無法換上' });
    return;
  }
  if (current) current.location = 'stowed';
  if (next) next.location = hand;
  ctx.events.push({ type: 'swap', unit: u.id, hand, equip: next?.id ?? null });
}

function doAction(ctx: Ctx, turn: TurnInfo, u: UnitState, plan: UnitPlan) {
  const action = plan.action;
  if (action.type === 'none') return;
  const target = ctx.state.units.find((x) => x.id === action.target);
  if (!target || target.status !== 'active') {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '目標已失去戰鬥能力' });
    return;
  }
  if (action.type === 'lock') {
    if (!partAlive(u, 'head')) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: '頭部損壞，無法鎖定' });
      return;
    }
    const band = hitChance({ attacker: u, attackerSkill: 0, weapon: { id: '', name: '', kind: 'ranged', weight: 0, durability: 0, ranges: { 1: 0, 2: 0, 3: 0 } }, target, targetSkill: null, targetStance: null, targetHovered: false });
    if (!band) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: '目標超出鎖定距離' });
      return;
    }
    u.lockOn = target.id;
    ctx.events.push({ type: 'lock', unit: u.id, target: target.id });
    return;
  }
  const weapon = u.equipment.find((e) => e.id === action.weapon);
  const held = weapon && (heldItem(u, 'right')?.id === weapon.id || heldItem(u, 'left')?.id === weapon.id);
  if (!weapon || !held || equipDef(weapon).kind !== 'ranged') {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '手上沒有可用的射擊武器' });
    return;
  }
  if (!shoot(ctx, turn, u, weapon, target)) ctx.events.push({ type: 'actionFail', unit: u.id, reason: '目標不在射程內' });
}
