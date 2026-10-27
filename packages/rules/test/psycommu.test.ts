import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONTENT, useContent, validateContent, type ContentPack } from '../src/content';
import * as C from '../src/config';
import { resolveTurn } from '../src/resolve';
import { podProblem, podUpkeep } from '../src/psycommu';
import { Rng } from '../src/rng';
import { handUsable, validateAction, validateMove } from '../src/unit';
import { viewState } from '../src/visibility';
import type { ActionPlan, GameEvent, GameState, MovePlan, PilotDef } from '../src/types';
import type { RosterEntry } from '../src/data';
import { makeState as baseState, rifleX00 } from './helpers';

/** 測試用：不會因為回合上限或擊墜分提早結束 */
const makeState = (...a: Parameters<typeof baseState>): GameState => ({ ...baseState(...a), settings: { killScore: 0, decapitation: false, turnLimit: 99, deploy: 'fixed' } });

const pilot = (id: string, abilities: PilotDef['abilities'], skill = 5): PilotDef => ({ id, name: id, skill, maxStress: 20, recovery: 1, abilities, ...(abilities.includes('newtype') ? { ntSense: 'numb' as const } : {}) });

beforeEach(() => {
  const pack: ContentPack = structuredClone({ ...DEFAULT_CONTENT, version: 'test-psy' });
  pack.pilots['nt'] = pilot('nt', ['newtype']);
  pack.pilots['cyber'] = pilot('cyber', ['cyber_newtype']);
  pack.pilots['oldtype'] = pilot('oldtype', []);
  pack.equipment['bits'] = { id: 'bits', name: '感應炮', kind: 'ranged', mount: 'integrated', weight: 0, durability: 0, damage: 1, shots: 1, mode: 'focused', ranges: { 1: 10, 2: 5 }, psycommu: { count: 4, charge: 2, range: 12, move: 8, evasion: 40 } };
  pack.equipment['wired_arm'] = { id: 'wired_arm', name: '有線臂', kind: 'ranged', mount: 'integrated', weight: 0, durability: 0, damage: 1, shots: 5, mode: 'focused', ranges: { 1: 5, 2: 5 }, blocksHand: true, psycommu: { count: 1, range: 6, move: 6, wired: true } };
  pack.chassis['ELM'] = { ...pack.chassis['X-00'], id: 'ELM', builtIn: [{ defId: 'bits', host: 'torso' }] };
  pack.chassis['ZEO'] = { ...pack.chassis['X-00'], id: 'ZEO', builtIn: [{ defId: 'wired_arm', host: 'rarm' }] };
  useContent(pack);
});
afterEach(() => useContent(DEFAULT_CONTENT));

const of = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
const elmeth = (p = 'nt'): RosterEntry => ({ chassis: 'ELM', pilot: p, equipment: [] });
const zeong = (p = 'nt'): RosterEntry => ({ chassis: 'ZEO', pilot: p, equipment: [['beam_rifle', 'left']] });
const hover = (extra: Partial<MovePlan> = {}): MovePlan => ({ maneuver: 'hover-S-0', stance: 'shoot', facingOffset: 0, limiter: false, ...extra });
const podId = (s: GameState, i = 0) => s.units[i].equipment.find((e) => e.defId === 'bits' || e.defId === 'wired_arm')!.id;

/** 一回合：0 號機照 move／act，其餘懸停不動作 */
function turn(s: GameState, move: Partial<MovePlan> = {}, act: ActionPlan = { action: { type: 'none' } }) {
  const [m] = s.units;
  const moves: [Record<string, MovePlan>, Record<string, MovePlan>] = [{}, {}];
  for (const u of s.units) if (u.status === 'active') moves[u.owner][u.id] = hover(u === m ? move : {});
  return resolveTurn(s, moves, [{ [m.id]: act }, {}]);
}

describe('感應武器', () => {
  it('只有新人類、強化人能用，只能在宇宙用', () => {
    const s = makeState([{ entry: elmeth('oldtype'), owner: 0, x: 10, y: 5, facingDeg: 90 }, { entry: rifleX00, owner: 1, x: 10, y: 15, facingDeg: -90 }]);
    const order = { pods: { [podId(s)]: { to: { x: 10, y: 10 } } } };
    expect(validateMove(s.units[0], hover(order), false)).toHaveLength(1);
    const r = turn(s, order);
    expect(r.state.units[0].equipment.find((e) => e.pod)).toBeUndefined();

    const cy = makeState([{ entry: elmeth('cyber'), owner: 0, x: 10, y: 5, facingDeg: 90 }, { entry: rifleX00, owner: 1, x: 10, y: 15, facingDeg: -90 }]);
    expect(turn(cy, order).state.units[0].equipment.find((e) => e.pod)).toBeDefined();

    const g = makeState([{ entry: elmeth(), owner: 0, x: 10, y: 5, facingDeg: 90 }, { entry: rifleX00, owner: 1, x: 10, y: 15, facingDeg: -90 }]);
    g.settings = { killScore: 0, decapitation: false, turnLimit: 16, deploy: 'fixed', environment: 'gravity' };
    const rg = turn(g, order);
    expect(rg.state.units[0].equipment.find((e) => e.pod)).toBeUndefined();
    expect(of(rg.events, 'actionFail').some((e) => e.reason.includes('宇宙'))).toBe(true);
  });

  it('放出：最多走 move，拉回控制距離內；不參與碰撞', () => {
    const s = makeState([{ entry: elmeth(), owner: 0, x: 10, y: 2, facingDeg: 90 }, { entry: rifleX00, owner: 1, x: 10, y: 6, facingDeg: -90 }]);
    const r = turn(s, { pods: { [podId(s)]: { to: { x: 10, y: 30 } } } });
    const pod = r.state.units[0].equipment.find((e) => e.pod)!.pod!;
    expect(pod.pos.y).toBeCloseTo(10); // 2 + move 8，穿過敵機也不會撞
    expect(pod.charge).toBe(2);
    expect(of(r.events, 'contact')).toHaveLength(0);
  });

  it('無線炮群：指揮佔行動、每次用掉一點能量，從炮群位置開火；用完要收回充能', () => {
    const s = makeState([{ entry: elmeth(), owner: 0, x: 10, y: 2, facingDeg: 90 }, { entry: rifleX00, owner: 1, x: 10, y: 11, facingDeg: -90 }]);
    const id = podId(s);
    let r = turn(s, { pods: { [id]: { to: { x: 10, y: 8 } } } });
    const target = r.state.units[1].id;
    const both: ActionPlan = { action: { type: 'lock', target }, pods: { [id]: [target] } };
    expect(validateAction(r.state.units[0], both)).toHaveLength(1);
    r = turn(r.state, {}, both);
    const shot = of(r.events, 'shot')[0];
    expect(shot.pod).toBe(id);
    expect(shot.from).toEqual({ x: 10, y: 8 });
    expect(shot.shots).toBe(4);
    expect(of(r.events, 'actionFail').some((e) => e.reason === '指揮感應炮用掉了動作')).toBe(true);
    r = turn(r.state, {}, { action: { type: 'none' }, pods: { [id]: [target, target] } });
    expect(of(r.events, 'shot')).toHaveLength(2); // 分給兩個目標（這裡是同一台）：各 2 支
    r = turn(r.state, {}, { action: { type: 'none' }, pods: { [id]: [target] } });
    expect(of(r.events, 'actionFail').some((e) => e.reason.includes('能量用完'))).toBe(true);
    // 收回：下一回合充能，再下一回合才能放出
    r = turn(r.state, { pods: { [id]: { recall: true } } });
    const recalled = r.state.units[0].equipment.find((e) => e.id === id)!;
    expect(recalled.pod).toBeUndefined();
    expect(recalled.readyTurn).toBe(r.state.turn - 1 + 1 + C.PSYCOMMU_RECHARGE_TURNS);
    r = turn(r.state, { pods: { [id]: { to: { x: 10, y: 8 } } } });
    expect(of(r.events, 'actionFail').some((e) => e.reason.includes('充能中'))).toBe(true);
    r = turn(r.state, { pods: { [id]: { to: { x: 10, y: 8 } } } });
    expect(r.state.units[0].equipment.find((e) => e.id === id)!.pod?.charge).toBe(2);
  });

  it('放著炮群每回合壓力 +1；離母機太遠失控；母機退場炮群消失', () => {
    const s = makeState([{ entry: elmeth(), owner: 0, x: 10, y: 2, facingDeg: 90 }, { entry: rifleX00, owner: 1, x: 20, y: 20, facingDeg: -90 }]);
    const id = podId(s);
    const r = turn(s, { pods: { [id]: { to: { x: 10, y: 10 } } } });
    expect(of(r.events, 'stress').some((e) => e.reason === '感應炮負荷' && e.amount === C.PSYCOMMU_STRESS)).toBe(true);
    const u = r.state.units[0];
    u.pos = { x: 10, y: 30 };
    expect(podProblem(u, u.equipment.find((e) => e.id === id)!)).toContain('太遠');
    u.status = 'destroyed';
    podUpkeep({ state: r.state, rng: new Rng(1), events: [] });
    expect(u.equipment.find((e) => e.id === id)!.pod).toBeUndefined();
  });

  it('無線炮群很難看到：一般駕駛只有很近才看得到，新人類感應得到', () => {
    const s = makeState([
      { entry: elmeth(), owner: 0, x: 10, y: 2, facingDeg: 90 },
      { entry: rifleX00, owner: 1, x: 18, y: 6, facingDeg: -90 },
    ]);
    const r = turn(s, { pods: { [podId(s)]: { to: { x: 10, y: 10 } } } });
    const podIn = (st: GameState) => viewState(st, 1).units.find((u) => u.owner === 0)!.equipment.some((e) => e.pod);
    expect(podIn(r.state)).toBe(false);
    r.state.units[1].pos = { x: 12, y: 11 };
    expect(podIn(r.state)).toBe(true);
    r.state.units[1].pos = { x: 18, y: 6 };
    r.state.units[1].pilotId = 'nt';
    expect(podIn(r.state)).toBe(true);
  });

  it('射擊無線炮群：命中一發少一支，全滅就消失', () => {
    const s = makeState([
      { entry: elmeth(), owner: 0, x: 10, y: 2, facingDeg: 90 },
      { entry: { ...rifleX00, pilot: 'nt' }, owner: 1, x: 10, y: 12, facingDeg: -90 },
    ]);
    const id = podId(s);
    let st = turn(s, { pods: { [id]: { to: { x: 10, y: 10 } } } }).state;
    let lost = 0;
    for (let k = 0; k < 120 && st.units[0].equipment.find((e) => e.id === id)!.pod; k++) {
      const [m, gunner] = st.units;
      const r = resolveTurn(st, [{ [m.id]: hover() }, { [gunner.id]: hover() }], [{}, { [gunner.id]: { action: { type: 'shoot', weapon: gunner.equipment[0].id, target: id } } }]);
      lost += of(r.events, 'podHit').length;
      st = r.state;
    }
    expect(lost).toBe(4);
    expect(st.units[0].equipment.find((e) => e.id === id)!.bits).toBe(0);
  });

  it('線控臂：指揮不佔行動，可以和本體武器一起開火（壓力再 +1）；放出去那隻手不能用；被打中打的是手臂', () => {
    const s = makeState([{ entry: zeong(), owner: 0, x: 10, y: 2, facingDeg: 90 }, { entry: rifleX00, owner: 1, x: 10, y: 9, facingDeg: -90 }]);
    const id = podId(s);
    let r = turn(s, { pods: { [id]: { to: { x: 10, y: 6 } } } });
    const z = r.state.units[0];
    expect(handUsable(z, 'right')).toBe(false);
    const target = r.state.units[1].id;
    const rifle = z.equipment.find((e) => e.defId === 'beam_rifle')!.id;
    const act: ActionPlan = { action: { type: 'shoot', weapon: rifle, target }, pods: { [id]: [target] } };
    expect(validateAction(z, act)).toEqual([]);
    r = turn(r.state, {}, act);
    const shots = of(r.events, 'shot');
    expect(shots).toHaveLength(2);
    expect(shots.find((e) => e.pod)!.shots).toBe(5);
    expect(of(r.events, 'stress').some((e) => e.reason.includes('同時操作'))).toBe(true);
    // 收回後手臂恢復（這隻手被手指炮佔住，所以不能握持，但手指炮又能直接開火）
    r = turn(r.state, { pods: { [id]: { recall: true } } }, { action: { type: 'shoot', weapon: id, target } });
    expect(of(r.events, 'shot').some((e) => !e.pod && e.weapon === 'wired_arm')).toBe(true);
  });

  it('射擊線控臂打的是手臂部位，手臂壞了炮群就沒了', () => {
    const s = makeState([
      { entry: zeong(), owner: 0, x: 10, y: 2, facingDeg: 90 },
      { entry: { ...rifleX00, pilot: 'nt' }, owner: 1, x: 10, y: 9, facingDeg: -90 },
    ]);
    const id = podId(s);
    let st = turn(s, { pods: { [id]: { to: { x: 10, y: 6 } } } }).state;
    for (let k = 0; k < 30 && st.units[0].equipment.find((e) => e.id === id)!.pod; k++) {
      const [m, gunner] = st.units;
      st = resolveTurn(st, [{ [m.id]: hover() }, { [gunner.id]: hover() }], [{}, { [gunner.id]: { action: { type: 'shoot', weapon: gunner.equipment[0].id, target: id } } }]).state;
    }
    expect(st.units[0].parts.rarm.destroyed).toBe(true);
    expect(st.units[0].equipment.find((e) => e.id === id)!.pod).toBeUndefined();
  });

  it('資料檢查認得強化人', () => {
    const pack = structuredClone({ ...DEFAULT_CONTENT, version: 'x' });
    pack.pilots['cyber'] = pilot('cyber', ['cyber_newtype']);
    expect(validateContent(pack)).toEqual([]);
  });
});
