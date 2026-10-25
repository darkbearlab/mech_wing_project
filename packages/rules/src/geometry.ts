import type { Vec } from './types';

export const DEG = Math.PI / 180;

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const fromAngle = (a: number, l = 1): Vec => ({ x: Math.cos(a) * l, y: Math.sin(a) * l });
export const angleOf = (a: Vec): number => Math.atan2(a.y, a.x);

export function normalize(a: Vec): Vec {
  const l = len(a);
  return l === 0 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function rotate(a: Vec, ang: number): Vec {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

/** 角度差，結果在 (-π, π] */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

export function wrapAngle(a: number): number {
  return angleDiff(a, 0);
}
