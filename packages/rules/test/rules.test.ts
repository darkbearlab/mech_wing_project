import { describe, expect, it } from 'vitest';
import { damageUnit, type Ctx } from '../src/damage';
import { localPose, parseManeuver } from '../src/maneuvers';
import { Match } from '../src/match';
import { aiActions, aiMoves } from '../src/ai';
import { resolveTurn } from '../src/resolve';
import { Rng } from '../src/rng';
import { createGame } from '../src/setup';
import type { GameEvent, GameState } from '../src/types';
import { availableManeuvers, defaultMove, heldItem, validateMove } from '../src/unit';
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
    expect(samples[20][2]).toBeCloseTo(Math.PI / 4, 1);
  });

  it('推進背包破壞後不能用高速模板', () => {
    const u = makeState([{ entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 0 }]).units[0];
    u.parts.pack.destroyed = true;
    expect(availableManeuvers(u).some((m) => m.highSpeed)).toBe(false);
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
    const r = duel(plan({ maneuver: 'straight-S-4', stance: 'charge' }), plan({ maneuver: 'straight-S-3' }), st);
    expect(of(r.events, 'contact')[0].result).toBe('clinch');
    expect(r.state.grapples).toHaveLength(1);
  });

  it('突進：相對速度 3 以上一擊脫離，用骰池比成功數，攻擊方走完路徑', () => {
    const st = makeState([
      { entry: saberX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 8.5, y: 10, facingDeg: 180 },
    ]);
    const r = duel(plan({ maneuver: 'straight-S-3', stance: 'charge' }), plan({ maneuver: 'hover-S-0' }), st);
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

  it('雙方都拿刀時對砍，贏的一方造成傷害，差距越大傷害越高', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const st = makeState(
        [
          { entry: saberX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
          { entry: saberX00, owner: 1, x: 8.5, y: 10, facingDeg: 180 },
        ],
        seed,
      );
      const r = duel(plan({ maneuver: 'straight-S-3', stance: 'charge' }), plan({ maneuver: 'hover-S-0' }), st);
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
    const r = duel(plan({ maneuver: 'straight-S-3', stance: 'charge' }), plan({ maneuver: 'hover-S-0' }), st);
    const c = of(r.events, 'clash')[0];
    expect(c.defense).toBe('none');
    expect(c.winner).toBe(st.units[0].id);
  });

  it('高速出刀加壓力，王牌門檻較高；收刀改成纏鬥', () => {
    const mk = (pilot: string) =>
      makeState([
        { entry: { ...saberX00, pilot }, owner: 0, x: 5, y: 10, facingDeg: 0 },
        { entry: rifleX00, owner: 1, x: 11, y: 10, facingDeg: 180 },
      ]);
    const charge = plan({ maneuver: 'straight-S-4', stance: 'charge' });
    const rush = plan({ maneuver: 'straight-S-2' });
    const speedStress = (events: GameEvent[]) => of(events, 'stress').find((e) => e.reason === '高速出刀')?.amount ?? 0;
    expect(speedStress(duel(charge, rush, mk('veteran')).events)).toBe(2);
    expect(speedStress(duel(charge, rush, mk('ace')).events)).toBe(1);
    const soft = duel({ ...charge, soften: true }, rush, mk('veteran'));
    expect(of(soft.events, 'contact')[0].result).toBe('clinch');
  });

  it('突進但手上沒有近戰武器 → 撞擊，被撞的一方傷得比較重', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 8.5, y: 10, facingDeg: 180 },
    ]);
    const r = duel(plan({ maneuver: 'straight-S-3', stance: 'charge' }), plan({ maneuver: 'hover-S-0' }), st);
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
    const r = duel(plan({ maneuver: 'straight-S-4', stance: 'charge' }), plan({ maneuver: 'straight-S-3' }), st);
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
