import { describe, expect, it } from 'vitest';
import { damageUnit, type Ctx } from '../src/damage';
import { localPose, parseManeuver } from '../src/maneuvers';
import { Match } from '../src/match';
import { createGame as newGame, pickRosters } from '../src/setup';
import { lineOfFire } from '../src/terrain';
import { updateSight, viewState, filterEvents } from '../src/visibility';
import * as C from '../src/config';
import { aiActions, aiMoves } from '../src/ai';
import { resolveMovement, resolveTurn } from '../src/resolve';
import { hitChance, relativeSpeed } from '../src/combat';
import { EQUIPMENT } from '../src/data';
import { Rng } from '../src/rng';
import { createGame } from '../src/setup';
import type { GameEvent, GameState } from '../src/types';
import type { RosterEntry } from '../src/data';
import { availableManeuvers, defaultMove, equipAlive, hasFreeHand, heldItem, maneuverCost, readyRanged, validateMove } from '../src/unit';
import { makeState, plan, rifleX00, saberX00, type UnitPlan } from './helpers';

type Plans = Record<string, UnitPlan>;

const of = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

function duel(a: UnitPlan, b: UnitPlan, state: GameState) {
  const [ua, ub] = state.units;
  const plans: [Plans, Plans] = [{ [ua.id]: a }, { [ub.id]: b }];
  return resolveTurn(state, plans, plans);
}

describe('機動模板', () => {
  it('直線、緩轉、急停反轉的終點', () => {
    const s = localPose(parseManeuver('straight-S-3'), 3, 1);
    expect(s.pos.x).toBeCloseTo(3);
    const b = localPose(parseManeuver('bank-R-2'), 2, 1);
    expect(b.facing).toBeCloseTo(Math.PI / 4);
    expect(b.pos.y).toBeGreaterThan(0);
    const k = localPose(parseManeuver('kturn-S-3'), 3, 1);
    expect(k.facing).toBeCloseTo(Math.PI);
  });

  it('只有懸停可以轉身，且轉身在移動過程中完成', () => {
    const u = makeState([{ entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 0 }]).units[0];
    expect(validateMove(u, plan({ maneuver: 'straight-S-2', facingOffset: 90 }), false)).toHaveLength(1);
    expect(validateMove(u, plan({ maneuver: 'hover-S-0', facingOffset: 90 }), false)).toEqual([]);
    const st = makeState([{ entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 0 }]);
    const r = resolveTurn(st, [{ [st.units[0].id]: plan({ maneuver: 'hover-S-0', facingOffset: 90 }) }, {}]);
    expect(r.state.units[0].facing).toBeCloseTo(Math.PI / 2);
    const samples = of(r.events, 'move')[0].samples;
    expect(samples[20]![2]).toBeCloseTo(Math.PI / 4, 1);
  });

  it('推進背包破壞後：一回合只能改變 1 點速度，而且不能耗推進劑', () => {
    const u = makeState([{ entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 0 }]).units[0];
    u.parts.pack.destroyed = true;
    const ids = availableManeuvers(u).map((m) => m.id);
    expect(ids).toContain('straight-S-2');
    expect(ids).toContain('straight-S-3');
    expect(ids).not.toContain('straight-S-4');
    expect(ids).not.toContain('turn-L-1');
  });
});

describe('動能', () => {
  const unitAt = (entry = rifleX00, momentum = 2) => {
    const u = makeState([{ entry, owner: 0, x: 12, y: 12, facingDeg: 0 }]).units[0];
    u.momentum = momentum;
    return u;
  };
  const cost = (u: ReturnType<typeof unitAt>, id: string, limiter = false) => maneuverCost(u, parseManeuver(id), limiter);

  it('推進劑付的是速度變化：維持速度免費，超過基本推力才花', () => {
    const u = unitAt();
    expect(cost(u, 'straight-S-2')).toMatchObject({ dv: 0, propellant: 0, stress: 0 });
    expect(cost(u, 'straight-S-3')).toMatchObject({ dv: 1, propellant: 0 });
    expect(cost(u, 'straight-S-4')).toMatchObject({ dv: 2, propellant: 1, stress: 0 });
    expect(cost(u, 'hover-S-0')).toMatchObject({ dv: 2, propellant: 1 });
  });

  it('動能越高越難煞車：超過最大加減速就不能選，限制器解除可以多 1', () => {
    const u = unitAt(rifleX00, 4);
    expect(cost(u, 'hover-S-0').blocked).not.toBeNull();
    expect(cost(u, 'straight-S-2').blocked).toBeNull();
    const v = unitAt(rifleX00, 3);
    expect(cost(v, 'hover-S-0').blocked).not.toBeNull();
    expect(cost(v, 'hover-S-0', true)).toMatchObject({ blocked: null, stress: 1 + 2 });
  });

  it('高機動型基本推力 2、極限 3；加速超過 2 會加壓力', () => {
    const u = unitAt({ chassis: 'X-01', pilot: 'veteran', equipment: [] }, 2);
    expect(cost(u, 'straight-S-5')).toMatchObject({ dv: 3, propellant: 1, stress: 1, blocked: null });
  });

  it('後退：朝向不變往後走，動能變負；從前進切到後退要付整段速度變化', () => {
    const st = makeState([{ entry: rifleX00, owner: 0, x: 12, y: 12, facingDeg: 0 }]);
    st.units[0].momentum = 1;
    expect(cost(st.units[0], 'reverse-S-1').dv).toBe(2);
    const r = resolveTurn(st, [{ [st.units[0].id]: plan({ maneuver: 'reverse-S-1' }) }, {}]);
    const u = r.state.units[0];
    expect(u.pos.x).toBeCloseTo(11);
    expect(u.facing).toBeCloseTo(0);
    expect(u.momentum).toBe(-1);
  });

  it('動能延續到下回合；被擋停就歸零', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 5, y: 20, facingDeg: 0 },
    ]);
    const r = resolveTurn(st, [{ [st.units[0].id]: plan({ maneuver: 'straight-S-4' }) }, { [st.units[1].id]: plan({ maneuver: 'hover-S-0' }) }]);
    expect(r.state.units[0].momentum).toBe(4);
    expect(r.state.units[1].momentum).toBe(0);
    const bump = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 8.5, y: 10, facingDeg: 180 },
    ]);
    const b = resolveTurn(bump, [{ [bump.units[0].id]: plan({ maneuver: 'straight-S-3' }) }, { [bump.units[1].id]: plan({ maneuver: 'hover-S-0' }) }]);
    expect(of(b.events, 'contact')[0].result).toBe('bump');
    expect(b.state.units[0].momentum).toBe(0);
  });
});

describe('同時移動與接觸', () => {
  it('沒人突進的接觸不管多快都只是擦撞', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 10, y: 10, facingDeg: 180 },
    ]);
    const r = duel(plan({ maneuver: 'straight-S-3' }), plan({ maneuver: 'straight-S-3' }), st);
    const c = of(r.events, 'contact')[0];
    expect(c.vc).toBe(6);
    expect(c.result).toBe('bump');
    expect(of(r.events, 'damage')).toHaveLength(0);
  });

  it('突進：相對速度 2 以下纏鬥', () => {
    const st = makeState([
      { entry: saberX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 6.5, y: 10, facingDeg: 0 },
    ]);
    const r = duel(plan({ maneuver: 'straight-S-4', stance: 'melee' }), plan({ maneuver: 'straight-S-3' }), st);
    expect(of(r.events, 'contact')[0].result).toBe('clinch');
    expect(r.state.grapples).toHaveLength(1);
  });

  it('突進：相對速度 3 以上一擊脫離，用骰池比成功數，攻擊方走完路徑', () => {
    const st = makeState([
      { entry: saberX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 8.5, y: 10, facingDeg: 180 },
    ]);
    const r = duel(plan({ maneuver: 'straight-S-3', stance: 'melee' }), plan({ maneuver: 'hover-S-0' }), st);
    expect(of(r.events, 'contact')[0].result).toBe('hitrun');
    const clash = of(r.events, 'clash')[0];
    // 老兵：2 + 技能 3 + 突進 1
    expect(clash.attDice).toHaveLength(6);
    // 防守方只拿步槍：一半骰數閃避（2 + 3 = 5 → 2）
    expect(clash.defense).toBe('dodge');
    expect(clash.defDice).toHaveLength(2);
    expect(r.state.grapples).toHaveLength(0);
    expect(r.state.units[0].pos.x).toBeGreaterThan(7.4);
  });

  it('雙方都拿刀時比一次骰池，贏的一方造成傷害，差距越大傷害越高', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const st = makeState(
        [
          { entry: saberX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
          { entry: saberX00, owner: 1, x: 8.5, y: 10, facingDeg: 180 },
        ],
        seed,
      );
      const r = duel(plan({ maneuver: 'straight-S-3', stance: 'melee' }), plan({ maneuver: 'hover-S-0' }), st);
      const c = of(r.events, 'clash')[0];
      expect(c.defense).toBe('blade');
      const margin = Math.abs(c.attHits - c.defHits);
      if (c.winner === null) expect(margin).toBe(0);
      else expect(c.damage).toBe(3 + margin - 1);
    }
  });

  it('從背後砍：防守方不擲骰，直接中刀', () => {
    const st = makeState([
      { entry: saberX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: saberX00, owner: 1, x: 8.5, y: 10, facingDeg: 0 },
    ]);
    const r = duel(plan({ maneuver: 'straight-S-3', stance: 'melee' }), plan({ maneuver: 'hover-S-0' }), st);
    const c = of(r.events, 'clash')[0];
    expect(c.defense).toBe('none');
    expect(c.winner).toBe(st.units[0].id);
  });

  it('高速出刀加壓力，王牌門檻較高', () => {
    const mk = (pilot: string) =>
      makeState([
        { entry: { ...saberX00, pilot }, owner: 0, x: 5, y: 10, facingDeg: 0 },
        { entry: rifleX00, owner: 1, x: 11, y: 10, facingDeg: 180 },
      ]);
    const charge = plan({ maneuver: 'straight-S-4', stance: 'melee' });
    const rush = plan({ maneuver: 'straight-S-2' });
    const speedStress = (events: GameEvent[]) => of(events, 'stress').find((e) => e.reason === '高速出刀')?.amount ?? 0;
    expect(speedStress(duel(charge, rush, mk('veteran')).events)).toBe(2);
    expect(speedStress(duel(charge, rush, mk('ace')).events)).toBe(1);

  });

  it('慢速近戰不主動出刀：撞上別人或被高速撞上都是咬住（纏鬥）', () => {
    const st = makeState([
      { entry: saberX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 9, y: 10, facingDeg: 180 },
    ]);
    // A 慢速近戰（速度 2），B 射擊姿態高速衝過來（速度 4）：相對速度 6，但沒有高速的近戰方 → 咬住
    const r = duel(plan({ maneuver: 'straight-S-2', stance: 'melee' }), plan({ maneuver: 'straight-S-4' }), st);
    expect(of(r.events, 'contact')[0].result).toBe('clinch');
    expect(of(r.events, 'clash')).toHaveLength(0);
  });

  it('射擊命中依雙方移動向量差：並行最好打，交錯越快越難打', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 5, y: 14, facingDeg: 0 },
    ]);
    const [a, b] = st.units;
    const chance = (relSpeed: number, shooterMelee = false) =>
      hitChance({ attacker: a, attackerSkill: 3, weapon: EQUIPMENT.beam_rifle, target: b, targetSkill: null, relSpeed, shooterMelee })!.chance;
    expect(chance(0) - chance(3)).toBe(15);
    expect(chance(3) - chance(6)).toBe(20);
    expect(chance(3) - chance(3, true)).toBe(20);
    // 實際結算：雙方都直線 3 並行 → 相對速度 0
    const mv = resolveMovement(st, [{ [a.id]: plan({ maneuver: 'straight-S-3' }) }, { [b.id]: plan({ maneuver: 'straight-S-3' }) }]);
    expect(relativeSpeed(mv.state.turnInfo!.velocity, a.id, b.id)).toBeCloseTo(0);
  });

  it('承受衝擊：對決贏或平手就把一擊脫離拖進纏鬥，輸了照常被砍', () => {
    const heavy: RosterEntry = { chassis: 'X-02', pilot: 'veteran', equipment: [['bazooka', 'right'], ['shield', 'left']] };
    let caught = 0;
    let passed = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const st = makeState(
        [
          { entry: saberX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
          { entry: heavy, owner: 1, x: 8.5, y: 10, facingDeg: 180 },
        ],
        seed,
      );
      const r = duel(plan({ maneuver: 'straight-S-3', stance: 'melee' }), plan({ maneuver: 'hover-S-0', stance: 'melee' }), st);
      const c = of(r.events, 'clash')[0];
      // 重裝老兵：2 + 3 + 承受 1 + 重量差 1
      expect(c.defDice).toHaveLength(7);
      expect(of(r.events, 'stress').some((e) => e.reason === '承受衝擊')).toBe(true);
      if (c.defHits >= c.attHits) {
        expect(c.caught).toBe(true);
        expect(r.state.grapples).toHaveLength(1);
        caught++;
      } else {
        expect(r.state.grapples).toHaveLength(0);
        passed++;
      }
    }
    expect(caught).toBeGreaterThan(0);
    expect(passed).toBeGreaterThan(0);
  });

  it('承受衝擊：被撞擊時傷害減半', () => {
    const mk = (stance: 'shoot' | 'melee') => {
      const st = makeState([
        { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
        { entry: rifleX00, owner: 1, x: 8.5, y: 10, facingDeg: 180 },
      ]);
      const r = duel(plan({ maneuver: 'straight-S-3', stance: 'melee' }), plan({ maneuver: 'hover-S-0', stance }), st);
      return of(r.events, 'damage').filter((e) => e.unit === st.units[1].id).reduce((t, e) => t + e.amount, 0);
    };
    expect(mk('shoot')).toBe(3);
    expect(mk('melee')).toBe(1);
  });

  it('突進但手上沒有近戰武器 → 撞擊，被撞的一方傷得比較重', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 8.5, y: 10, facingDeg: 180 },
    ]);
    const r = duel(plan({ maneuver: 'straight-S-3', stance: 'melee' }), plan({ maneuver: 'hover-S-0' }), st);
    expect(of(r.events, 'contact')[0].result).toBe('ram');
    const dmg = (id: string) => of(r.events, 'damage').filter((e) => e.unit === id).reduce((t, e) => t + e.amount, 0);
    expect(dmg(st.units[1].id)).toBe(3);
    expect(dmg(st.units[0].id)).toBe(1);
  });

  it('沒拿刃類武器的突進慢速接觸 → 纏鬥', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 6.5, y: 10, facingDeg: 0 },
    ]);
    const r = duel(plan({ maneuver: 'straight-S-4', stance: 'melee' }), plan({ maneuver: 'straight-S-3' }), st);
    expect(of(r.events, 'contact')[0].result).toBe('clinch');
  });

  it('移動結果與機體在陣列中的順序無關', () => {
    const st = createGame(7);
    const plans: [Plans, Plans] = [{}, {}];
    for (const u of st.units) plans[u.owner][u.id] = plan({ maneuver: 'straight-S-2', facingOffset: 0 });
    const r1 = resolveTurn(st, plans, plans);
    const reversed = { ...structuredClone(st), units: [...structuredClone(st.units)].reverse() };
    const r2 = resolveTurn(reversed, plans, plans);
    for (const u of r1.state.units) {
      const v = r2.state.units.find((x) => x.id === u.id)!;
      expect(v.pos.x).toBeCloseTo(u.pos.x);
      expect(v.pos.y).toBeCloseTo(u.pos.y);
    }
  });
});

describe('部位破壞', () => {
  const ctxFor = (st: GameState): Ctx => ({ state: st, rng: new Rng(3), events: [] });

  it('打到持盾手臂先由盾牌承受', () => {
    const st = makeState([{ entry: saberX00, owner: 0, x: 5, y: 5, facingDeg: 0 }]);
    const u = st.units[0];
    damageUnit(ctxFor(st), u, 2, 'focused', 'larm');
    const shield = u.equipment.find((e) => e.defId === 'shield')!;
    expect(u.parts[shield.id].damage).toBe(2);
    expect(u.parts.larm.damage).toBe(0);
  });

  it('手臂破壞時手上的武器一併失效；已破壞部位的傷害轉到軀幹', () => {
    const st = makeState([{ entry: saberX00, owner: 0, x: 5, y: 5, facingDeg: 0 }]);
    const u = st.units[0];
    const ctx = ctxFor(st);
    damageUnit(ctx, u, 4, 'focused', 'rarm');
    expect(heldItem(u, 'right')).toBeNull();
    damageUnit(ctx, u, 1, 'focused', 'rarm');
    expect(u.parts.torso.damage).toBe(1);
    expect(u.stress).toBe(1);
  });

  it('軀幹破壞 → 失去戰鬥能力', () => {
    const st = makeState([{ entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 0 }]);
    damageUnit(ctxFor(st), st.units[0], 8, 'focused', 'torso');
    expect(st.units[0].status).toBe('destroyed');
  });
});

describe('纏鬥', () => {
  const grappled = (a = saberX00, b = saberX00) => {
    const st = makeState([
      { entry: a, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: b, owner: 1, x: 6, y: 10, facingDeg: 180 },
    ]);
    st.grapples.push({ a: st.units[0].id, b: st.units[1].id, advantage: null });
    return st;
  };
  const hold = (grapple: UnitPlan['grapple']) => plan({ maneuver: 'straight-S-1', grapple });

  it('斬 vs 架：架方取得優勢，斬方壓力 +1', () => {
    const st = grappled();
    const r = duel(hold('slash'), hold('parry'), st);
    const g = of(r.events, 'grapple')[0];
    expect(g.advantage).toBe(st.units[1].id);
    expect(of(r.events, 'stress').some((e) => e.unit === st.units[0].id && e.reason === '斬擊被架開')).toBe(true);
    expect(r.state.units[0].pos.x).toBe(5); // 纏鬥中不移動
  });

  it('架 vs 抓：抓方投擲成功，纏鬥結束', () => {
    const st = grappled({ chassis: 'X-00', pilot: 'veteran', equipment: [['beam_saber', 'right']] });
    const r = duel(hold('grab'), hold('parry'), st);
    expect(of(r.events, 'grapple')[0].ended).toBe(true);
    expect(r.state.grapples).toHaveLength(0);
    expect(r.state.units[1].pos.x).toBeCloseTo(8); // 底板邊緣相距 2
  });

  it('沒有空手的抓視為推', () => {
    const st = grappled();
    const r = duel(hold('grab'), hold('push'), st);
    expect(of(r.events, 'grapple')[0].choiceA).toBe('push');
  });
});

const moves = (m: Match, p: 0 | 1, patch: Partial<UnitPlan> = {}) =>
  Object.fromEntries(m.state.units.filter((u) => u.owner === p && u.status === 'active').map((u) => [u.id, { ...defaultMove(u), ...patch }]));

describe('資訊不對稱', () => {
  it('對手看不到駕駛、壓力與推進劑', () => {
    const m = new Match(5);
    const enemy = m.viewFor(0).state.units.find((u) => u.owner === 1)!;
    expect(enemy.pilotId).toBeUndefined();
    expect(enemy.stress).toBeUndefined();
    expect(enemy.propellant).toBeUndefined();
    const own = m.viewFor(0).state.units.find((u) => u.owner === 0)!;
    expect(own.pilotId).toBeDefined();
  });

  it('事件紀錄濾掉對手的壓力、推進劑與命中率', () => {
    const m = new Match(5);
    expect(m.submitMoves(0, moves(m, 0, { maneuver: 'straight-S-3', limiter: true }))).toEqual([]);
    expect(m.submitMoves(1, moves(m, 1, { maneuver: 'straight-S-3', limiter: true }))).toEqual([]);
    const ev = m.eventsFor(0);
    const enemyIds = new Set(m.state.units.filter((u) => u.owner === 1).map((u) => u.id));
    expect(ev.some((e) => (e.type === 'stress' || e.type === 'propellant') && enemyIds.has(e.unit))).toBe(false);
    expect(ev.some((e) => e.type === 'stress')).toBe(true);
  });
});

describe('回合分兩步', () => {
  it('雙方送出移動後先結算移動，再等雙方送出動作', () => {
    const m = new Match(5);
    m.submitMoves(0, moves(m, 0));
    expect(m.viewFor(1).submitted).toEqual([true, false]);
    expect(m.resolvedCount).toBe(0);
    m.submitMoves(1, moves(m, 1));
    expect(m.phase).toBe('action');
    expect(m.state.turn).toBe(1);
    expect(m.eventsFor(0).some((e) => e.type === 'move')).toBe(true);
    m.submitActions(0, {});
    m.submitActions(1, {});
    expect(m.phase).toBe('move');
    expect(m.state.turn).toBe(2);
    expect(m.resolvedCount).toBe(2);
  });

  it('動作在移動之後決定：拉近距離後才能射到', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 19, y: 10, facingDeg: 180 },
    ]);
    const m = new Match(1, st);
    const [a, b] = st.units;
    expect(m.submitMoves(0, { [a.id]: plan({ maneuver: 'straight-S-4' }) })).toEqual([]);
    expect(m.submitMoves(1, { [b.id]: plan({ maneuver: 'hover-S-0' }) })).toEqual([]);
    m.submitActions(0, { [a.id]: { action: { type: 'shoot', weapon: a.equipment[0].id, target: b.id } } });
    m.submitActions(1, {});
    const shot = m.eventsFor(0).find((e) => e.type === 'shot');
    expect(shot).toBeDefined();
  });

  it('擦撞的機體會列在 bumped，動作階段不能行動', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 8.5, y: 10, facingDeg: 180 },
    ]);
    const m = new Match(1, st);
    m.submitMoves(0, { [st.units[0].id]: plan({ maneuver: 'straight-S-3' }) });
    m.submitMoves(1, { [st.units[1].id]: plan({ maneuver: 'hover-S-0' }) });
    expect(m.viewFor(1).state.bumped).toContain(st.units[0].id);
  });
});

describe('整場模擬', () => {
  function randomPlans(st: GameState, rng: Rng): [Plans, Plans] {
    const out: [Plans, Plans] = [{}, {}];
    const stances = ['shoot', 'melee', 'shoot'] as const;
    for (const u of st.units) {
      if (u.status !== 'active') continue;
      const opts = availableManeuvers(u);
      const enemies = st.units.filter((x) => x.owner !== u.owner && x.status === 'active');
      const weapon = (['right', 'left'] as const).map((h) => heldItem(u, h)).find((e) => e && e.defId !== 'shield' && e.defId !== 'beam_saber' && e.defId !== 'heat_axe');
      const target = enemies[Math.floor(rng.next() * enemies.length)];
      out[u.owner][u.id] = plan({
        maneuver: opts[Math.floor(rng.next() * opts.length)].id,
        stance: stances[Math.floor(rng.next() * 3)],
        action: weapon && target ? { type: 'shoot', weapon: weapon.id, target: target.id } : { type: 'none' },
        grapple: (['slash', 'parry', 'grab', 'push', 'disengage'] as const)[Math.floor(rng.next() * 5)],
      });
    }
    return out;
  }

  it('100 場隨機對戰都能跑完且結果可重播', () => {
    for (let seed = 1; seed <= 100; seed++) {
      let st = createGame(seed);
      const rng = new Rng(seed * 31);
      const log: string[] = [];
      while (st.winner === null) {
        const plans = randomPlans(st, rng);
        const r = resolveTurn(st, plans, plans);
        const again = resolveTurn(st, plans, plans);
        expect(JSON.stringify(again.events)).toBe(JSON.stringify(r.events));
        log.push(JSON.stringify(r.events.length));
        st = r.state;
        expect(st.turn).toBeLessThanOrEqual(12);
      }
    }
  });
});

describe('勝負與 AI', () => {
  it('快速勝負：先失去一台機體（飛出地圖也算）的一方輸', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 23, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 5, y: 20, facingDeg: 0 },
    ]);
    const r = resolveTurn(st, [{ [st.units[0].id]: plan({ maneuver: 'straight-S-3' }) }, {}]);
    expect(r.state.units[0].status).toBe('withdrawn');
    expect(r.state.winner).toBe(1);
  });

  it('AI 對 AI：指令都合法，而且會打完', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const m = new Match(seed);
      const rng = new Rng(seed * 13);
      let guard = 0;
      while (m.phase !== 'over' && guard++ < 40) {
        for (const p of [0, 1] as const) {
          const v = m.viewFor(p);
          const errors = m.phase === 'move' ? m.submitMoves(p, aiMoves(v, rng)) : m.submitActions(p, aiActions(v, rng));
          expect(errors).toEqual([]);
        }
        // 飛出地圖只能是被甩開或撞開，不能是自己開出去
        const ev = m.turnResolvedEvents;
        for (const e of ev) if (e.type === 'status' && e.status === 'withdrawn') expect(ev.some((x) => (x.type === 'reposition' || x.type === 'knockback') && x.unit === e.unit)).toBe(true);
      }
      expect(m.phase).toBe('over');
    }
  });
});

describe('地形與視野', () => {
  it('地形以中心點對稱，而且不壓到部署區', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const st = newGame(seed);
      expect(st.obstacles.length).toBeGreaterThanOrEqual(2);
      for (const o of st.obstacles) {
        expect(o.y - o.r).toBeGreaterThan(3);
        expect(o.y + o.r).toBeLessThan(C.MAP_SIZE - 3);
        expect(st.obstacles.some((m) => m.kind === o.kind && Math.abs(m.x - (C.MAP_SIZE - o.x)) < 1e-9 && Math.abs(m.y - (C.MAP_SIZE - o.y)) < 1e-9)).toBe(true);
      }
    }
  });

  it('撞上大隕石：停住、擦撞不能行動、速度超過 2 的部分化為傷害、動能歸零', () => {
    const st = makeState([{ entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 }]);
    st.obstacles = [{ id: 'o0', kind: 'rock', x: 9, y: 10, r: 1 }];
    const r = resolveMovement(st, [{ [st.units[0].id]: plan({ maneuver: 'straight-S-4' }) }, {}]);
    const hit = of(r.events, 'obstacle')[0];
    expect(hit.damage).toBe(2);
    expect(r.state.units[0].pos.x).toBeLessThan(7.6);
    expect(r.state.units[0].momentum).toBe(0);
    expect(r.state.turnInfo!.bumped).toContain(st.units[0].id);
  });

  it('射擊線：大隕石擋住打不到，隕石群命中 −20', () => {
    const obstacles = [
      { id: 'o0', kind: 'rock' as const, x: 10, y: 10, r: 1 },
      { id: 'o1', kind: 'field' as const, x: 10, y: 14, r: 1.5 },
    ];
    expect(lineOfFire(obstacles, { x: 6, y: 10 }, { x: 14, y: 10 })).toBe('blocked');
    expect(lineOfFire(obstacles, { x: 6, y: 14 }, { x: 14, y: 14 })).toBe('field');
    expect(lineOfFire(obstacles, { x: 6, y: 18 }, { x: 14, y: 18 })).toBe('clear');
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 5, y: 14, facingDeg: 0 },
    ]);
    const [a, b] = st.units;
    const base = { attacker: a, attackerSkill: 3, weapon: EQUIPMENT.beam_rifle, target: b, targetSkill: null, relSpeed: 3, shooterMelee: false };
    expect(hitChance({ ...base, cover: 'clear' })!.chance - hitChance({ ...base, cover: 'field' })!.chance).toBe(20);
    expect(hitChance({ ...base, cover: 'blocked' })).toBeNull();
  });

  it('視野：太遠或被隕石擋住就看不到，只剩最後目擊的殘影；不能對看不到的目標開火', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 90 },
      { entry: rifleX00, owner: 1, x: 5, y: 20, facingDeg: 270 },
    ]);
    const [a, b] = st.units;
    st.visible = [[], []];
    st.lastSeen[0][b.id] = { turn: 0, pos: { x: 5, y: 22 }, facing: 0, momentum: 2, parts: structuredClone(b.parts), equipment: [], status: 'active' };
    updateSight(st);
    expect(st.visible[0]).not.toContain(b.id);
    const ghost = viewState(st, 0).units.find((u) => u.id === b.id)!;
    expect(ghost.hidden).toBe(true);
    expect(ghost.pos.y).toBe(22);
    const m = new Match(1, st);
    m.submitMoves(0, { [a.id]: plan({ maneuver: 'hover-S-0' }) });
    m.submitMoves(1, { [b.id]: plan({ maneuver: 'hover-S-0' }) });
    m.submitActions(0, { [a.id]: { action: { type: 'shoot', weapon: a.equipment[0].id, target: b.id } } });
    m.submitActions(1, {});
    expect(m.eventsFor(0).some((e) => e.type === 'actionFail' && e.reason === '看不到目標')).toBe(true);
  });

  it('躲在隕石群裡要很近才看得到；開火會暴露位置', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 90 },
      { entry: rifleX00, owner: 1, x: 5, y: 12, facingDeg: 270 },
    ]);
    st.obstacles = [{ id: 'f', kind: 'field', x: 5, y: 12, r: 2 }];
    updateSight(st);
    expect(st.visible[0]).toHaveLength(0);
    expect(st.visible[1]).toHaveLength(1);
    updateSight(st, new Set([st.units[1].id]));
    expect(st.visible[0]).toContain(st.units[1].id);
  });

  it('移動中看不到的那幾段，敵機的取樣會被遮掉', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 3, y: 3, facingDeg: 90 },
      { entry: rifleX00, owner: 1, x: 20, y: 6, facingDeg: 90 },
    ]);
    const r = resolveMovement(st, [{ [st.units[0].id]: plan({ maneuver: 'hover-S-0' }) }, { [st.units[1].id]: plan({ maneuver: 'straight-S-4' }) }]);
    const seen = filterEvents(r.events, r.state, 0).find((e) => e.type === 'move' && e.unit === st.units[1].id);
    expect(seen && seen.type === 'move' && seen.samples.every((x) => x === null)).toBe(true);
  });

  it('隨機陣容依種子固定，雙方各三台', () => {
    const [a, b] = pickRosters(42);
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    expect(JSON.stringify(pickRosters(42))).toBe(JSON.stringify([a, b]));
  });
});

describe('不需要準備的武器', () => {
  const x04: RosterEntry = { chassis: 'X-04', pilot: 'veteran', equipment: [['shoulder_cannon', 'mount', 'torso'], ['missile_pod', 'mount', 'legs'], ['beam_rifle', 'right'], ['shield', 'left']] };
  const x05: RosterEntry = { chassis: 'X-05', pilot: 'veteran', equipment: [] };
  const byDef = (u: GameState['units'][number], defId: string) => u.equipment.find((e) => e.defId === defId)!;
  const shootTurn = (st: GameState, weapon: string) => {
    const [a, b] = st.units;
    const m = new Match(3, st);
    m.submitMoves(0, { [a.id]: plan({ maneuver: 'hover-S-0' }) });
    m.submitMoves(1, { [b.id]: plan({ maneuver: 'hover-S-0' }) });
    m.submitActions(0, { [a.id]: { action: { type: 'shoot', weapon, target: b.id } } });
    m.submitActions(1, {});
    return m;
  };

  it('外掛武裝是命中表裡的部位；內建武裝不是，但都不用拿就能開火', () => {
    const u = makeState([{ entry: x04, owner: 0, x: 5, y: 5, facingDeg: 0 }]).units[0];
    expect(u.parts[byDef(u, 'shoulder_cannon').id]).toBeDefined();
    expect(u.parts[byDef(u, 'head_vulcan').id]).toBeUndefined();
    expect(readyRanged(u).map((e) => e.defId).sort()).toEqual(['beam_rifle', 'head_vulcan', 'missile_pod', 'shoulder_cannon']);
  });

  it('宿主部位破壞：外掛的一起掉落，內建的一起失效', () => {
    const st = makeState([{ entry: x04, owner: 0, x: 5, y: 5, facingDeg: 0 }]);
    const u = st.units[0];
    const ctx: Ctx = { state: st, rng: new Rng(1), events: [] };
    damageUnit(ctx, u, 6, 'focused', 'legs');
    expect(u.parts[byDef(u, 'missile_pod').id].destroyed).toBe(true);
    damageUnit(ctx, u, 3, 'focused', 'head');
    expect(equipAlive(u, byDef(u, 'head_vulcan'))).toBe(false);
    expect(readyRanged(u).map((e) => e.defId).sort()).toEqual(['beam_rifle', 'shoulder_cannon']);
  });

  it('固定射界外打不到；大型外掛砲不能零距離', () => {
    const st = makeState([
      { entry: x04, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 5, y: 15, facingDeg: 0 },
    ]);
    const [a, b] = st.units;
    const base = { attacker: a, attackerSkill: 3, target: b, targetSkill: null, relSpeed: 3, shooterMelee: false };
    expect(hitChance({ ...base, weapon: EQUIPMENT.shoulder_cannon })).toBeNull();
    expect(hitChance({ ...base, weapon: EQUIPMENT.beam_rifle })).not.toBeNull();
    b.pos = { x: 6, y: 10 };
    expect(hitChance({ ...base, weapon: EQUIPMENT.shoulder_cannon })).toBeNull();
  });

  it('彈數：飛彈莢艙打兩次就沒彈', () => {
    const st = makeState([
      { entry: x04, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 10, y: 10, facingDeg: 180 },
    ]);
    const pod = byDef(st.units[0], 'missile_pod').id;
    let m = shootTurn(st, pod);
    m = shootTurn(m.state, pod);
    expect(m.state.units[0].equipment.find((e) => e.id === pod)!.ammo).toBe(0);
    m = shootTurn(m.state, pod);
    expect(m.eventsFor(0).some((e) => e.type === 'actionFail' && e.reason === '彈藥耗盡')).toBe(true);
  });

  it('手指光束砲的手完全不能握持', () => {
    const st = makeState([{ entry: x05, owner: 0, x: 5, y: 5, facingDeg: 0 }]);
    const u = st.units[0];
    expect(hasFreeHand(u)).toBe(false);
    expect(heldItem(u, 'right')).toBeNull();
    expect(readyRanged(u).map((e) => e.defId).sort()).toEqual(['finger_beam', 'finger_beam', 'head_vulcan', 'mega_beam']);
  });

  it('內藏武器：拔出不佔行動，拔出前對手看不到', () => {
    const sazabi: RosterEntry = { chassis: 'X-01', pilot: 'recruit', equipment: [['machine_gun', 'right'], ['arm_saber', 'housed', 'larm']] };
    const st = makeState([
      { entry: sazabi, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 8, y: 10, facingDeg: 180 },
    ]);
    const [a, b] = st.units;
    const saber = byDef(a, 'arm_saber');
    expect(viewState(st, 1).units.find((u) => u.id === a.id)!.equipment.some((e) => e.defId === 'arm_saber')).toBe(false);
    const m = new Match(4, st);
    m.submitMoves(0, { [a.id]: plan({ maneuver: 'hover-S-0' }) });
    m.submitMoves(1, { [b.id]: plan({ maneuver: 'hover-S-0' }) });
    m.submitActions(0, { [a.id]: { swap: { hand: 'left', equip: saber.id }, action: { type: 'shoot', weapon: byDef(a, 'machine_gun').id, target: b.id } } });
    m.submitActions(1, {});
    const ev = m.eventsFor(0);
    expect(ev.some((e) => e.type === 'swap')).toBe(true);
    expect(ev.some((e) => e.type === 'shot')).toBe(true);
    expect(viewState(m.state, 1).units.find((u) => u.id === a.id)!.equipment.some((e) => e.defId === 'arm_saber')).toBe(true);
    // 拿在手上的內藏武器沒有自己的部位：手臂被打爆時跟著失效，不會出錯
    const ctx: Ctx = { state: m.state, rng: new Rng(2), events: [] };
    const after = m.state.units[0];
    damageUnit(ctx, after, 3, 'focused', 'larm');
    expect(equipAlive(after, byDef(after, 'arm_saber'))).toBe(false);
  });
});
