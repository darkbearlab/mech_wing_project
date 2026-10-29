import { minSpeedOf, roleLost, roleParts } from './body';
import { barricadeSpotOk, barricadeWall, chaffed, jammed, mineSpotOk } from './ecm';
import { buildingHitChance, collapseVictims, damageBuilding } from './demolition';
import * as C from './config';
import { inMarkCone, sensorRange } from './vision';
import { landInbound, needsMark, shoot, hitChance, spendRounds, type TurnInfo } from './combat';
import { addStress, damageUnit, dealtBy, spendPropellant, typed, unitById, type Ctx } from './damage';
import { resolveGrapple } from './grapple';
import { lungeCheck, meleeClash } from './melee';
import { parseManeuver } from './maneuvers';
import { simulateMovement } from './movement';
import { CHASSIS, EQUIPMENT } from './data';
import { lineOfFire, wallPenetration } from './terrain';
import { updateSight } from './visibility';
import { Rng } from './rng';
import type { ActionPlan, EquipState, GameEvent, Mine, Obstacle, GameState, MovePlan, PlayerActions, PlayerId, PlayerMoves, PlayerPursuits, PursuitPlan, Stance, UnitState, Vec } from './types';
import { anyPursuit, runPursuits } from './pursuit';
import { commandPods, findPod, movePods, podSeen, podUpkeep, psycommuOf, shootPod } from './psycommu';
import { barrageActive, inBarrage, isShip } from './ship';
import { DEFAULT_SETTINGS, byScore, deployZone, flagshipOf, killScoreOf, scoreObjectives, settleBoth, supplyPoint, type WinReason } from './objectives';
import { radiusOf } from './body';
import { DEG, dist } from './geometry';
import type { DeployPlan, PlayerDeploy } from './types';
import { moveSpeed, readyMelee, screenBlocked, wholeDegrees } from './unit';
import { applyJumps, coastManeuver } from './jump';
import { alwaysReady, busyHands, defaultAction, defaultMove, equipAlive, handUsable, heldItem, pilotOf, planCost, rackSide, readyRanged, shotWeapons, swapOrders } from './unit';
import { settleHeights } from './movement';

export interface TurnResult {
  state: GameState;
  events: GameEvent[];
}

export const inGrapple = (state: GameState, id: string): boolean => state.grapples.some((g) => g.a === id || g.b === id);

/**
 * 王牌移動這一批要動的機體：擱置中、技能最低的那一群（雙方都擱置時，技能低的先動、技能高的看完再動；同技能同時動）
 */
export function aceTier(state: GameState): string[] {
  const waiting = (state.turnInfo?.deferred ?? []).map((id) => state.units.find((u) => u.id === id)).filter((u): u is UnitState => !!u && u.status === 'active');
  if (!waiting.length) return [];
  const low = Math.min(...waiting.map((u) => pilotOf(u).skill));
  return waiting.filter((u) => pilotOf(u).skill === low).map((u) => u.id);
}

/** 這台能不能擱置移動（王牌移動）：要有能力、不在纏鬥中 */
export const canDefer = (state: GameState, u: UnitState): boolean => pilotOf(u).abilities.includes('ace_move') && !inGrapple(state, u.id);

const isNewtype = (u: UnitState) => pilotOf(u).abilities.includes('newtype');

/** 移動全部結束後：有人能追擊就進追擊步驟，否則直接到動作 */
function afterMovement(ctx: Ctx): void {
  const { state } = ctx;
  state.phase = state.winner === null && anyPursuit(state) ? 'pursuit' : 'action';
  if (state.phase === 'pursuit') ctx.events.push({ type: 'phase', phase: 'pursuit' });
}

/** 拋棄外裝甲（免費）：裝甲部位標成脫落，機體恢復輕快、武器解鎖 */
function purgeArmor(ctx: Ctx, u: UnitState): void {
  const armor = u.equipment.find((e) => EQUIPMENT[e.defId]?.kind === 'armor' && e.location === 'mount' && u.parts[e.id] && !u.parts[e.id].destroyed);
  if (!armor) return;
  u.parts[armor.id].destroyed = true;
  ctx.events.push({ type: 'purge', unit: u.id });
}

/** 敵機靠太近的氣球被識破 */
function exposeDecoys(ctx: Ctx): void {
  const { state } = ctx;
  for (const d of [...(state.decoys ?? [])]) {
    const near = state.units.find((u) => u.owner !== d.owner && u.status === 'active' && dist(u.pos, d.pos) <= C.DECOY_EXPOSE_RANGE + radiusOf(u));
    if (near) popDecoy(ctx, d.id, near.id, '被靠近識破');
  }
}

function popDecoy(ctx: Ctx, id: string, by: string | undefined, reason: string): void {
  ctx.state.decoys = (ctx.state.decoys ?? []).filter((d) => d.id !== id);
  ctx.events.push({ type: 'decoyPop', decoy: id, by, reason });
}

const env = (state: GameState) => state.settings?.environment ?? 'space';

/** 垂直噴射器落地：付推進劑與壓力，移動向量改成實際的位移 */
function landJumps(ctx: Ctx, plans: Record<string, MovePlan>, ids: Iterable<string>, halted: Set<string>, velocity: Record<string, Vec>, startPos: Map<string, Vec>): Set<string> {
  const done = applyJumps(ctx, plans, ids, halted, (u, propellant, stress) => {
    spendPropellant(ctx, u, Math.min(propellant, u.propellant));
    addStress(ctx, u, stress, env(ctx.state) === 'space' ? '噴射急轉' : '噴射跳躍');
  });
  for (const id of done) {
    const u = unitById(ctx, id);
    const s = startPos.get(id) ?? u.pos;
    velocity[id] = { x: u.pos.x - s.x, y: u.pos.y - s.y };
  }
  return done;
}

/** 噴射後的動能：宇宙保留（已經跟著新的面向），重力圈落地歸零 */
function settleJumpMomentum(ctx: Ctx, jumped: Set<string>): void {
  if (env(ctx.state) === 'space') return;
  for (const id of jumped) unitById(ctx, id).momentum = 0;
}

/** 煙幕彈：移動開始時在原地放出一團煙幕，留到這回合結束（不能放的就不放，指令檢查會先擋） */
function launchScreen(ctx: Ctx, u: UnitState, plan: MovePlan): void {
  if (!plan.smoke || screenBlocked(u, plan)) return;
  const e = u.equipment.find((x) => x.id === plan.smoke)!;
  if (e.ammo !== undefined) e.ammo--;
  const { state } = ctx;
  const n = state.obstacles.filter((o) => o.kind === 'smoke').length;
  state.obstacles.push({ id: `smoke${state.turn}-${u.id}-${n}`, kind: 'smoke', x: u.pos.x, y: u.pos.y, r: C.SMOKE_RADIUS, until: state.turn });
  ctx.events.push({ type: 'smoke', unit: u.id, at: { ...u.pos }, r: C.SMOKE_RADIUS, screen: true });
}

/** 機動的推進劑與壓力 */
function payForMove(ctx: Ctx, u: UnitState, plan: MovePlan): void {
  const cost = planCost(u, plan);
  spendPropellant(ctx, u, Math.min(cost.propellant, u.propellant));
  addStress(ctx, u, cost.stress, plan.limiter ? '機動負荷（限制器解除）' : '機動負荷');
}

/** 移動結算後的動能與出界 */
function settleMomentum(ctx: Ctx, plans: Record<string, MovePlan>, movers: Set<string>, frozen: Set<string>, stopped: Set<string>): void {
  // 動能：照機動的終速延續到下回合；被擋停、撞開或纏鬥中歸零（有最低速度的戰機只降到最低速度，引擎還在推）
  for (const u of ctx.state.units) {
    const plan = plans[u.id];
    if (u.status !== 'active' || !plan || !movers.has(u.id)) continue;
    const end = frozen.has(u.id) || stopped.has(u.id) ? 0 : parseManeuver(plan.maneuver).endMomentum;
    const min = minSpeedOf(u);
    u.momentum = min > 0 ? Math.max(min, end) : end;
  }
  for (const u of ctx.state.units) {
    if (u.status === 'active' && (u.pos.x < 0 || u.pos.y < 0 || u.pos.x > C.MAP_SIZE || u.pos.y > C.MAP_SIZE)) {
      u.status = 'withdrawn';
      ctx.events.push({ type: 'status', unit: u.id, status: 'withdrawn' });
    }
  }
}

/** 第一步：同時移動（擱置的王牌、纏鬥中的機體不動）。之後依序進王牌移動、追擊或動作。 */
export function resolveMovement(input: GameState, movesByPlayer: [PlayerMoves, PlayerMoves]): TurnResult {
  const state: GameState = structuredClone(input);
  const rng = new Rng(state.rngState);
  const ctx: Ctx = { state, rng, events: [{ type: 'turnStart', turn: state.turn }] };

  const plans: Record<string, MovePlan> = {};
  for (const u of state.units) {
    if (u.status !== 'active') continue;
    plans[u.id] = movesByPlayer[u.owner][u.id] ?? defaultMove(u);
  }

  const frozen = new Set(state.grapples.flatMap((g) => [g.a, g.b]));
  // 王牌移動：擱置的機體這一步原地不動，等其他人動完再決定
  const deferred = new Set(state.units.filter((u) => plans[u.id]?.defer && canDefer(state, u)).map((u) => u.id));
  const ntOnSide = (p: PlayerId) => state.units.some((x) => x.owner === p && x.status === 'active' && isNewtype(x));
  const stance: Record<string, Stance> = {};
  for (const u of state.units) {
    const plan = plans[u.id];
    if (!plan) continue;
    stance[u.id] = frozen.has(u.id) || deferred.has(u.id) ? 'shoot' : plan.stance;
    if (deferred.has(u.id)) {
      ctx.events.push({ type: 'defer', unit: u.id });
      // 對方也有新人類在場：互相感應干擾，擱置要付壓力
      if (isNewtype(u) && ntOnSide((1 - u.owner) as PlayerId)) addStress(ctx, u, C.ACE_DEFER_STRESS, '王牌移動（被敵方新人類干擾）');
      continue;
    }
    if (plan.purge) purgeArmor(ctx, u);
    if (frozen.has(u.id)) continue;
    // 垂直噴射器：先沿朝向滑完動能（推進劑、壓力落地時才付）
    if (plan.jump) plans[u.id] = { ...plan, maneuver: coastManeuver(u), limiter: false, facingOffset: 0, climb: undefined };
    stowIfFast(ctx, u, plans[u.id]);
    if (!plan.jump) payForMove(ctx, u, plan);
    launchScreen(ctx, u, plans[u.id]);
  }
  const startPos = new Map(state.units.map((u) => [u.id, { ...u.pos }]));

  // 同時移動（纏鬥中的機體不動；纏鬥在動作步驟最後才結算）
  const moveFrom = ctx.events.length;
  const { bumped, velocity, stopped } = simulateMovement(ctx, plans, stance, new Set([...frozen, ...deferred]));
  const movers = new Set(Object.keys(plans).filter((id) => !deferred.has(id)));
  const jumped = landJumps(ctx, plans, [...movers].filter((id) => !frozen.has(id)), new Set([...stopped, ...bumped]), velocity, startPos);
  triggerMines(ctx, moveFrom);
  settleMomentum(ctx, plans, movers, frozen, stopped);
  settleJumpMomentum(ctx, jumped);
  // 炮群跟著母機的新位置放出、移動或收回（擱置的王牌在王牌移動步驟才動）
  movePods(ctx, plans, movers, (id) => inGrapple(state, id));

  // 第一步裡被碰撞（擦撞、撞擊、近戰、咬住）的王牌就失去這次王牌移動：敵人已經在眼前，看穿也來不及反應
  exposeDecoys(ctx);
  // 低速擦撞（停下但還能行動）不算被碰撞
  const hit = new Set([...bumped, ...ctx.events.flatMap((e) => (e.type === 'contact' && e.result !== 'none' && e.result !== 'bump' ? [e.a, e.b] : []))]);
  for (const id of deferred) if (hit.has(id) && unitById(ctx, id).status === 'active') ctx.events.push({ type: 'actionFail', unit: id, reason: '被碰撞，失去王牌移動' });
  const waiting = [...deferred].filter((id) => unitById(ctx, id).status === 'active' && !hit.has(id) && !inGrapple(state, id));
  const speed: Record<string, number> = {};
  for (const id of movers) if (!frozen.has(id) && plans[id]) speed[id] = moveSpeed(plans[id]);
  state.turnInfo = { stance, velocity, bumped: [...bumped], deferred: waiting, speed, ...(jumped.size && env(state) !== 'space' ? { jumped: [...jumped] } : {}) };
  updateSight(state);
  checkWinner(ctx, false);
  if (state.winner === null && waiting.length) {
    state.phase = 'ace';
    ctx.events.push({ type: 'phase', phase: 'ace' });
  } else afterMovement(ctx);
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

/** 王牌移動步驟：擱置的機體看過其他人的移動結果後再動（技能低的一批先動），其他機體原地不動 */
export function resolveAceMovement(input: GameState, movesByPlayer: [PlayerMoves, PlayerMoves]): TurnResult {
  const state: GameState = structuredClone(input);
  const rng = new Rng(state.rngState);
  const ctx: Ctx = { state, rng, events: [] };
  const info = state.turnInfo ?? { stance: {}, velocity: {}, bumped: [] };
  const aces = new Set(aceTier(state));
  const plans: Record<string, MovePlan> = {};
  const stance: Record<string, Stance> = { ...info.stance };
  for (const id of aces) {
    const u = unitById(ctx, id);
    const plan = { ...(movesByPlayer[u.owner][id] ?? defaultMove(u)), defer: false };
    plans[id] = plan.jump ? { ...plan, maneuver: coastManeuver(u), limiter: false, facingOffset: 0, climb: undefined } : plan;
    stance[id] = plan.stance;
    if (plan.purge) purgeArmor(ctx, u);
    if (!plan.jump) payForMove(ctx, u, plan);
    launchScreen(ctx, u, plans[id]);
  }
  const startPos = new Map(state.units.map((u) => [u.id, { ...u.pos }]));
  const frozen = new Set(state.units.filter((u) => u.status === 'active' && !aces.has(u.id)).map((u) => u.id));
  const result = simulateMovement(ctx, plans, stance, frozen);
  const jumped = landJumps(ctx, plans, aces, new Set([...result.stopped, ...result.bumped]), result.velocity, startPos);
  triggerMines(ctx, 0);
  settleMomentum(ctx, plans, aces, new Set(), result.stopped);
  settleJumpMomentum(ctx, jumped);
  movePods(ctx, plans, aces, (id) => inGrapple(state, id));
  const velocity = { ...info.velocity };
  for (const id of aces) velocity[id] = result.velocity[id] ?? { x: 0, y: 0 };
  exposeDecoys(ctx);
  // 還沒動的王牌（技能較高的下一批）；這一批動的時候被碰撞或拖進纏鬥的就失去王牌移動
  const hit = new Set([...result.bumped, ...ctx.events.flatMap((e) => (e.type === 'contact' && e.result !== 'none' && e.result !== 'bump' ? [e.a, e.b] : []))]);
  const later = (info.deferred ?? []).filter((id) => !aces.has(id) && unitById(ctx, id).status === 'active');
  for (const id of later) if (hit.has(id)) ctx.events.push({ type: 'actionFail', unit: id, reason: '被碰撞，失去王牌移動' });
  const next = later.filter((id) => !hit.has(id) && !inGrapple(state, id));
  const speed = { ...(info.speed ?? {}) };
  for (const id of aces) speed[id] = moveSpeed(plans[id]);
  const landed = [...(info.jumped ?? []), ...(env(state) !== 'space' ? jumped : [])];
  state.turnInfo = { stance, velocity, bumped: [...new Set([...info.bumped, ...result.bumped])], deferred: next, speed, ...(landed.length ? { jumped: landed } : {}) };
  updateSight(state);
  checkWinner(ctx, false);
  if (state.winner === null && next.length) ctx.events.push({ type: 'phase', phase: 'ace' });
  else afterMovement(ctx);
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

/** 追擊步驟：結算雙方送出的追擊射擊，之後進入動作 */
export function resolvePursuit(input: GameState, byPlayer: [PlayerPursuits, PlayerPursuits]): TurnResult {
  const state: GameState = structuredClone(input);
  const rng = new Rng(state.rngState);
  const ctx: Ctx = { state, rng, events: [] };
  const plans: Record<string, PursuitPlan> = {};
  for (const p of [0, 1] as PlayerId[])
    for (const [id, plan] of Object.entries(byPlayer[p])) if (plan && state.units.find((u) => u.id === id)?.owner === p) plans[id] = plan;
  const fired = runPursuits(ctx, plans);
  state.phase = 'action';
  updateSight(state, fired);
  checkWinner(ctx, false);
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

/** 第二步：看到移動結果後選的動作，技能高者先結算；所有射擊之後結算纏鬥；接著回合結束。 */
export function resolveActions(input: GameState, actionsByPlayer: [PlayerActions, PlayerActions]): TurnResult {
  const state: GameState = structuredClone(input);
  const rng = new Rng(state.rngState);
  const ctx: Ctx = { state, rng, events: [] };
  const info = state.turnInfo ?? { stance: {}, velocity: {}, bumped: [] };
  const turn: TurnInfo = { stance: info.stance, velocity: info.velocity, dazzled: new Set(), speed: info.speed, jumped: new Set(info.jumped ?? []) };
  const bumped = new Set(info.bumped);
  // 開火或鎖定會暴露位置
  const revealed = new Set<string>();
  // 上一回合發射的迫擊砲、飛彈先落下
  landInbound(ctx, turn);

  // 標定最先結算（這回合標定、這回合就能打），再來是用眩光武器射擊的，其餘技能高者先、同分抽籤
  const dazzles = (u: UnitState) => {
    const a = actionsByPlayer[u.owner][u.id]?.action;
    if (a?.type === 'mark') return 2;
    const ws = a?.type === 'shoot' ? shotWeapons(a).map((id) => u.equipment.find((e) => e.id === id)) : [];
    return ws.some((w) => w && EQUIPMENT[w.defId].tags?.includes('dazzle')) ? 1 : 0;
  };
  const order = state.units
    .filter((u) => u.status === 'active')
    .map((u) => ({ u, first: dazzles(u), skill: pilotOf(u).skill, tie: rng.next() }))
    .sort((x, y) => y.first - x.first || y.skill - x.skill || x.tie - y.tie)
    .map((x) => x.u);
  for (const u of order) {
    if (u.status !== 'active') continue;
    const plan = actionsByPlayer[u.owner][u.id] ?? defaultAction();
    const podOrders = Object.entries(plan.pods ?? {}).filter(([, t]) => t?.length);
    const salvo = isShip(u) ? Object.entries(plan.salvo ?? {}).filter(([, t]) => !!t) : [];
    if (bumped.has(u.id)) {
      if (plan.action.type !== 'none' || swapOrders(plan).length || podOrders.length || salvo.length) ctx.events.push({ type: 'actionFail', unit: u.id, reason: '擦撞，無法行動' });
      continue;
    }
    // 戰艦的砲塔：每座各自選目標開火（砲手各自操作，不算連鎖動作）
    for (const [wid, tid] of salvo) {
      if (u.status !== 'active') break;
      const w = readyRanged(u).find((e) => e.id === wid && EQUIPMENT[e.defId].tags?.includes('turret'));
      const t = state.units.find((x) => x.id === tid);
      if (!w) ctx.events.push({ type: 'actionFail', unit: u.id, reason: '砲塔已經損壞' });
      else if (w.ammo !== undefined && w.ammo <= 0) ctx.events.push({ type: 'actionFail', unit: u.id, reason: '砲塔彈藥耗盡' });
      else if (!t || t.status !== 'active') ctx.events.push({ type: 'actionFail', unit: u.id, reason: '目標已失去戰鬥能力' });
      else if (!state.visible[u.owner].includes(t.id)) ctx.events.push({ type: 'actionFail', unit: u.id, reason: '看不到目標' });
      else if (shoot(ctx, turn, u, w, t)) revealed.add(u.id);
      else ctx.events.push({ type: 'actionFail', unit: u.id, reason: `${EQUIPMENT[w.defId].name}：目標不在射界或射程內` });
    }
    // 換武器：每一側的手和同側的武器架交換，那一側的手這回合不能開火（拔出不佔行動的武器除外），另一側照常
    const busy = busyHands(u, plan);
    // 換武器那一側換下來和換上去的武器，這回合都不能開火
    const benched = new Set<string>();
    for (const [hand, equip] of swapOrders(plan)) {
      if (!busy.has(hand)) continue;
      const held = heldItem(u, hand);
      if (held) benched.add(held.id);
      if (equip) benched.add(equip);
    }
    // 兩隻手換成同一件裝備：只換第一隻手（指令檢查也會擋下）
    const taken = new Set<string>();
    for (const [hand, equip] of swapOrders(plan)) {
      if (equip && taken.has(equip)) continue;
      if (equip) taken.add(equip);
      doSwap(ctx, u, hand, equip);
    }
    let actionUsed = false;
    // 指揮炮群：無線的佔這回合的行動，線控的不佔
    let wiredFired = false;
    let usedBy = '';
    if (podOrders.length) {
      if (inGrapple(state, u.id)) ctx.events.push({ type: 'actionFail', unit: u.id, reason: '纏鬥中不能指揮炮群' });
      else {
        const wireless = (id: string) => !psycommuOf(u.equipment.find((e) => e.id === id) ?? { id: '', defId: '', location: 'stowed' })?.wired;
        const orders: Record<string, string[]> = {};
        for (const [id, targets] of podOrders) {
          if (wireless(id) && actionUsed) ctx.events.push({ type: 'actionFail', unit: u.id, reason: `${usedBy}，不能指揮炮群` });
          else orders[id] = targets;
        }
        const r = commandPods(ctx, turn, u, orders);
        if (r.fired) revealed.add(u.id);
        wiredFired = r.wired;
        if (Object.keys(orders).some(wireless)) {
          actionUsed = true;
          usedBy = '指揮感應炮用掉了動作';
        }
      }
    }
    if (plan.action.type === 'none') continue;
    if (inGrapple(state, u.id)) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: '纏鬥中不能射擊、鎖定或用道具' });
      continue;
    }
    if (actionUsed) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: usedBy });
      continue;
    }
    if (doAction(ctx, turn, u, plan, benched)) {
      revealed.add(u.id);
      // 線控炮群和本體同一回合都開火：分心操作，壓力再 +1
      if (wiredFired && plan.action.type === 'shoot') addStress(ctx, u, C.PSYCOMMU_DUAL_STRESS, '同時操作有線臂與本體武器');
    }
  }

  // 所有射擊結算完才結算纏鬥（射進纏鬥的人不會因為順序晚而佔便宜）
  for (const g of [...state.grapples]) {
    const a = unitById(ctx, g.a);
    const b = unitById(ctx, g.b);
    if (a.status !== 'active' || b.status !== 'active') {
      state.grapples = state.grapples.filter((x) => x !== g);
      continue;
    }
    resolveGrapple(ctx, g, a, b, actionsByPlayer[a.owner][a.id]?.grapple, actionsByPlayer[b.owner][b.id]?.grapple);
  }
  // 被摔出、擊退到樓頂邊緣外的機體掉下去
  settleHeights(state, ctx.events);

  // 回合結束：重力圈或水中動能往 0 回正（地面滑行的機體在重力圈不受影響；戰機不低於最低速度）
  const env = state.settings?.environment ?? 'space';
  const decay = env === 'gravity' ? C.GRAVITY_DECAY : env === 'water' ? C.WATER_DECAY : 0;
  if (decay)
    for (const u of state.units) {
      if (u.status !== 'active' || inGrapple(state, u.id) || (env === 'gravity' && CHASSIS[u.chassisId].hover)) continue;
      const min = minSpeedOf(u);
      const m = u.momentum;
      const next = m > 0 ? Math.max(0, m - decay) : Math.min(0, m + decay);
      u.momentum = min > 0 ? Math.max(min, next) : next;
    }

  // 回合結束：防禦彈幕打傷彈幕裡的非戰艦單位（友軍也一樣）
  for (const s of state.units) {
    if (!isShip(s) || !barrageActive(state.units, s)) continue;
    for (const u of state.units) {
      if (u.status !== 'active' || isShip(u) || !inBarrage(s, u.pos, radiusOf(u))) continue;
      if (rng.d100() > C.BARRAGE_HIT_CHANCE) continue;
      ctx.events.push({ type: 'barrage', ship: s.id, unit: u.id });
      dealtBy(ctx, s, () => damageUnit(ctx, u, C.DAMAGE_SCALE, 'scattered'), false);
    }
  }

  // 回合結束：炮群（母機退場就消失；放著炮群壓力 +1）
  podUpkeep(ctx);

  // 回合結束：壓力分級、恢復
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

  state.phase = 'move';
  state.turnInfo = null;
  updateSight(state, revealed);
  // 回合結束：煙霧散掉（散了以後氣球就藏不住了）
  state.obstacles = state.obstacles.filter((o) => o.kind !== 'smoke' || (o.until ?? 0) > state.turn);
  // 回合結束：達陣與據點
  const settings = state.settings ?? DEFAULT_SETTINGS;
  const done = scoreObjectives(state, settings, (text, side) => ctx.events.push({ type: 'objective', side, text }));
  if (state.winner === null && done.goal.length) finish(ctx, settleBoth(state, done.goal), 'goal');
  if (state.winner === null && done.control.length) finish(ctx, settleBoth(state, done.control, state.objectives!.control), 'control');
  if (!checkWinner(ctx, true)) {
    state.turn++;
    // 增援進場
    const arriving = (state.reserves ?? []).filter((r) => r.turn <= state.turn);
    if (arriving.length) {
      state.reserves = (state.reserves ?? []).filter((r) => r.turn > state.turn);
      for (const r of arriving) {
        state.units.push(r.unit);
        ctx.events.push({ type: 'arrive', unit: r.unit.id });
      }
      updateSight(state);
    }
  }
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

function finish(ctx: Ctx, winner: PlayerId | 'draw', reason: WinReason): void {
  ctx.state.winner = winner;
  ctx.state.winReason = reason;
  ctx.events.push({ type: 'gameOver', winner, reason });
}

/**
 * 勝負：一方全滅；斬首（旗艦退場）；擊墜分到門檻（同時到就比分數）；
 * 回合結束時另外檢查回合上限（比據點分再比擊墜分）。達陣與據點在回合結束時另外結算。
 */
function checkWinner(ctx: Ctx, endOfTurn: boolean): boolean {
  const { state } = ctx;
  if (state.winner !== null) return true;
  const s = state.settings ?? DEFAULT_SETTINGS;
  const alive = [0, 1].map((p) => state.units.filter((u) => u.owner === p && u.status === 'active').length + (state.reserves ?? []).filter((r) => r.unit.owner === p).length);
  if (!alive[0] || !alive[1]) {
    finish(ctx, alive[0] === alive[1] ? 'draw' : alive[0] ? 0 : 1, 'annihilation');
    return true;
  }
  if (s.decapitation) {
    const lost = ([0, 1] as PlayerId[]).filter((p) => flagshipOf(state, p)?.status !== 'active');
    if (lost.length) {
      finish(ctx, lost.length === 2 ? byScore(state) : ((1 - lost[0]) as PlayerId), 'decapitation');
      return true;
    }
  }
  if (s.killScore) {
    const hit = ([0, 1] as PlayerId[]).filter((p) => killScoreOf(state, p) >= s.killScore!);
    if (hit.length) {
      finish(ctx, settleBoth(state, hit), 'killScore');
      return true;
    }
  }
  if (endOfTurn && state.turn >= s.turnLimit) {
    finish(ctx, byScore(state, s.control ? state.objectives?.control : undefined), 'turnLimit');
    return true;
  }
  return false;
}

/** 開戰前的部署：雙方暗中擺好，一起公布；沒給的機體留在原本排開的位置 */
export function resolveDeploy(input: GameState, byPlayer: [PlayerDeploy, PlayerDeploy]): TurnResult {
  const state: GameState = structuredClone(input);
  const rng = new Rng(state.rngState);
  const ctx: Ctx = { state, rng, events: [] };
  for (const u of state.units) {
    const d = byPlayer[u.owner][u.id];
    if (!d) continue;
    u.pos = { x: d.x, y: d.y };
    u.facing = d.facing;
    u.momentum = d.momentum;
  }
  state.phase = 'move';
  state.lastSeen = [{}, {}];
  updateSight(state);
  ctx.events.push({ type: 'phase', phase: 'move' });
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

/** 檢查一方的部署：要在自己的部署區、不壓到隊友或大隕石、朝向 45° 的倍數、起始動能 0–2（戰機至少最低速度） */
export function validateDeploy(state: GameState, player: PlayerId, plans: PlayerDeploy): string[] {
  const errors: string[] = [];
  const z = deployZone(player);
  const placed: { id: string; d: DeployPlan; r: number }[] = [];
  for (const u of state.units.filter((x) => x.owner === player)) {
    const d = plans[u.id];
    if (!d) continue;
    const r = radiusOf(u);
    if (![d.x, d.y, d.facing, d.momentum].every(Number.isFinite)) errors.push(`${u.label}：部署資料不正確`);
    else if (d.x < z.x0 || d.x > z.x1 || d.y < z.y0 || d.y > z.y1) errors.push(`${u.label}：要放在自己的部署區`);
    else if (state.obstacles.some((o) => o.kind === 'rock' && Math.hypot(d.x - o.x, d.y - o.y) < o.r + r)) errors.push(`${u.label}：壓到大隕石`);
    else if (state.obstacles.some((o) => o.kind === 'building' && wallPenetration(o, d, r) > 0)) errors.push(`${u.label}：壓到建築`);
    else if (placed.some((q) => Math.hypot(q.d.x - d.x, q.d.y - d.y) < q.r + r + 0.1)) errors.push(`${u.label}：和隊友重疊`);
    if (!wholeDegrees(d.facing / DEG)) errors.push(`${u.label}：朝向要是整數度`);
    const min = minSpeedOf(u);
    if (!Number.isInteger(d.momentum) || d.momentum < Math.min(min, 2) || d.momentum > Math.max(2, min)) errors.push(`${u.label}：起始動能要在 ${Math.min(min, 2)}–${Math.max(2, min)}`);
    placed.push({ id: u.id, d, r });
  }
  return errors;
}

/** 整回合（移動＋動作），測試與批次模擬用；王牌移動用同一份移動指令、不追擊 */
export function resolveTurn(input: GameState, moves: [PlayerMoves, PlayerMoves], actions: [PlayerActions, PlayerActions] = [{}, {}]): TurnResult {
  let r = resolveMovement(input, moves);
  const events = [...r.events];
  const next = (f: (s: GameState) => TurnResult) => {
    r = f(r.state);
    events.push(...r.events);
  };
  while (r.state.winner === null && r.state.phase === 'ace') next((s) => resolveAceMovement(s, moves));
  if (r.state.winner === null && r.state.phase === 'pursuit') next((s) => resolvePursuit(s, [{}, {}]));
  if (r.state.winner === null) next((s) => resolveActions(s, actions));
  return { state: r.state, events };
}

function doSwap(ctx: Ctx, u: UnitState, hand: 'right' | 'left', equipId: string | null) {
  if (!handUsable(u, hand)) return;
  const current = heldItem(u, hand);
  if (current?.id === equipId) return;
  const next = equipId ? u.equipment.find((e) => e.id === equipId && !alwaysReady(e) && equipAlive(u, e)) : null;
  if (equipId && !next) {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '裝備已損壞，無法換上' });
    return;
  }
  // 武器架在哪一側就只能用那一側的手拿（另一隻手拿著的可以換手）
  if (next && next.location !== 'right' && next.location !== 'left' && rackSide(u, next) && rackSide(u, next) !== hand) {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '武器架在另一側，這隻手拿不到' });
    return;
  }
  if (current) {
    current.location = current.home ?? 'stowed';
    current.deployed = false;
  }
  if (next) {
    next.location = hand;
    next.revealed = true;
  }
  ctx.events.push({ type: 'swap', unit: u.id, hand, equip: next?.id ?? null });
}

/** 煙霧彈、欺敵氣球：丟到指定位置 */
function useUtility(ctx: Ctx, u: UnitState, action: Extract<ActionPlan['action'], { type: 'smoke' | 'decoy' }>): boolean {
  const { state } = ctx;
  const item = u.equipment.find((e) => e.id === action.weapon && equipAlive(u, e) && EQUIPMENT[e.defId].utility === action.type);
  if (!item || (item.ammo !== undefined && item.ammo <= 0)) {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: action.type === 'smoke' ? '沒有煙霧彈了' : '沒有氣球了' });
    return false;
  }
  const reach = dist(u.pos, action.at) - radiusOf(u);
  const limit = action.type === 'smoke' ? C.SMOKE_THROW_RANGE : C.DECOY_PLACE_RANGE;
  if (reach > limit || !Number.isFinite(reach)) {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '太遠了' });
    return false;
  }
  if (item.ammo !== undefined) item.ammo--;
  if (action.type === 'smoke') {
    const turns = (state.settings?.environment ?? 'space') === 'space' ? C.SMOKE_TURNS_SPACE : C.SMOKE_TURNS_GRAVITY;
    const n = state.obstacles.filter((o) => o.kind === 'smoke').length;
    state.obstacles.push({ id: `smoke${state.turn}-${u.id}-${n}`, kind: 'smoke', x: action.at.x, y: action.at.y, r: C.SMOKE_RADIUS, until: state.turn + turns - 1 });
    ctx.events.push({ type: 'smoke', unit: u.id, at: { ...action.at }, r: C.SMOKE_RADIUS });
    return false;
  }
  const id = `d${u.owner}-${state.turn}-${(state.decoys ?? []).length}-${u.id}`;
  (state.decoys ??= []).push({ id, owner: u.owner, pos: { ...action.at }, facing: u.facing, chassisId: u.chassisId, parts: structuredClone(u.parts), equipment: structuredClone(u.equipment) });
  ctx.events.push({ type: 'decoy', unit: u.id, decoy: id });
  return false;
}

/** 拿出這件道具（還能用、還有數量）；沒有就記一筆失敗 */
function utilityItem(ctx: Ctx, u: UnitState, weapon: string, kind: 'mine' | 'barricade'): EquipState | null {
  const item = u.equipment.find((e) => e.id === weapon && equipAlive(u, e) && EQUIPMENT[e.defId].utility === kind);
  if (!item || (item.ammo !== undefined && item.ammo <= 0)) {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: kind === 'mine' ? '沒有地雷了' : '沒有路障了' });
    return null;
  }
  return item;
}

/** 埋地雷：在身邊 MINE_LAY_RANGE 以內的地上（在樓頂上埋不了） */
function layMine(ctx: Ctx, u: UnitState, action: Extract<ActionPlan['action'], { type: 'mine' }>): boolean {
  const { state } = ctx;
  const item = utilityItem(ctx, u, action.weapon, 'mine');
  if (!item) return false;
  const fail = (reason: string) => (ctx.events.push({ type: 'actionFail', unit: u.id, reason }), false);
  const reach = dist(u.pos, action.at) - radiusOf(u);
  if (!(reach <= C.MINE_LAY_RANGE)) return fail('太遠了');
  if (u.z) return fail('在高處，埋不了地雷');
  if (!mineSpotOk(state.obstacles, action.at)) return fail('那裡埋不了地雷');
  if (item.ammo !== undefined) item.ammo--;
  const mines = (state.mines ??= []);
  mines.push({ id: `mine${state.turn}-${u.id}-${mines.length}`, owner: u.owner, x: action.at.x, y: action.at.y });
  ctx.events.push({ type: 'mine', unit: u.id, at: { ...action.at } });
  return false;
}

/** 架路障：高 1 層的矮牆，橫擋在自己往 at 的方向上（沿地圖的 x 或 y 軸擺） */
function placeBarricade(ctx: Ctx, u: UnitState, action: Extract<ActionPlan['action'], { type: 'barricade' }>): boolean {
  const { state } = ctx;
  const item = utilityItem(ctx, u, action.weapon, 'barricade');
  if (!item) return false;
  const fail = (reason: string) => (ctx.events.push({ type: 'actionFail', unit: u.id, reason }), false);
  const reach = dist(u.pos, action.at) - radiusOf(u);
  if (!(reach <= C.BARRICADE_RANGE)) return fail('太遠了');
  if (u.z) return fail('在高處，架不了路障');
  const wall = barricadeWall(u.pos, action.at, `bar${state.turn}-${u.id}`);
  const bad = barricadeSpotOk(state.obstacles, state.units, wall);
  if (bad) return fail(bad);
  if (item.ammo !== undefined) item.ammo--;
  state.obstacles.push(wall);
  ctx.events.push({ type: 'barricade', unit: u.id, obstacle: wall.id });
  return false;
}

/** 射擊建築：每件武器各自擲骰，打中的傷害照屬性倍率算進建築；樓層塌了，上面的機體跟著掉下來受傷 */
function shootBuilding(ctx: Ctx, turn: TurnInfo, u: UnitState, weapons: EquipState[], o: Obstacle): boolean {
  const { state } = ctx;
  let fired = false;
  for (const w of weapons) {
    if (!state.obstacles.includes(o)) break;
    const def = EQUIPMENT[w.defId];
    const h = buildingHitChance(u, pilotOf(u).skill, def, o, state.obstacles, CHASSIS[u.chassisId].aim, turn.stance[u.id] === 'melee');
    if (!h) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: `${def.name}：打不到這棟建築` });
      continue;
    }
    const shots = spendRounds(w, def.shots ?? 1);
    if (!shots) continue;
    fired = true;
    let hits = 0;
    for (let i = 0; i < shots; i++) if (ctx.rng.d100() <= h.chance) hits++;
    const before = new Map(state.units.map((x) => [x.id, x.z ?? 0]));
    const r = hits ? damageBuilding(state.obstacles, o, hits * (def.damage ?? C.DAMAGE_SCALE), def.damageType ?? 'kinetic', () => ctx.rng.next()) : { amount: 0, lost: 0, chain: 0, collapsed: false };
    ctx.events.push({ type: 'buildingShot', attacker: u.id, obstacle: o.id, weapon: def.id, shots, hits, chance: h.chance, amount: r.amount, levels: o.levels ?? 0, collapsed: r.collapsed, ...(r.chain ? { chain: r.chain } : {}) });
    if (!r.lost) continue;
    settleHeights(state, ctx.events);
    // 跟著樓塌下來：傷害大多打在腳上，其餘照一般部位表
    for (const v of collapseVictims(state.units, before)) {
      const total = C.COLLAPSE_DAMAGE * v.fell;
      const legs = Math.round(total * C.COLLAPSE_LEGS_SHARE);
      ctx.undirected = true;
      try {
        dealtBy(ctx, u, () => {
          damageUnit(ctx, v.unit, legs, 'focused', v.legs);
          damageUnit(ctx, v.unit, total - legs, 'focused');
        });
      } finally {
        ctx.undirected = false;
      }
    }
  }
  return fired;
}

/** 補給：停在自己的補給點上（動能 0、在地面上），彈藥與推進劑補滿 */
function resupply(ctx: Ctx, u: UnitState): boolean {
  const fail = (reason: string) => (ctx.events.push({ type: 'actionFail', unit: u.id, reason }), false);
  if (!ctx.state.settings?.supply) return fail('這一場沒有補給點');
  if (dist(u.pos, supplyPoint(u.owner)) > C.SUPPLY_RADIUS || u.z) return fail('不在自己的補給點上');
  if (u.momentum !== 0) return fail('要停下來（動能 0）才能補給');
  // 煙幕彈發射器一場只能用一次，補給不補
  for (const e of u.equipment) {
    const max = EQUIPMENT[e.defId].ammo;
    if (max !== undefined && equipAlive(u, e) && (EQUIPMENT[e.defId].utility !== 'screen' || !C.rulesAtLeast(ctx.state, 2))) e.ammo = max;
  }
  u.propellant = u.maxPropellant;
  ctx.events.push({ type: 'resupply', unit: u.id });
  return false;
}

/** 地雷：這一步移動中，敵方的地面機體路線碰到地雷就引爆（傷害打在腳上） */
function triggerMines(ctx: Ctx, from: number): void {
  const { state } = ctx;
  if (!state.mines?.length) return;
  for (const e of ctx.events.slice(from)) {
    if (e.type !== 'move') continue;
    const u = unitById(ctx, e.unit);
    // 在樓頂上、會飛的機體不會踩到
    if (u.status !== 'active' || u.z || minSpeedOf(u) > 0) continue;
    for (const s of e.samples) {
      if (!s) continue;
      const m: Mine | undefined = state.mines.find((x) => x.owner !== u.owner && Math.hypot(x.x - s[0], x.y - s[1]) <= radiusOf(u) + C.MINE_RADIUS);
      if (!m) continue;
      state.mines = state.mines.filter((x) => x !== m);
      ctx.events.push({ type: 'mineBlast', unit: u.id, at: { x: m.x, y: m.y }, mine: m.id });
      const legs = roleParts(u, 'legs').find((p) => !p.destroyed)?.id;
      typed(ctx, 'chemical', () => damageUnit(ctx, u, C.MINE_DAMAGE, 'focused', legs));
      if (u.status !== 'active') break;
    }
  }
}

/** 展開盾：拿在手上的展開盾展開成正面的矮牆；已經展開就收起 */
function doDeploy(ctx: Ctx, u: UnitState, action: Extract<ActionPlan['action'], { type: 'deploy' }>): boolean {
  const e = u.equipment.find((x) => x.id === action.weapon);
  if (!e || !EQUIPMENT[e.defId].deployable || !equipAlive(u, e) || (e.location !== 'right' && e.location !== 'left')) {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '手上沒有能展開的盾' });
    return false;
  }
  e.deployed = !e.deployed;
  ctx.events.push({ type: 'deploy', unit: u.id, equip: e.id, up: e.deployed });
  return false;
}

/** 展開盾：這回合的機動太快（或盾不在手上了）就自動收起 */
function stowIfFast(ctx: Ctx, u: UnitState, plan: MovePlan): void {
  for (const e of u.equipment) {
    if (!e.deployed) continue;
    if (moveSpeed(plan) > C.DEPLOYED_MAX_SPEED || (e.location !== 'right' && e.location !== 'left')) {
      e.deployed = false;
      ctx.events.push({ type: 'deploy', unit: u.id, equip: e.id, up: false });
    }
  }
}

/** 突進／跳劈：衝到目標身邊砍一刀（會暴露位置） */
function doLunge(ctx: Ctx, u: UnitState, action: Extract<ActionPlan['action'], { type: 'lunge' }>, benched: Set<string>): boolean {
  const { state } = ctx;
  const fail = (reason: string) => (ctx.events.push({ type: 'actionFail', unit: u.id, reason }), false);
  const target = state.units.find((x) => x.id === action.target);
  if (!target || target.status !== 'active') return fail('目標已失去戰鬥能力');
  if (!state.visible[u.owner].includes(target.id)) return fail('看不到目標');
  const weapon = readyMelee(u);
  if (weapon && benched.has(weapon.id)) return fail('拿近戰武器的那一側在換武器，不能突進');
  if (inGrapple(state, target.id)) return fail('目標在纏鬥中，衝不進去');
  const r = lungeCheck(state.obstacles, u, target, state.turnInfo?.stance[u.id]);
  if (typeof r === 'string') return fail(r);
  const from = { ...u.pos };
  u.pos = r.to;
  u.facing = Math.atan2(target.pos.y - u.pos.y, target.pos.x - u.pos.x);
  ctx.events.push({ type: 'lunge', unit: u.id, target: target.id, from, to: { ...r.to }, jump: r.jump });
  ctx.events.push({ type: 'reposition', unit: u.id, to: { ...r.to } });
  if (r.jump > 0) {
    if (target.z) u.z = target.z;
    else delete u.z;
    u.momentum = 0;
    ctx.events.push({ type: 'elevate', t: 1, unit: u.id, z: u.z ?? 0, how: 'drop' });
  }
  spendPropellant(ctx, u, C.LUNGE_PROPELLANT);
  addStress(ctx, u, C.LUNGE_STRESS, r.jump > 0 ? '跳劈' : '突進');
  meleeClash(ctx, u, target, 1, false, false, r.jump);
  if (r.jump >= C.JUMP_SLASH_LEG_FROM && u.status === 'active') {
    const legs = Object.values(u.parts).find((p) => p.role === 'legs' && !p.destroyed);
    if (legs) damageUnit(ctx, u, C.DAMAGE_SCALE, 'focused', legs.id);
  }
  return true;
}

/**
 * 標定：掃描正面 ±MARK_ARC_DEG、感測距離內的敵機（不用視線），隨機標定 markCount 台。
 * 被標定的敵機我方一直看得到、射擊命中 +MARK_BONUS，持續到超出標定機的感測距離為止（回合、攻擊都不會消耗）。
 * 不疊加：已經被標定的不會再被挑到；重新標定時，這台原本標的先全部解除再重挑。不會暴露自己的位置
 */
function doMark(ctx: Ctx, u: UnitState, action: Extract<ActionPlan['action'], { type: 'mark' }>): boolean {
  const { state } = ctx;
  const fail = (reason: string) => (ctx.events.push({ type: 'actionFail', unit: u.id, reason }), false);
  if (!u.equipment.some((e) => e.id === action.weapon && equipAlive(u, e) && EQUIPMENT[e.defId].utility === 'mark')) return fail('標定器已損壞');
  if (roleLost(u, 'sensor')) return fail('感測部位損壞，無法標定');
  if (jammed(state.units, u)) return fail('在我方的電子干擾範圍內，標定不了');
  if (chaffed(state.obstacles, null, u.pos)) return fail('在煙霧裡，金屬粉擋住了標定');
  const def = EQUIPMENT[u.equipment.find((e) => e.id === action.weapon)!.defId];
  for (const x of state.units) if (x.mark?.by === u.id) delete x.mark;
  // 在對方電子干擾範圍內的敵機標定不到
  // 在煙霧裡、隔著煙霧的也標定不到（金屬粉）
  // 第 4 版起干擾不再擋標定（改成導引武器命中下降）
  const ecmBlocks = !C.rulesAtLeast(state, 4);
  const pool = state.units.filter((t) => t.owner !== u.owner && t.status === 'active' && !t.mark && !(ecmBlocks && jammed(state.units, t)) && !chaffed(state.obstacles, u.pos, t.pos) && inMarkCone(u, t.pos, radiusOf(u) + radiusOf(t)));
  if (!pool.length) return fail(`正面 ±${C.MARK_ARC_DEG}°、感測距離 ${sensorRange(u)} 格內沒有可以標定的敵機`);
  for (let n = def.markCount ?? C.MARK_COUNT; n > 0 && pool.length; n--) {
    const t = pool.splice(Math.floor(ctx.rng.next() * pool.length), 1)[0];
    t.mark = { by: u.id };
    ctx.events.push({ type: 'mark', unit: u.id, target: t.id });
  }
  updateSight(state);
  return false;
}

/** 回傳 true 表示有開火或鎖定（會暴露位置） */
function doAction(ctx: Ctx, turn: TurnInfo, u: UnitState, plan: ActionPlan, benched: Set<string> = new Set()): boolean {
  const action = plan.action;
  if (action.type === 'none') return false;
  if (action.type === 'smoke' || action.type === 'decoy') return useUtility(ctx, u, action);
  if (action.type === 'mine') return layMine(ctx, u, action);
  if (action.type === 'barricade') return placeBarricade(ctx, u, action);
  if (action.type === 'mark') return doMark(ctx, u, action);
  if (action.type === 'lunge') return doLunge(ctx, u, action, benched);
  if (action.type === 'deploy') return doDeploy(ctx, u, action);
  if (action.type === 'resupply') return resupply(ctx, u);
  // 打到或鎖定的是氣球：氣球破掉，這個動作就浪費了
  // 一起開火的武器：要現在能用，而且不在換武器的那隻手上
  const weapons: EquipState[] = [];
  if (action.type === 'shoot') {
    const ready = readyRanged(u);
    for (const id of shotWeapons(action)) {
      const w = ready.find((e) => e.id === id);
      const def = w && EQUIPMENT[w.defId];
      const name = EQUIPMENT[u.equipment.find((e) => e.id === id)?.defId ?? '']?.name ?? '武器';
      if (benched.has(id)) ctx.events.push({ type: 'actionFail', unit: u.id, reason: `${name}：這一側在換武器，不能開火` });
      else if (!w) ctx.events.push({ type: 'actionFail', unit: u.id, reason: u.equipment.some((e) => e.id === id) ? `${name}：已經損壞或拿不到` : '沒有可用的射擊武器' });
      else if (w.ammo !== undefined && w.ammo <= 0) ctx.events.push({ type: 'actionFail', unit: u.id, reason: `${def!.name}：彈藥耗盡` });
      else weapons.push(w);
    }
    if (!weapons.length) return false;
  }
  // 射擊建築
  const building = ctx.state.obstacles.find((o) => o.id === action.target && o.kind === 'building');
  if (building) {
    if (action.type !== 'shoot') {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: '建築不能鎖定' });
      return false;
    }
    return shootBuilding(ctx, turn, u, weapons, building);
  }
  if ((ctx.state.decoys ?? []).some((d) => d.id === action.target)) {
    for (const w of weapons) spendRounds(w, EQUIPMENT[w.defId].shots ?? 1);
    popDecoy(ctx, action.target, u.id, action.type === 'shoot' ? '被擊中，原來是氣球' : '鎖定後發現是氣球');
    return true;
  }
  // 射擊炮群
  const pod = findPod(ctx.state, action.target);
  if (pod) {
    if (action.type === 'lock' || !podSeen(ctx.state, pod.mother, pod.equip, u.owner)) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: action.type === 'lock' ? '炮群不能鎖定' : '看不到炮群' });
      return false;
    }
    let fired = false;
    for (const w of weapons) {
      if (shootPod(ctx, turn, u, w, pod.mother, pod.equip)) fired = true;
      else ctx.events.push({ type: 'actionFail', unit: u.id, reason: `${EQUIPMENT[w.defId].name}：炮群不在射程內` });
    }
    return fired;
  }
  const target = ctx.state.units.find((x) => x.id === action.target);
  if (!target || target.status !== 'active') {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '目標已失去戰鬥能力' });
    return false;
  }
  if (!ctx.state.visible[u.owner].includes(target.id)) {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '看不到目標' });
    return false;
  }
  if (action.type === 'lock') {
    if (roleLost(u, 'sensor')) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: '感測部位損壞，無法鎖定' });
      return false;
    }
    if (chaffed(ctx.state.obstacles, u.pos, target.pos)) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: '隔著煙霧（金屬粉），鎖定不了' });
      return false;
    }
    const band = hitChance({ attacker: u, attackerSkill: 0, weapon: { id: '', name: '', kind: 'ranged', weight: 0, durability: 0, ranges: { 1: 0, 2: 0, 3: 0 } }, target, targetSkill: null, relSpeed: null, shooterMelee: false });
    if (!band) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: `目標超出鎖定距離（底板邊緣 ${C.RANGE_LIMITS.r3} 格以內才能鎖定）` });
      return false;
    }
    u.lockOn = target.id;
    ctx.events.push({ type: 'lock', unit: u.id, target: target.id });
    return true;
  }
  // 同一個目標：勾選的武器全部開火（各自擲命中，傷害照順序結算）
  let fired = false;
  for (const w of weapons) {
    if (target.status !== 'active') break;
    if (shoot(ctx, turn, u, w, target)) fired = true;
    else ctx.events.push({ type: 'actionFail', unit: u.id, reason: `${EQUIPMENT[w.defId].name}：${needsMark(EQUIPMENT[w.defId]) && !target.mark ? '飛彈、迫擊砲只能打被標定的目標' : lineOfFire(ctx.state.obstacles, u.pos, target.pos, u.z, target.z) === 'blocked' ? '射擊線被擋住' : '目標不在射程或射界內'}` });
  }
  return fired;
}
