import { describe, expect, it } from 'vitest';
import { DEFAULT_ROSTERS, EQUIPMENT, PILOTS, randomRoster, type RosterEntry } from '../src/data';
import { Match } from '../src/match';
import { DEFAULT_SETTINGS, entryCost, flagshipOf, goalZone, killScoreOf, lineupProblems, rosterCost, type BattleSettings } from '../src/objectives';
import { resolveTurn, validateDeploy } from '../src/resolve';
import { createGame } from '../src/setup';
import type { GameState, PlayerMoves } from '../src/types';
import { aiOrders } from '../src/ai';
import { submitStep } from '../src/record';
import { Rng } from '../src/rng';

const hover = { maneuver: 'hover-S-0', stance: 'shoot' as const, facingOffset: 0, limiter: false };
const allHover = (s: GameState): [PlayerMoves, PlayerMoves] =>
  [0, 1].map((p) => Object.fromEntries(s.units.filter((u) => u.owner === p && u.status === 'active').map((u) => [u.id, hover]))) as [PlayerMoves, PlayerMoves];
const game = (settings: Partial<BattleSettings>) => createGame(5, structuredClone(DEFAULT_ROSTERS), { ...DEFAULT_SETTINGS, killScore: undefined, decapitation: false, ...settings });
/** 把所有機體搬到地圖中間互相看不到打不到的地方，避免干擾 */
function park(s: GameState) {
  s.units.forEach((u, i) => {
    u.pos = { x: 2 + i * 2.2, y: u.owner === 0 ? 6 : 18 };
    u.momentum = 0;
  });
}

describe('費用與陣容', () => {
  it('自由組裝：裝備要放得進掛點；照配裝選項以外的組合也可以', () => {
    const ok: RosterEntry = { chassis: 'X-04', pilot: 'veteran', equipment: [['beam_rifle', 'right'], ['atgm', 'mount', 'torso'], ['missile_pod', 'mount', 'torso'], ['vls', 'mount', 'pack'], ['smoke_discharger', 'mount', 'legs']] };
    expect(lineupProblems([ok], 'expanded', { decapitation: false })).toEqual([]);
    const tooMany: RosterEntry = { ...ok, equipment: [...ok.equipment, ['jump_jet', 'mount', 'pack']] };
    expect(lineupProblems([tooMany], 'expanded', { decapitation: false }).join()).toContain('放不進掛點');
    const shieldRack: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['shield', 'stowed']] };
    expect(lineupProblems([shieldRack], 'expanded', { decapitation: false }).join()).toContain('放不進掛點');
  });

  it('載重、重掛點、專用裝備', () => {
    const check = (e: RosterEntry) => lineupProblems([e], 'expanded', { decapitation: false }).join();
    // 重型機兩個重掛點，第三件重型外掛裝不下
    const heavy: RosterEntry = { chassis: 'X-04', pilot: 'veteran', equipment: [['shoulder_cannon', 'mount', 'torso'], ['shoulder_cannon', 'mount', 'torso'], ['vls', 'mount', 'pack']] };
    expect(check(heavy)).toContain('重掛點');
    expect(check({ ...heavy, equipment: heavy.equipment.slice(0, 2) })).toBe('');
    // 中型機一個重掛點、輕型機沒有
    expect(check({ chassis: 'X-00', pilot: 'veteran', equipment: [['shoulder_cannon', 'mount', 'torso'], ['shoulder_cannon', 'mount', 'torso']] })).toContain('重掛點');
    expect(check({ chassis: 'X-00', pilot: 'veteran', equipment: [['shoulder_cannon', 'mount', 'torso']] })).toBe('');
    expect(check({ chassis: 'X-01', pilot: 'veteran', equipment: [['shoulder_cannon', 'mount', 'torso']] })).toContain('沒有重掛點');
    // 載重：輕型機 7
    expect(check({ chassis: 'X-01', pilot: 'veteran', equipment: [['beam_rifle', 'right'], ['shield', 'left'], ['machine_gun', 'stowed']] })).toContain('載重 8 超過上限 7');
    // 專用裝備
    EQUIPMENT['jump_jet'].chassisOnly = ['X-01'];
    try {
      expect(check({ chassis: 'X-00', pilot: 'veteran', equipment: [['jump_jet', 'mount', 'pack']] })).toContain('不能裝在這個機型上');
      expect(check({ chassis: 'X-01', pilot: 'veteran', equipment: [['jump_jet', 'mount', 'pack']] })).toBe('');
    } finally {
      delete EQUIPMENT['jump_jet'].chassisOnly;
    }
  });

  it('費用＝機型＋駕駛＋帶的裝備；標準裝備不算', () => {
    const e: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['beam_rifle', 'right'], ['shield', 'left']] };
    expect(entryCost(e)).toBe(6 + 3 + 3 + 1);
    expect(entryCost({ ...e, equipment: [...e.equipment, ['beam_rifle', 'stowed']] })).toBe(16);
  });

  it('預設陣容在標準規模內；超出預算、台數、重複具名駕駛、斬首旗艦太便宜都會被擋', () => {
    for (const r of DEFAULT_ROSTERS) expect(lineupProblems(r, 'standard', { decapitation: true })).toEqual([]);
    const cheap: RosterEntry = { chassis: 'X-00', pilot: 'recruit', equipment: [] };
    expect(lineupProblems([cheap], 'standard', { decapitation: true }).join()).toMatch(/旗艦/);
    expect(lineupProblems(Array(7).fill(cheap), 'standard', {}).join()).toMatch(/最多 6 台/);
    const big: RosterEntry = { chassis: 'X-05', pilot: 'ace', equipment: [['fuel_tank', 'mount', 'torso']] };
    expect(lineupProblems(Array(5).fill(big), 'small', {}).join()).toMatch(/超出預算/);
    PILOTS['veteran'].unique = true;
    try {
      expect(lineupProblems([{ ...cheap, pilot: 'veteran' }, { ...cheap, pilot: 'veteran' }], 'standard', {}).join()).toMatch(/只能出擊一次/);
    } finally {
      delete PILOTS['veteran'].unique;
    }
    expect(rosterCost(DEFAULT_ROSTERS[0])).toBeGreaterThan(0);
  });
});

describe('勝利條件', () => {
  it('斬首：旗艦退場就輸', () => {
    const s = game({ decapitation: true });
    park(s);
    const flag = flagshipOf(s, 1)!;
    expect(flag.cost).toBe(Math.max(...s.units.filter((u) => u.owner === 1).map((u) => u.cost!)));
    flag.status = 'destroyed';
    const r = resolveTurn(s, allHover(s));
    expect(r.state.winner).toBe(0);
    expect(r.state.winReason).toBe('decapitation');
  });

  it('擊墜分：退場機體的費用（飛出地圖也算）加到門檻就贏', () => {
    const s = game({ killScore: 20 });
    park(s);
    const b = s.units.filter((u) => u.owner === 1);
    b[0].status = 'withdrawn';
    expect(killScoreOf(s, 0)).toBe(b[0].cost);
    const r1 = resolveTurn(s, allHover(s));
    expect(r1.state.winner === null).toBe(b[0].cost! < 20);
    b[1].status = 'destroyed';
    const r2 = resolveTurn(s, allHover(s));
    expect(r2.state.winner).toBe(0);
    expect(r2.state.winReason).toBe('killScore');
  });

  it('達陣：停在對方達陣圈（動能 0）撐過下一回合；圈裡有敵機就不算', () => {
    const s = game({ goal: true });
    park(s);
    const a = s.units.find((u) => u.owner === 0)!;
    a.pos = goalZone(1);
    let st = resolveTurn(s, allHover(s)).state;
    expect(st.objectives!.goalHold[0]?.unit).toBe(a.id);
    expect(st.winner).toBeNull();
    // 有敵機進圈：打斷
    const contested = structuredClone(st);
    const b = contested.units.find((u) => u.owner === 1)!;
    b.pos = { x: goalZone(1).x + 1.2, y: goalZone(1).y };
    expect(resolveTurn(contested, allHover(contested)).state.objectives!.goalHold[0]).toBeNull();
    st = resolveTurn(st, allHover(st)).state;
    expect(st.winner).toBe(0);
    expect(st.winReason).toBe('goal');
  });

  it('據點：每回合單獨佔住的據點各得 1 分，先到門檻獲勝', () => {
    const s = game({ control: 2 });
    park(s);
    const a = s.units.filter((u) => u.owner === 0);
    a[0].pos = { x: 12, y: 12 };
    a[1].pos = { x: 6, y: 12 };
    const st = resolveTurn(s, allHover(s)).state;
    expect(st.objectives!.control).toEqual([2, 0]);
    expect(st.winner).toBe(0);
    expect(st.winReason).toBe('control');
  });

  it('回合上限：比擊墜分，同分平手', () => {
    const s = game({ turnLimit: 1 });
    park(s);
    expect(resolveTurn(s, allHover(s)).state.winner).toBe('draw');
    s.units.find((u) => u.owner === 0)!.status = 'destroyed';
    const r = resolveTurn(s, allHover(s)).state;
    expect([r.winner, r.winReason]).toEqual([1, 'turnLimit']);
  });
});

describe('自由部署', () => {
  it('部署前看不到對方；暗中擺好一起公布；部署區外、朝向不對都會被擋', () => {
    const s = game({ deploy: 'free' });
    const m = new Match(5, s);
    expect(m.phase).toBe('deploy');
    expect(m.viewFor(0).state.units.some((u) => u.owner === 1)).toBe(false);
    const u = s.units.find((x) => x.owner === 0)!;
    expect(validateDeploy(s, 0, { [u.id]: { x: 12, y: 12, facing: Math.PI / 2, momentum: 0 } }).join()).toMatch(/部署區/);
    expect(validateDeploy(s, 0, { [u.id]: { x: 12, y: 3, facing: 0.3, momentum: 0 } }).join()).toMatch(/整數度/);
    expect(validateDeploy(s, 0, { [u.id]: { x: 12, y: 3, facing: (37 * Math.PI) / 180, momentum: 0 } })).toEqual([]);
    const rng = new Rng(1);
    for (const p of [0, 1] as const) expect(submitStep(m, { seat: p, phase: 'deploy', orders: aiOrders(m.viewFor(p), rng) })).toEqual([]);
    expect(m.phase).toBe('move');
  });

  it('電腦自動部署：各種陣容（最多 8 台）與勝利條件都合法，而且很快算完', () => {
    const t = Date.now();
    for (let seed = 1; seed <= 60; seed++) {
      const r = new Rng(seed);
      const n = 1 + (seed % 8);
      const rosters: [RosterEntry[], RosterEntry[]] = [randomRoster(() => r.next(), n), randomRoster(() => r.next(), n)];
      const st = createGame(seed, rosters, { ...DEFAULT_SETTINGS, goal: seed % 2 === 0, control: seed % 3 === 0 ? 6 : undefined, deploy: 'free' });
      const m = new Match(seed, st);
      for (const p of [0, 1] as const) expect(validateDeploy(st, p, aiOrders(m.viewFor(p), r) as never)).toEqual([]);
    }
    expect(Date.now() - t).toBeLessThan(5000);
  });
});
