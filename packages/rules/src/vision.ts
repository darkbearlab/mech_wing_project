// 視野：每台機體有感測距離（頭部壞了會變短），被大隕石擋住看不到，躲在隕石群裡要很近才發現。
import * as C from './config';
import { DEG, angleDiff, angleOf, dist, sub } from './geometry';
import { buildingBlocks, insideField, segmentHitsCircle } from './terrain';
import { roleLost } from './body';
import type { Obstacle, PartState, Vec } from './types';
import { CHASSIS } from './data';

/** 感測距離：機型有寫就照機型（戰艦的雷達），感測部位壞了減半（但不低於 SENSOR_RANGE_NO_HEAD） */
export const sensorRange = (u: { parts: Record<string, PartState>; chassisId?: string }): number => {
  const base = (u.chassisId && CHASSIS[u.chassisId]?.sensorRange) || C.SENSOR_RANGE;
  return roleLost(u, 'sensor') ? Math.min(base, Math.max(C.SENSOR_RANGE_NO_HEAD, base / 2)) : base;
};

/**
 * 從 from 看不看得到 to（底板邊緣距離；radii 是雙方半徑和）。
 * zFrom、zTo：雙方站的高度（層）；建築擋視線和射擊線一樣，看得到一部分就算看得到（所以視野是雙向的）
 */
export function canSee(obstacles: Obstacle[], from: Vec, range: number, to: Vec, radii = 2 * C.BASE_RADIUS, zFrom = 0, zTo = 0, lookOut?: number): boolean {
  const d = dist(from, to) - radii;
  if (d > range) return false;
  if (insideField(obstacles, to) && d > C.FIELD_SPOT_RANGE) return false;
  // 從隕石群裡往外看（第 5 版起）：只看得到 lookOut
  if (lookOut !== undefined && d > lookOut && insideField(obstacles, from)) return false;
  if (obstacles.some((o) => o.kind === 'rock' && segmentHitsCircle(from, to, o, o.r))) return false;
  return buildingBlocks(obstacles, from, to, zFrom, zTo) !== 'all';
}

/** 標定的範圍：標定機正面 ±MARK_ARC_DEG、感測距離內（底板邊緣距離；不用視線，建築擋不住） */
export function inMarkCone(by: { pos: Vec; facing: number; parts: Record<string, PartState>; chassisId?: string }, to: Vec, radii = 2 * C.BASE_RADIUS): boolean {
  if (dist(by.pos, to) - radii > sensorRange(by)) return false;
  return Math.abs(angleDiff(angleOf(sub(to, by.pos)), by.facing)) <= C.MARK_ARC_DEG * DEG;
}
