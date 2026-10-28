import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONTENT, useContent, validateContent, type ContentPack } from '../src/content';
import { corePart } from '../src/body';
import { damageUnit, dealtBy, type Ctx } from '../src/damage';
import { Match } from '../src/match';
import { pursuitOptions, tailing } from '../src/pursuit';
import { Rng } from '../src/rng';
import type { GameEvent, GameState, NtSense, PilotDef, UnitState } from '../src/types';
import { makeState, rifleX00 } from './helpers';

const DEG = Math.PI / 180;
const pilot = (id: string, abilities: PilotDef['abilities'], ntSense?: NtSense): PilotDef => ({ id, name: id, skill: 3, maxStress: 6, recovery: 1, abilities, ...(ntSense ? { ntSense } : {}) });

beforeEach(() => {
  const pack: ContentPack = structuredClone({ ...DEFAULT_CONTENT, version: 'test-ace' });
  for (const p of [
    pilot('ace', ['ace_move']),
    { ...pilot('ace_hi', ['ace_move']), skill: 10 },
    pilot('nt_numb', ['ace_move', 'newtype'], 'numb'),
    pilot('nt_strong', ['newtype'], 'strong'),
    pilot('nt_sensitive', ['newtype'], 'sensitive'),
    pilot('nt_fragile', ['ace_move', 'newtype'], 'fragile'),
  ])
    pack.pilots[p.id] = p;
  pack.chassis['SHIP'] = { ...pack.chassis['X-00'], id: 'SHIP', crew: 'ship' };
  pack.chassis['DRONE'] = { ...pack.chassis['X-00'], id: 'DRONE', crew: 'unmanned' };
  useContent(pack);
});
afterEach(() => useContent(DEFAULT_CONTENT));

const rifle = (pilotId = 'veteran', chassis = 'X-00') => ({ ...rifleX00, pilot: pilotId, chassis });
const hover = { maneuver: 'hover-S-0', stance: 'shoot' as const, facingOffset: 0, limiter: false };
const moveAll = (s: GameState, extra: Record<string, object> = {}) =>
  [0, 1].map((p) => Object.fromEntries(s.units.filter((u) => u.owner === p).map((u) => [u.id, { ...hover, ...(extra[u.id] ?? {}) }]))) as [never, never];

describe('追擊', () => {
  it('咬尾判定：在目標背後 ±45° 而且面向目標 ±45°', () => {
    const t = { pos: { x: 10, y: 13 }, facing: 90 * DEG };
    expect(tailing({ pos: { x: 10, y: 10 }, facing: 90 * DEG }, t)).toBe(true);
    expect(tailing({ pos: { x: 12, y: 11 }, facing: 135 * DEG }, t)).toBe(true);
    expect(tailing({ pos: { x: 13, y: 13 }, facing: 180 * DEG }, t)).toBe(false); // 在側面
    expect(tailing({ pos: { x: 10, y: 10 }, facing: 0 }, t)).toBe(false); // 沒有面向目標
  });

  it('移動後有人咬住背後就進追擊步驟；只有能追擊的一方要下指令，追擊射擊先於動作', () => {
    const m = new Match(1, makeState([
      { entry: rifle(), owner: 0, x: 10, y: 9, facingDeg: 90 },
      { entry: rifle(), owner: 1, x: 10, y: 12, facingDeg: 90 },
    ]));
    m.submitMoves(0, moveAll(m.state)[0]);
    m.submitMoves(1, moveAll(m.state)[1]);
    expect(m.phase).toBe('pursuit');
    const v0 = m.viewFor(0);
    expect(v0.submitted).toEqual([false, true]);
    const opt = v0.pursuit!['p0u0'][0];
    expect(opt.target).toBe('p1u1');
    expect(m.submitPursuits(0, { p0u0: { weapon: opt.weapon, target: 'p1u1' } })).toEqual([]);
    const shot = m.turnResolvedEvents.find((e) => e.type === 'shot');
    expect(shot && shot.type === 'shot' && shot.pursuit).toBe(true);
    expect(m.phase).toBe('action');
  });

  it('太遠（距離帶 3）或纏鬥中不能追擊；不能拿沒列出來的選項', () => {
    const s = makeState([
      { entry: rifle(), owner: 0, x: 10, y: 2, facingDeg: 90 },
      { entry: rifle(), owner: 1, x: 10, y: 12, facingDeg: 90 },
    ]);
    s.turnInfo = { stance: {}, velocity: {}, bumped: [] };
    expect(pursuitOptions(s, s.units[0])).toEqual([]);
    const m = new Match(1, makeState([
      { entry: rifle(), owner: 0, x: 10, y: 9, facingDeg: 90 },
      { entry: rifle(), owner: 1, x: 10, y: 12, facingDeg: 90 },
    ]));
    m.submitMoves(0, moveAll(m.state)[0]);
    m.submitMoves(1, moveAll(m.state)[1]);
    expect(m.submitPursuits(0, { p0u0: { weapon: 'nope', target: 'p1u1' } }).length).toBe(1);
  });

  it('A 咬 B、B 咬 C：咬在最後面的 A 先開火', () => {
    const m = new Match(3, makeState([
      { entry: rifle(), owner: 0, x: 10, y: 5, facingDeg: 90 },
      { entry: rifle(), owner: 1, x: 10, y: 8, facingDeg: 90 },
      { entry: rifle(), owner: 0, x: 10, y: 11, facingDeg: 90 },
    ]));
    m.submitMoves(0, moveAll(m.state)[0]);
    m.submitMoves(1, moveAll(m.state)[1]);
    expect(m.phase).toBe('pursuit');
    const pick = (p: 0 | 1) => Object.fromEntries(Object.entries(m.viewFor(p).pursuit ?? {}).map(([id, o]) => [id, { weapon: o[0].weapon, target: o[0].target }]));
    const b = pick(1);
    expect(Object.keys(b)).toEqual(['p1u1']);
    m.submitPursuits(1, b);
    m.submitPursuits(0, pick(0));
    const shooters = m.turnResolvedEvents.filter((e): e is Extract<GameEvent, { type: 'shot' }> => e.type === 'shot').map((e) => e.attacker);
    expect(shooters[0]).toBe('p0u0');
    expect(shooters.indexOf('p0u0')).toBeLessThan(shooters.indexOf('p1u1') === -1 ? Infinity : shooters.indexOf('p1u1'));
  });
});

describe('王牌移動', () => {
  it('擱置的王牌第一步不動、不付壓力，看完再動；舊人類王牌不付壓力', () => {
    const m = new Match(1, makeState([
      { entry: rifle('ace'), owner: 0, x: 6, y: 4, facingDeg: 90 },
      { entry: rifle('nt_numb'), owner: 1, x: 18, y: 20, facingDeg: -90 },
    ]));
    const [a, b] = moveAll(m.state, { p0u0: { defer: true }, p1u0: { maneuver: 'straight-S-2' } });
    expect(m.submitMoves(0, a)).toEqual([]);
    m.submitMoves(1, b);
    expect(m.phase).toBe('ace');
    const ace = m.state.units[0];
    expect(ace.pos).toEqual({ x: 6, y: 4 });
    expect(m.turnResolvedEvents.some((e) => e.type === 'stress' && e.unit === ace.id && e.reason.includes('王牌'))).toBe(false);
    expect(m.viewFor(0).aceUnits).toEqual(['p0u0']);
    expect(m.viewFor(1).submitted).toEqual([false, true]);
    expect(m.submitMoves(0, { p0u0: { ...hover, maneuver: 'straight-S-2' } })).toEqual([]);
    expect(m.state.units[0].pos.y).toBeCloseTo(6);
    expect(['pursuit', 'action']).toContain(m.phase);
  });

  it('擱置的王牌第一步被碰撞就失去王牌移動', () => {
    const m = new Match(1, makeState([
      { entry: rifle('ace'), owner: 0, x: 10, y: 10, facingDeg: 90 },
      { entry: rifle(), owner: 1, x: 10, y: 13, facingDeg: -90 },
    ]));
    const [ace, foe] = m.state.units;
    const [a, b] = moveAll(m.state, { [ace.id]: { defer: true }, [foe.id]: { maneuver: 'straight-S-3' } });
    m.submitMoves(0, a);
    m.submitMoves(1, b);
    expect(m.turnResolvedEvents.some((e) => e.type === 'contact' && e.result === 'bump')).toBe(true);
    expect(m.phase).not.toBe('ace');
    expect(m.turnResolvedEvents.some((e) => e.type === 'actionFail' && e.unit === ace.id && e.reason.includes('王牌移動'))).toBe(true);
  });

  it('雙方都擱置：技能低的一批先動，技能高的看完再動', () => {
    const m = new Match(1, makeState([
      { entry: rifle('ace'), owner: 0, x: 6, y: 4, facingDeg: 90 },
      { entry: rifle('ace_hi'), owner: 1, x: 18, y: 20, facingDeg: -90 },
    ]));
    const [lo, hi] = m.state.units;
    const [a, b] = moveAll(m.state, { [lo.id]: { defer: true }, [hi.id]: { defer: true } });
    m.submitMoves(0, a);
    m.submitMoves(1, b);
    expect(m.phase).toBe('ace');
    expect(m.viewFor(0).aceUnits).toEqual([lo.id]);
    expect(m.viewFor(1).aceUnits).toEqual([]);
    expect(m.submitMoves(0, { [lo.id]: { ...hover, maneuver: 'straight-S-2' } })).toEqual([]);
    // 技能低的動完了，技能高的才下指令，而且看得到結果
    expect(m.phase).toBe('ace');
    expect(m.viewFor(1).aceUnits).toEqual([hi.id]);
    expect(m.state.units[0].pos.y).toBeCloseTo(6);
    expect(m.submitMoves(1, { [hi.id]: { ...hover, maneuver: 'straight-S-1' } })).toEqual([]);
    expect(['pursuit', 'action']).toContain(m.phase);
    expect(m.state.units[1].pos.y).toBeCloseTo(19);
  });

  it('新人類擱置：對方也有新人類才付 1 壓力', () => {
    for (const [enemy, expected] of [['nt_sensitive', 1], ['veteran', 0]] as const) {
      const m = new Match(1, makeState([
        { entry: rifle('nt_numb'), owner: 0, x: 6, y: 4, facingDeg: 90 },
        { entry: rifle(enemy), owner: 1, x: 18, y: 20, facingDeg: -90 },
      ]));
      const [a, b] = moveAll(m.state, { p0u0: { defer: true } });
      m.submitMoves(0, a);
      m.submitMoves(1, b);
      const paid = m.turnResolvedEvents.filter((e) => e.type === 'stress' && e.unit === 'p0u0' && e.reason.includes('王牌')).reduce((n, e) => n + (e.type === 'stress' ? e.amount : 0), 0);
      expect(paid).toBe(expected);
    }
  });

  it('沒有王牌移動能力不能擱置', () => {
    const m = new Match(1, makeState([
      { entry: rifle('veteran'), owner: 0, x: 6, y: 4, facingDeg: 90 },
      { entry: rifle(), owner: 1, x: 18, y: 20, facingDeg: -90 },
    ]));
    expect(m.submitMoves(0, moveAll(m.state, { p0u0: { defer: true } })[0]).length).toBe(1);
  });
});

describe('新人類擊墜壓力', () => {
  /** killer 擊墜 victim，回傳 killer 的壓力與最大壓力 */
  function kill(killerPilot: string, victimPilot = 'veteran', victimChassis = 'X-00'): { stress: number; max: number; by?: string } {
    const s = makeState([
      { entry: rifle(killerPilot), owner: 0, x: 6, y: 4, facingDeg: 90 },
      { entry: rifle(victimPilot, victimChassis), owner: 1, x: 6, y: 8, facingDeg: -90 },
    ]);
    const [k, v] = s.units as [UnitState, UnitState];
    const ctx: Ctx = { state: s, rng: new Rng(1), events: [] };
    dealtBy(ctx, k, () => damageUnit(ctx, v, 999, 'focused', corePart(v)));
    const st = ctx.events.find((e) => e.type === 'status');
    return { stress: k.stress, max: k.maxStress, by: st?.type === 'status' ? st.by : undefined };
  }

  it('依感受、對方人員與是否新人類累積壓力', () => {
    expect(kill('veteran').stress).toBe(0);
    expect(kill('veteran').by).toBe('p0u0');
    expect(kill('nt_numb').stress).toBe(0);
    expect(kill('nt_strong').stress).toBe(1);
    expect(kill('nt_sensitive').stress).toBe(2);
    expect(kill('nt_fragile')).toMatchObject({ stress: 1, max: 5 });
    expect(kill('nt_numb', 'veteran', 'SHIP').stress).toBe(2);
    expect(kill('nt_sensitive', 'veteran', 'SHIP').stress).toBe(5);
    expect(kill('nt_numb', 'nt_strong').stress).toBe(2);
    expect(kill('nt_sensitive', 'veteran', 'DRONE').stress).toBe(0);
  });

  it('資料檢查：新人類一定要有擊墜感受，非新人類不能有', () => {
    const pack = structuredClone({ ...DEFAULT_CONTENT, version: 'x' });
    pack.pilots['a'] = pilot('a', ['newtype']);
    pack.pilots['b'] = { ...pilot('b', ['ace_move']), ntSense: 'numb' };
    const errs = validateContent(pack);
    expect(errs.some((e) => e.includes('a') && e.includes('擊墜感受'))).toBe(true);
    expect(errs.some((e) => e.includes('b') && e.includes('不是新人類'))).toBe(true);
  });
});
