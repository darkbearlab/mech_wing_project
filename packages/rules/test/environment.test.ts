import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONTENT, useContent, type ContentPack } from '../src/content';
import { DEFAULT_SETTINGS } from '../src/objectives';
import { resolveTurn } from '../src/resolve';
import { createGame } from '../src/setup';
import { availableManeuvers, dialOf, maneuverCost } from '../src/unit';
import { parseManeuver } from '../src/maneuvers';
import type { PlayerMoves } from '../src/types';
import { makeState, rifleX00 } from './helpers';

beforeEach(() => {
  const pack: ContentPack = structuredClone({ ...DEFAULT_CONTENT, version: 'test-env' });
  pack.chassis['SPACE'] = { ...pack.chassis['X-00'], id: 'SPACE', envs: ['space'] };
  pack.chassis['DOM'] = { ...pack.chassis['X-00'], id: 'DOM', envs: ['gravity'], hover: true };
  useContent(pack);
});
afterEach(() => useContent(DEFAULT_CONTENT));

const hoverAll = (ids: string[]): PlayerMoves => Object.fromEntries(ids.map((id) => [id, { maneuver: 'hover-S-0', stance: 'shoot' as const, facingOffset: 0, limiter: false }]));

describe('側移', () => {
  it('會停的機體都有側移；最大加減速 3 以上多了側移 2；戰機沒有', () => {
    expect(dialOf({ chassisId: 'X-00' })).toEqual(expect.arrayContaining(['slide-L-1', 'slide-R-1']));
    expect(dialOf({ chassisId: 'X-00' })).not.toContain('slide-L-2');
    expect(dialOf({ chassisId: 'X-01' })).toContain('slide-R-2');
    expect(dialOf({ chassisId: 'CF-01' }).some((m) => m.startsWith('slide'))).toBe(false);
  });

  it('只能在動能 ±1 以內用；朝向不變、往旁邊移、動能歸零', () => {
    const s = makeState([{ entry: rifleX00, owner: 0, x: 10, y: 10, facingDeg: 90 }, { entry: rifleX00, owner: 1, x: 20, y: 20, facingDeg: -90 }]);
    const u = s.units[0];
    u.momentum = 2;
    expect(maneuverCost(u, parseManeuver('slide-L-1')).blocked).toMatch(/側移/);
    u.momentum = 1;
    expect(availableManeuvers(u).some((m) => m.id === 'slide-L-1')).toBe(true);
    const moves: [PlayerMoves, PlayerMoves] = [{ [u.id]: { maneuver: 'slide-R-1', stance: 'shoot', facingOffset: 0, limiter: false } }, hoverAll([s.units[1].id])];
    const after = resolveTurn(s, moves).state.units[0];
    expect(after.facing).toBeCloseTo(Math.PI / 2);
    expect(Math.hypot(after.pos.x - 10, after.pos.y - 10)).toBeCloseTo(1);
    expect(after.pos.y).toBeCloseTo(10);
    expect(after.momentum).toBe(0);
  });
});

describe('環境', () => {
  it('重力圈：回合結束動能往 0 回正 1；地面滑行的機體不受影響；不適合的機體最高速度 −1', () => {
    const rosters = [[{ ...rifleX00 }, { ...rifleX00, chassis: 'DOM' }], [{ ...rifleX00, chassis: 'SPACE' }]] as never;
    const s = createGame(3, rosters, { ...DEFAULT_SETTINGS, killScore: undefined, decapitation: false, environment: 'gravity' });
    const [x00, dom, spaceOnly] = s.units;
    expect(spaceOnly.speedCut).toBe(1);
    expect(x00.speedCut).toBeUndefined();
    const top = (u: typeof x00) => Math.max(...dialOf(u).map((m) => parseManeuver(m).speed));
    expect(top(spaceOnly)).toBe(top(x00) - 1);
    const straight = (id: string) => ({ [id]: { maneuver: 'straight-S-3', stance: 'shoot' as const, facingOffset: 0, limiter: false } });
    const r = resolveTurn(s, [{ ...straight(x00.id), ...straight(dom.id) }, straight(spaceOnly.id)]).state;
    expect(r.units[0].momentum).toBe(2);
    expect(r.units[1].momentum).toBe(3);
    // 宇宙：不回正
    const sp = createGame(3, rosters, { ...DEFAULT_SETTINGS, killScore: undefined, decapitation: false, environment: 'space' });
    expect(resolveTurn(sp, [{ ...straight(sp.units[0].id), ...straight(sp.units[1].id) }, straight(sp.units[2].id)]).state.units[0].momentum).toBe(3);
  });
});
