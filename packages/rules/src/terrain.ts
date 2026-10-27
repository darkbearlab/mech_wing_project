// 地形：大隕石（擋移動、擋射擊和視線）與隕石群（碎石區，射擊 −20、高速穿越會受傷、裡面的機體難被發現）。
// 地圖以中心點對稱產生，雙方拿到一樣的地形。
import * as C from './config';
import { dist } from './geometry';
import type { Rng } from './rng';
import type { Obstacle, Vec } from './types';

const AVOID_GAP = 2.5;

/** avoid：要空出來的點（例如據點），障礙物離它們至少 AVOID_GAP */
/** 地形設定：大隕石（岩石、建築）與隕石群（森林）各幾對、半徑範圍 */
export const TERRAIN_PROFILES = {
  asteroid: { rocks: C.ROCK_PAIRS, rockR: C.ROCK_RADIUS, fields: C.FIELD_PAIRS, fieldR: C.FIELD_RADIUS },
  forest: { rocks: 1, rockR: [0.8, 1.2] as const, fields: 3, fieldR: [2, 3] as const },
  town: { rocks: 4, rockR: [0.8, 1.4] as const, fields: 0, fieldR: C.FIELD_RADIUS },
};
export type TerrainProfile = keyof typeof TERRAIN_PROFILES;

export function generateObstacles(rng: Rng, avoid: Vec[] = [], profile: TerrainProfile = 'asteroid'): Obstacle[] {
  const T = TERRAIN_PROFILES[profile];
  const M = C.MAP_SIZE;
  const out: Obstacle[] = [];
  const fits = (p: Vec, r: number) =>
    out.every((o) => dist(p, o) > o.r + r + C.OBSTACLE_GAP) && p.x - r > 1 && p.x + r < M - 1 && avoid.every((q) => dist(p, q) > r + AVOID_GAP);
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
  for (let i = 0; i < T.rocks; i++) place('rock', T.rockR[0], T.rockR[1]);
  for (let i = 0; i < T.fields; i++) place('field', T.fieldR[0], T.fieldR[1]);
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

export type Cover = 'clear' | 'field' | 'smoke' | 'blocked';

/** 射擊線：被大隕石擋住、穿過（或目標在）隕石群、或暢通 */
export function lineOfFire(obstacles: Obstacle[], a: Vec, b: Vec): Cover {
  if (obstacles.some((o) => o.kind === 'rock' && segmentHitsCircle(a, b, o, o.r))) return 'blocked';
  // 煙霧：射擊線穿過，或目標在裡面
  if (obstacles.some((o) => o.kind === 'smoke' && (segmentHitsCircle(a, b, o, o.r) || dist(b, o) <= o.r))) return 'smoke';
  if (obstacles.some((o) => o.kind === 'field' && (segmentHitsCircle(a, b, o, o.r) || dist(b, o) <= o.r))) return 'field';
  return 'clear';
}
