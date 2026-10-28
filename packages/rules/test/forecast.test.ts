import { describe, expect, it } from 'vitest';
import { forecastMoves } from '../src/forecast';
import { resolveTurn } from '../src/resolve';
import type { Obstacle } from '../src/types';
import { makeState, plan, rifleX00 } from './helpers';

const bld = (id: string, x: number, y: number, hx: number, hy: number, levels: number): Obstacle => ({ id, kind: 'building', x, y, hx, hy, levels, r: Math.hypot(hx, hy) });

describe('移動預測', () => {
  it('預測撞牆和實際移動一致：擦到一點點也算', () => {
    const st = makeState([{ entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 }]);
    // 牆角只擦到底板邊緣一點點
    st.obstacles = [bld('b1', 7.5, 10 + 0.5 + 0.5 - 0.02, 1, 0.5, 2)];
    const u = st.units[0];
    const p = { [u.id]: plan({ maneuver: 'straight-S-2' }) };
    const w = forecastMoves(st.units, p, st.obstacles);
    const r = resolveTurn(st, [p, {}]);
    const hit = r.events.some((e) => e.type === 'obstacle' && e.unit === u.id);
    expect(hit).toBe(true);
    expect(w.some((x) => x.kind === 'wall' && x.with === 'b1')).toBe(true);
  });

  it('兩台隊友的路線同時交會：預測擦撞；一開始就貼著或只有一台、錯開時間就不算', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 8, y: 6, facingDeg: 90 },
      { entry: rifleX00, owner: 0, x: 6, y: 8, facingDeg: 0 },
    ]);
    const [a, b] = st.units;
    const cross = { [a.id]: plan({ maneuver: 'straight-S-2' }), [b.id]: plan({ maneuver: 'straight-S-2' }) };
    const w = forecastMoves(st.units, cross, st.obstacles).filter((x) => x.kind === 'ally');
    expect(w.map((x) => x.unit).sort()).toEqual([a.id, b.id].sort());
    const r = resolveTurn(st, [cross, {}]);
    expect(r.events.some((e) => e.type === 'contact' && e.result === 'bump')).toBe(true);
    // 一台懸停在旁邊：另一台直直走開，不會碰到
    const apart = { [a.id]: plan({ maneuver: 'hover-S-0' }), [b.id]: plan({ maneuver: 'straight-S-1', stance: 'shoot' }) };
    expect(forecastMoves(st.units, apart, st.obstacles).filter((x) => x.kind === 'ally')).toEqual([]);
  });
});
