import { describe, expect, it } from 'vitest';
import { damageUnit, type Ctx } from '../src/damage';
import { localPose, parseManeuver } from '../src/maneuvers';
import { Match } from '../src/match';
import { resolveTurn } from '../src/resolve';
import { Rng } from '../src/rng';
import { createGame } from '../src/setup';
import type { GameEvent, GameState, PlayerPlans, UnitPlan } from '../src/types';
import { availableManeuvers, defaultPlan, heldItem } from '../src/unit';
import { makeState, plan, rifleX00, saberX00 } from './helpers';

const of = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

function duel(a: UnitPlan, b: UnitPlan, state: GameState) {
  const [ua, ub] = state.units;
  const plans: [PlayerPlans, PlayerPlans] = [{ [ua.id]: a }, { [ub.id]: b }];
  return resolveTurn(state, plans);
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

  it('推進背包破壞後不能用高速模板', () => {
    const u = makeState([{ entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 0 }]).units[0];
    u.parts.pack.destroyed = true;
    expect(availableManeuvers(u).some((m) => m.highSpeed)).toBe(false);
  });
});

describe('同時移動與接觸', () => {
  it('高速對衝且無人突進 → 撞擊，同重量雙方停住', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 10, y: 10, facingDeg: 180 },
    ]);
    const r = duel(plan({ maneuver: 'straight-S-3' }), plan({ maneuver: 'straight-S-3' }), st);
    const c = of(r.events, 'contact')[0];
    expect(c.result).toBe('ram');
    expect(c.vc).toBe(6);
    expect(r.state.units[0].pos.x).toBeLessThan(8);
    expect(of(r.events, 'stress').filter((e) => e.reason === '撞擊').map((e) => e.amount)).toEqual([6, 6]);
  });

  it('同向追上、相對速度低 → 纏鬥', () => {
    const st = makeState([
      { entry: saberX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 6.5, y: 10, facingDeg: 0 },
    ]);
    const r = duel(plan({ maneuver: 'straight-S-4', stance: 'charge' }), plan({ maneuver: 'straight-S-3' }), st);
    expect(of(r.events, 'contact')[0].result).toBe('clinch');
    expect(r.state.grapples).toHaveLength(1);
  });

  it('突進撞上懸停目標 → 一擊脫離，攻擊方走完路徑', () => {
    const st = makeState([
      { entry: saberX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 8.5, y: 10, facingDeg: 180 },
    ]);
    const r = duel(plan({ maneuver: 'straight-S-3', stance: 'charge' }), plan({ maneuver: 'hover-S-0' }), st);
    expect(of(r.events, 'contact')[0].result).toBe('hitrun');
    expect(of(r.events, 'strike')[0].outcome).toBe('hit');
    expect(r.state.grapples).toHaveLength(0);
    expect(r.state.units[0].pos.x).toBeGreaterThan(7.4);
  });

  it('王牌在 Vc 4 仍能一擊脫離；老兵則是撞擊，收刀可降一檔', () => {
    const mk = (pilot: string) =>
      makeState([
        { entry: { ...saberX00, pilot }, owner: 0, x: 5, y: 10, facingDeg: 0 },
        { entry: rifleX00, owner: 1, x: 9, y: 10, facingDeg: 180 },
      ]);
    const charge = plan({ maneuver: 'straight-S-4', stance: 'charge' });
    const hover = plan({ maneuver: 'hover-S-0' });
    expect(of(duel(charge, hover, mk('ace')).events, 'contact')[0].result).toBe('hitrun');
    expect(of(duel(charge, hover, mk('veteran')).events, 'contact')[0].result).toBe('ram');
    const soft = duel({ ...charge, soften: true }, hover, mk('veteran'));
    expect(of(soft.events, 'contact')[0].result).toBe('hitrun');
    expect(of(soft.events, 'stress').some((e) => e.reason === '收刀')).toBe(true);
  });

  it('沒拿刃類武器的突進 → 擦撞，該回合無法行動', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 8.5, y: 10, facingDeg: 180 },
    ]);
    const r = duel(plan({ maneuver: 'straight-S-3', stance: 'charge', action: { type: 'shoot', weapon: st.units[0].equipment[0].id, target: st.units[1].id } }), plan({ maneuver: 'hover-S-0' }), st);
    expect(of(r.events, 'contact')[0].result).toBe('bump');
    expect(of(r.events, 'shot')).toHaveLength(0);
    expect(of(r.events, 'actionFail')[0].reason).toContain('擦撞');
  });

  it('移動結果與機體在陣列中的順序無關', () => {
    const st = createGame(7);
    const plans: [PlayerPlans, PlayerPlans] = [{}, {}];
    for (const u of st.units) plans[u.owner][u.id] = plan({ maneuver: 'straight-S-2', facingOffset: 0 });
    const r1 = resolveTurn(st, plans);
    const reversed = { ...structuredClone(st), units: [...structuredClone(st.units)].reverse() };
    const r2 = resolveTurn(reversed, plans);
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
    const plans = (p: 0 | 1) => Object.fromEntries(m.state.units.filter((u) => u.owner === p).map((u) => [u.id, { ...defaultPlan(u), maneuver: 'straight-S-3', limiter: true }]));
    expect(m.submitPlans(0, plans(0))).toEqual([]);
    expect(m.submitPlans(1, plans(1))).toEqual([]);
    const ev = m.eventsFor(0);
    const enemyIds = new Set(m.state.units.filter((u) => u.owner === 1).map((u) => u.id));
    expect(ev.some((e) => (e.type === 'stress' || e.type === 'propellant') && enemyIds.has(e.unit))).toBe(false);
    expect(ev.some((e) => e.type === 'stress')).toBe(true);
  });

  it('雙方送出後立即結算，有沒有王牌都一樣（不會從等待洩漏）', () => {
    const m = new Match(5);
    m.submitPlans(0, Object.fromEntries(m.state.units.filter((u) => u.owner === 0).map((u) => [u.id, defaultPlan(u)])));
    expect(m.viewFor(1).submitted).toEqual([true, false]);
    expect(m.resolvedCount).toBe(0);
    m.submitPlans(1, Object.fromEntries(m.state.units.filter((u) => u.owner === 1).map((u) => [u.id, defaultPlan(u)])));
    expect(m.resolvedCount).toBe(1);
    expect(m.phase).toBe('planning');
    expect(m.state.turn).toBe(2);
  });
});

describe('整場模擬', () => {
  function randomPlans(st: GameState, rng: Rng): [PlayerPlans, PlayerPlans] {
    const out: [PlayerPlans, PlayerPlans] = [{}, {}];
    const stances = ['normal', 'charge', 'evade'] as const;
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
        const r = resolveTurn(st, plans);
        const again = resolveTurn(st, plans);
        expect(JSON.stringify(again.events)).toBe(JSON.stringify(r.events));
        log.push(JSON.stringify(r.events.length));
        st = r.state;
        expect(st.turn).toBeLessThanOrEqual(12);
      }
    }
  });
});
