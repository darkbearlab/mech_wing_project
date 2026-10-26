// 視野：每台機體有感測距離（頭部壞了會變短），被大隕石擋住看不到，躲在隕石群裡要很近才發現。
import * as C from './config';
import { dist } from './geometry';
import { insideField, segmentHitsCircle } from './terrain';
import type { Obstacle, PartState, Vec } from './types';

export const sensorRange = (u: { parts: Record<string, PartState> }): number =>
  u.parts.head && !u.parts.head.destroyed ? C.SENSOR_RANGE : C.SENSOR_RANGE_NO_HEAD;

/** 從 from 看不看得到 to（底板邊緣距離） */
export function canSee(obstacles: Obstacle[], from: Vec, range: number, to: Vec): boolean {
  const d = dist(from, to) - 2 * C.BASE_RADIUS;
  if (d > range) return false;
  if (insideField(obstacles, to) && d > C.FIELD_SPOT_RANGE) return false;
  return !obstacles.some((o) => o.kind === 'rock' && segmentHitsCircle(from, to, o, o.r));
}
