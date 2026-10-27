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
  /** 城市：棋盤狀的建築（generateCity） */
  city: { rocks: 0, rockR: C.ROCK_RADIUS, fields: 0, fieldR: C.FIELD_RADIUS },
};
export type TerrainProfile = keyof typeof TERRAIN_PROFILES;

export function generateObstacles(rng: Rng, avoid: Vec[] = [], profile: TerrainProfile = 'asteroid'): Obstacle[] {
  if (profile === 'city') return generateCity(rng, avoid);
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

/** cover：被建築擋住一部分（半掩護） */
export type Cover = 'clear' | 'field' | 'smoke' | 'blocked' | 'cover';

/**
 * 射擊線：被大隕石擋住、被建築完全擋住、穿過（或目標在）隕石群或煙霧、被建築擋住一部分、或暢通。
 * za、zb：射擊方與目標站的高度（層）
 */
export function lineOfFire(obstacles: Obstacle[], a: Vec, b: Vec, za = 0, zb = 0): Cover {
  if (obstacles.some((o) => o.kind === 'rock' && segmentHitsCircle(a, b, o, o.r))) return 'blocked';
  const walls = buildingBlocks(obstacles, a, b, za, zb);
  if (walls === 'all') return 'blocked';
  // 煙霧：射擊線穿過，或目標在裡面
  if (obstacles.some((o) => o.kind === 'smoke' && (segmentHitsCircle(a, b, o, o.r) || dist(b, o) <= o.r))) return 'smoke';
  if (obstacles.some((o) => o.kind === 'field' && (segmentHitsCircle(a, b, o, o.r) || dist(b, o) <= o.r))) return 'field';
  return walls === 'some' ? 'cover' : 'clear';
}

// ---- 建築（沿地圖軸向的長方形，有高度） ----

/** 點在建築的底面裡（margin 往外擴） */
export const inFootprint = (o: Obstacle, p: Vec, margin = 0): boolean => Math.abs(p.x - o.x) <= o.hx! + margin && Math.abs(p.y - o.y) <= o.hy! + margin;

/** 腳下的高度：中心點在哪棟建築的樓頂上，沒有就是地面 0 */
export function supportAt(obstacles: Obstacle[], p: Vec): number {
  let z = 0;
  for (const o of obstacles) if (o.kind === 'building' && inFootprint(o, p)) z = Math.max(z, o.levels!);
  return z;
}

/** 圓（中心 p、半徑 r）伸進建築底面多深；沒碰到是 0 以下 */
export function wallPenetration(o: Obstacle, p: Vec, r: number): number {
  const dx = Math.max(Math.abs(p.x - o.x) - o.hx!, 0);
  const dy = Math.max(Math.abs(p.y - o.y) - o.hy!, 0);
  if (dx === 0 && dy === 0) return r + Math.min(o.hx! - Math.abs(p.x - o.x), o.hy! - Math.abs(p.y - o.y));
  return r - Math.hypot(dx, dy);
}

/** 把圓推到建築外面（沿最近的牆面），回傳新的中心 */
export function pushOutOfWall(o: Obstacle, p: Vec, r: number): Vec {
  const cx = Math.max(o.x - o.hx!, Math.min(o.x + o.hx!, p.x));
  const cy = Math.max(o.y - o.hy!, Math.min(o.y + o.hy!, p.y));
  const inside = cx === p.x && cy === p.y;
  if (!inside) {
    const d = Math.hypot(p.x - cx, p.y - cy) || 1;
    return { x: cx + ((p.x - cx) / d) * (r + 1e-3), y: cy + ((p.y - cy) / d) * (r + 1e-3) };
  }
  // 中心在裡面：往最近的那一面推出去
  const gaps = [o.x + o.hx! - p.x, p.x - (o.x - o.hx!), o.y + o.hy! - p.y, p.y - (o.y - o.hy!)];
  const k = gaps.indexOf(Math.min(...gaps));
  if (k === 0) return { x: o.x + o.hx! + r + 1e-3, y: p.y };
  if (k === 1) return { x: o.x - o.hx! - r - 1e-3, y: p.y };
  if (k === 2) return { x: p.x, y: o.y + o.hy! + r + 1e-3 };
  return { x: p.x, y: o.y - o.hy! - r - 1e-3 };
}

/** 3D 線段（a 高 az → b 高 bz）有沒有穿過建築（底面 × 地面到 levels 的長方體） */
function segmentHitsBox(a: Vec, az: number, b: Vec, bz: number, o: Obstacle): boolean {
  let t0 = 0;
  let t1 = 1;
  const axes: [number, number, number, number][] = [
    [a.x, b.x - a.x, o.x - o.hx!, o.x + o.hx!],
    [a.y, b.y - a.y, o.y - o.hy!, o.y + o.hy!],
    [az, bz - az, 0, o.levels!],
  ];
  for (const [p, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (p <= lo || p >= hi) return false;
      continue;
    }
    let ta = (lo - p) / d;
    let tb = (hi - p) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t1 - t0 <= 1e-6) return false;
  }
  return true;
}

/**
 * 建築擋住多少：從射擊方的槍口看目標身上幾個點（中心、左右兩側、頭、腳），
 * 全部被擋是 all（打不到、看不到），擋住兩個點以上是 some（半掩護），其他是 none
 */
export function buildingBlocks(obstacles: Obstacle[], a: Vec, b: Vec, za = 0, zb = 0): 'none' | 'some' | 'all' {
  const blds = obstacles.filter((o) => o.kind === 'building' && segmentHitsCircle(a, b, o, o.r + C.BASE_RADIUS));
  if (!blds.length) return 'none';
  const muzzle = za + C.MUZZLE_HEIGHT;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const w = C.BASE_RADIUS * 0.8;
  const side = { x: (-(b.y - a.y) / len) * w, y: ((b.x - a.x) / len) * w };
  const mid = zb + C.UNIT_HEIGHT * 0.5;
  const points: [Vec, number][] = [
    [b, mid],
    [{ x: b.x + side.x, y: b.y + side.y }, mid],
    [{ x: b.x - side.x, y: b.y - side.y }, mid],
    [b, zb + C.UNIT_HEIGHT * 0.9],
    [b, zb + C.UNIT_HEIGHT * 0.15],
  ];
  const hit = points.filter(([p, pz]) => blds.some((o) => segmentHitsBox(a, muzzle, p, pz, o))).length;
  // 只擋到腳（或一個點）不算掩護
  return hit === points.length ? 'all' : hit >= 2 ? 'some' : 'none';
}

/**
 * 城市：棋盤狀街道切出街廓，每個街廓蓋一到兩棟 1–4 層的建築，有些街廓是空地（以地圖中心點對稱）。
 * avoid：要空出來的點（據點、開場位置）
 */
export function generateCity(rng: Rng, avoid: Vec[] = []): Obstacle[] {
  const M = C.MAP_SIZE;
  const out: Obstacle[] = [];
  const block = C.CITY_BLOCK;
  const street = C.CITY_STREET;
  const clear = (o: Obstacle) =>
    avoid.every((q) => !inFootprint(o, q, AVOID_GAP)) && out.every((b) => Math.abs(b.x - o.x) >= b.hx! + o.hx! + 0.9 || Math.abs(b.y - o.y) >= b.hy! + o.hy! + 0.9);
  const make = (id: number, x: number, y: number, hx: number, hy: number, levels: number): Obstacle => ({ id: `b${id}`, kind: 'building', x, y, hx, hy, levels, r: Math.hypot(hx, hy) });
  // 只蓋下半張地圖，上半張是對稱的鏡像；中線附近的街廓兩邊各蓋一半
  for (let y0 = C.DEPLOY_CLEAR - 1; y0 < M / 2; y0 += block) {
    for (let x0 = 0; x0 + block <= M + 1e-6; x0 += block) {
      if (rng.next() < C.CITY_EMPTY_CHANCE) continue;
      const w = block - street;
      const split = rng.next() < 0.4;
      const lots = split ? [{ x: x0 + street / 2 + w / 4, hx: w / 4 - 0.2 }, { x: x0 + street / 2 + (3 * w) / 4, hx: w / 4 - 0.2 }] : [{ x: x0 + block / 2, hx: w / 2 }];
      for (const lot of lots) {
        const hy = rng.range(0.8, Math.min(w / 2, M / 2 - y0 - street / 2));
        if (hy < 0.6) continue;
        const y = Math.min(y0 + block / 2, M / 2 - street / 2 - hy);
        const levels = 1 + Math.floor(rng.next() * C.CITY_MAX_LEVELS);
        const a = make(out.length, lot.x, y, lot.hx, hy, levels);
        const m = make(out.length + 1, M - lot.x, M - y, lot.hx, hy, levels);
        if (!clear(a) || !clear(m)) continue;
        out.push(a, m);
      }
    }
  }
  return out;
}
