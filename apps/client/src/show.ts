// 把一次結算的事件切成一拍一拍的演出：纏鬥、移動（接觸時暫停）、每台機體的動作各一拍。
import type { GameEvent } from '@mech/rules';

export type BeatKind = 'note' | 'phase' | 'grapple' | 'move' | 'shot' | 'lock' | 'mark' | 'lunge' | 'swap' | 'actionFail';

export interface Beat {
  kind: BeatKind;
  events: GameEvent[];
  duration: number;
  /** 移動拍：發生接觸的時間點（0..1），演出時在這些點暫停 */
  pauses: number[];
}

export const MOVE_MS = 2600;
export const PAUSE_MS = 900;
export const SHOT_DELAY = 300;
export const SHOT_GAP = 200;
export const SHOT_FLIGHT = 380;
const FLOAT_MS = 1000;

const HEADS = new Set<GameEvent['type']>(['phase', 'grapple', 'shot', 'lock', 'mark', 'lunge', 'swap', 'actionFail']);

export function buildBeats(events: GameEvent[]): Beat[] {
  const beats: Beat[] = [];
  let cur: Beat = { kind: 'note', events: [], duration: 0, pauses: [] };
  const flush = () => {
    if (cur.events.length) beats.push(cur);
  };
  // 移動中的攀升、落下會比 move 事件先出現（move 事件在移動結算完才送），也算進移動那一拍
  const lastMove = events.map((e) => e.type).lastIndexOf('move');
  for (const [i, e] of events.entries()) {
    if (HEADS.has(e.type)) {
      flush();
      cur = { kind: e.type as BeatKind, events: [e], duration: 0, pauses: [] };
    } else if ((e.type === 'contact' || e.type === 'move' || e.type === 'obstacle' || (e.type === 'elevate' && i < lastMove)) && cur.kind !== 'move') {
      flush();
      cur = { kind: 'move', events: [e], duration: 0, pauses: [] };
    } else {
      cur.events.push(e);
    }
  }
  flush();
  for (const b of beats) {
    b.pauses = [...new Set(b.events.flatMap((e) => ((e.type === 'contact' && e.result !== 'none') || e.type === 'obstacle' ? [e.t] : [])))].sort((x, y) => x - y);
    b.duration = beatDuration(b);
  }
  return beats;
}

function beatDuration(b: Beat): number {
  switch (b.kind) {
    case 'move':
      return MOVE_MS + PAUSE_MS * b.pauses.length;
    case 'grapple':
      return 1700;
    case 'lunge':
      return 2000;
    case 'shot': {
      const e = b.events[0];
      const shots = e.type === 'shot' ? e.shots : 1;
      return shotLandTime(shots - 1) + FLOAT_MS;
    }
    case 'lock':
    case 'mark':
    case 'phase':
      return 900;
    case 'swap':
    case 'actionFail':
      return 800;
    default:
      return b.events.some((e) => e.type === 'gameOver' || e.type === 'status') ? 700 : 0;
  }
}

/** 第 i 發子彈命中（或飛過）目標的時間 */
export const shotLandTime = (i: number) => SHOT_DELAY + i * SHOT_GAP + SHOT_FLIGHT;

/** 移動拍：經過 elapsed 毫秒時的模擬時間 t；若正停在某次接觸上，回傳該接觸與暫停進度 */
export function moveProgress(b: Beat, elapsed: number): { t: number; pause: number | null; pauseP: number } {
  let time = 0;
  let from = 0;
  for (const p of b.pauses) {
    const seg = (p - from) * MOVE_MS;
    if (elapsed < time + seg) return { t: from + (elapsed - time) / MOVE_MS, pause: null, pauseP: 0 };
    time += seg;
    if (elapsed < time + PAUSE_MS) return { t: p, pause: p, pauseP: (elapsed - time) / PAUSE_MS };
    time += PAUSE_MS;
    from = p;
  }
  return { t: Math.min(1, from + (elapsed - time) / MOVE_MS), pause: null, pauseP: 0 };
}
