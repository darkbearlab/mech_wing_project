// 移動預測：照自己這一方送出的機動，先算出會不會撞牆、撞隕石、開出地圖、和隊友擦撞。
// 只看自己這一方（敵機怎麼走看不到）；隊友沒給機動的當作原地不動。網頁和文字座位共用。
import * as C from './config';
import { radiusOf } from './body';
import { worldPose } from './maneuvers';
import { buildPath } from './movement';
import { coastManeuver } from './jump';
import { wallPenetration } from './terrain';
import type { MovePlan, Obstacle, Vec } from './types';

export interface MoveWarning {
  unit: string;
  kind: 'wall' | 'rock' | 'ally' | 'offmap';
  /** 撞到的建築、隕石或隊友 */
  with?: string;
  /** 在移動的哪個時間點（0..1） */
  t: number;
  at: Vec;
}

interface Mover {
  id: string;
  pos: Vec;
  facing: number;
  momentum?: number;
  chassisId: string;
  z?: number;
}

// 和實際移動同樣的取樣步數，預測才不會多報或漏報
const STEPS = C.MOVE_STEPS;

/** 一條路徑在時間 t 的位置（沒有機動、擱置或纏鬥中就是原地） */
function track(u: Mover, plan: MovePlan | undefined): (t: number) => Vec {
  if (!plan || plan.defer) return () => u.pos;
  // 噴射：預測只看滑行那一段（跳起來在空中不會撞）
  const path = buildPath(u, plan.jump ? { ...plan, maneuver: coastManeuver(u as never) } : plan);
  return (t) => worldPose(path, t).pos;
}

/** 每台第一次撞到的東西（撞牆、隕石、出地圖），加上每一對第一次碰到的隊友 */
export function forecastMoves(units: Mover[], plans: Record<string, MovePlan | undefined>, obstacles: Obstacle[]): MoveWarning[] {
  const out: MoveWarning[] = [];
  const tracks = units.map((u) => ({ u, at: track(u, plans[u.id]), moving: !!plans[u.id] && !plans[u.id]!.defer }));
  for (const { u, at, moving } of tracks) {
    // 攀升的機體撞牆是為了爬上去，不算
    if (!moving || plans[u.id]?.climb) continue;
    const r = radiusOf(u);
    const buildings = obstacles.filter((o) => o.kind === 'building');
    const rocks = obstacles.filter((o) => o.kind === 'rock');
    // 高度照實際移動追蹤：底板完全離開樓頂就掉到下面，之後撞上比所在高度高的牆（跨街、下到矮樓也算）
    let z = u.z ?? 0;
    let prev = u.pos;
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const p = at(t);
      const wall = buildings.find((o) => o.levels! > z && wallPenetration(o, p, r) > 1e-6 && wallPenetration(o, p, r) > wallPenetration(o, prev, r) + 1e-6);
      prev = p;
      if (z && !wall) z = buildings.reduce((best, o) => (o.levels! <= z && wallPenetration(o, p, r) > 0 ? Math.max(best, o.levels!) : best), 0);
      const rock = rocks.find((o) => Math.hypot(p.x - o.x, p.y - o.y) < o.r + r);
      const off = p.x < 0 || p.y < 0 || p.x > C.MAP_SIZE || p.y > C.MAP_SIZE;
      if (wall || rock || off) {
        out.push({ unit: u.id, kind: wall ? 'wall' : rock ? 'rock' : 'offmap', with: wall?.id ?? rock?.id, t, at: p });
        break;
      }
    }
  }
  // 隊友：同一個時間點底板重疊（一開始就貼著的不算）
  for (let a = 0; a < tracks.length; a++)
    for (let b = a + 1; b < tracks.length; b++) {
      const A = tracks[a];
      const B = tracks[b];
      if (!A.moving && !B.moving) continue;
      // 一高一低（樓頂上和地面）不會碰到
      if ((A.u.z ?? 0) !== (B.u.z ?? 0)) continue;
      const reach = radiusOf(A.u) + radiusOf(B.u);
      const start = Math.hypot(A.u.pos.x - B.u.pos.x, A.u.pos.y - B.u.pos.y);
      if (start < reach) continue;
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS;
        const p = A.at(t);
        const q = B.at(t);
        if (Math.hypot(p.x - q.x, p.y - q.y) < reach) {
          const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
          out.push({ unit: A.u.id, kind: 'ally', with: B.u.id, t, at: mid }, { unit: B.u.id, kind: 'ally', with: A.u.id, t, at: mid });
          break;
        }
      }
    }
  return out;
}

/** 預測的文字（label：機體 id 換成名稱） */
export function warningText(w: MoveWarning, label: (id: string) => string = (id) => id): string {
  if (w.kind === 'ally') return `會和隊友 ${label(w.with!)} 擦撞（雙方停住、這回合不能行動）`;
  if (w.kind === 'wall') return `會撞上建築 ${w.with}（停下、受衝擊）`;
  if (w.kind === 'rock') return `路徑會擦到大隕石（停下、受衝擊）`;
  return '會開出地圖（脫離戰場）';
}
