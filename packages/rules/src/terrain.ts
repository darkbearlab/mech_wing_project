// 地形：大隕石（擋移動、擋射擊和視線）與隕石群（碎石區，射擊 −20、高速穿越會受傷、裡面的機體難被發現）。
// 地圖以中心點對稱產生，雙方拿到一樣的地形。
import * as C from './config';
import { dist } from './geometry';
import type { Rng } from './rng';
import type { Obstacle, Vec } from './types';

export function generateObstacles(rng: Rng): Obstacle[] {
  const M = C.MAP_SIZE;
  const out: Obstacle[] = [];
  const fits = (p: Vec, r: number) =>
    out.every((o) => dist(p, o) > o.r + r + C.OBSTACLE_GAP) && p.x - r > 1 && p.x + r < M - 1;
  const place = (kind: Obstacle['kind'], rMin: number, rMax: number) => {
    for (let tries = 0; tries < 40; tries++) {
      const r = rng.range(rMin, rMax);
      const p = { x: rng.range(3, M - 3), y: rng.range(C.DEPLOY_CLEAR + r, Math.max(C.DEPLOY_CLEAR + r, M / 2 - 0.5)) };
      const mirror = { x: M - p.x, y: M - p.y };
      if (!fits(p, r) || !fits(mirror, r) || dist(p, mirror) <= 2 * r + C.OBSTACLE_GAP) continue;
      const n = out.length;
      out.push({ id: `o${n}`, kind, x: p.x, y: p.y, r }, { id: `o${n + 1}`, kind, x: mirror.x, y: mirror.y, r });
      return;
    }
  };
  for (let i = 0; i < C.ROCK_PAIRS; i++) place('rock', C.ROCK_RADIUS[0], C.ROCK_RADIUS[1]);
  for (let i = 0; i < C.FIELD_PAIRS; i++) place('field', C.FIELD_RADIUS[0], C.FIELD_RADIUS[1]);
  return out;
}

/** 線段 a→b 與圓是否相交 */
export function segmentHitsCircle(a: Vec, b: Vec, c: Vec, r: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2));
  return Math.hypot(a.x + dx * t - c.x, a.y + dy * t - c.y) < r;
}

export const insideField = (obstacles: Obstacle[], p: Vec) => obstacles.some((o) => o.kind === 'field' && dist(p, o) <= o.r);

export type Cover = 'clear' | 'field' | 'blocked';

/** 射擊線：被大隕石擋住、穿過（或目標在）隕石群、或暢通 */
export function lineOfFire(obstacles: Obstacle[], a: Vec, b: Vec): Cover {
  if (obstacles.some((o) => o.kind === 'rock' && segmentHitsCircle(a, b, o, o.r))) return 'blocked';
  if (obstacles.some((o) => o.kind === 'field' && (segmentHitsCircle(a, b, o, o.r) || dist(b, o) <= o.r))) return 'field';
  return 'clear';
}
