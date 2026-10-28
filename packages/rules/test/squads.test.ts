import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, Match, Rng, aiOrders, createGame, ordersBySquad, pickRosters, replayRecord, submitStep, contentVersion, type BattleRecord, type BattleSettings, type BattleStep, type PlayerId, type PlayerMoves, type TurnPhase } from '../src/index';

const strip = (k: string, v: unknown) => (k === 'squad' || k === 'squads' ? undefined : v);

/** 電腦對打；split 時每方分成兩個小隊，整方想好的指令拆開各自送出（從後面的小隊先送） */
function play(seed: number, settings: BattleSettings, split: boolean) {
  const rosters = pickRosters(seed);
  if (split) for (const r of rosters) r.forEach((e, i) => (e.squad = i % 2));
  const m = new Match(seed, createGame(seed, rosters, settings));
  const rng = new Rng(seed * 31 + 7);
  const steps: BattleStep[] = [];
  for (let safety = 0; m.phase !== 'over' && safety < 400; safety++) {
    const before = m.resolvedCount;
    for (const p of [0, 1] as PlayerId[]) {
      const v = m.viewFor(p);
      if (v.submitted[p] || m.phase === ('over' as string)) continue;
      const phase = m.phase as TurnPhase;
      const orders = aiOrders(v, rng);
      const parts: [number | undefined, BattleStep['orders']][] = split ? Object.entries(ordersBySquad(m.state, p, orders)).reverse().map(([s, o]) => [Number(s), o]) : [[undefined, orders]];
      const step = m.resolvedCount;
      for (const [squad, o] of parts) {
        if (m.resolvedCount !== step || m.isSubmitted(p, squad)) continue;
        const s: BattleStep = { seat: p, phase, orders: JSON.parse(JSON.stringify(o)), ...(squad !== undefined ? { squad } : {}) };
        expect(submitStep(m, s)).toEqual([]);
        steps.push(s);
      }
    }
    if (m.resolvedCount === before) break;
  }
  return { m, rosters, steps };
}

describe('小隊', () => {
  it('每方拆成兩個小隊各自下指令，結果和一人指揮整方一模一樣', () => {
    for (const [seed, settings] of [
      [2001, DEFAULT_SETTINGS],
      [2003, { ...DEFAULT_SETTINGS, terrain: 'city', environment: 'gravity' }],
      [2002, { ...DEFAULT_SETTINGS, deploy: 'free' }],
    ] as [number, BattleSettings][]) {
      const whole = play(seed, settings, false).m.state;
      const split = play(seed, settings, true).m.state;
      expect(split.units.some((u) => u.squad === 1)).toBe(true);
      expect(JSON.stringify(split, strip)).toBe(JSON.stringify(whole, strip));
    }
  }, 60_000);

  it('分小隊的對戰紀錄重播得到一樣的結果', () => {
    const { m, rosters, steps } = play(2004, DEFAULT_SETTINGS, true);
    const rec: BattleRecord = { format: 1, seed: 2004, contentVersion: contentVersion(), rosters, settings: DEFAULT_SETTINGS, seats: ['ai', 'ai'], startedAt: '', steps, winner: m.state.winner, turns: m.state.turn };
    const r = replayRecord(JSON.parse(JSON.stringify(rec)));
    expect(r.errors).toEqual([]);
    expect(JSON.stringify(r.match.state)).toBe(JSON.stringify(m.state));
  }, 30_000);

  it('小隊只能指揮自己的機體；送齊之前不算整方送出，計時到就補空指令', () => {
    const rosters = pickRosters(5);
    for (const r of rosters) r.forEach((e, i) => (e.squad = i % 2));
    const m = new Match(5, createGame(5, rosters));
    const rng = new Rng(1);
    const all = aiOrders(m.viewFor(0), rng) as PlayerMoves;
    const parts = ordersBySquad(m.state, 0, all);
    // 把隊友的機體塞進自己的指令
    expect(m.submitMoves(0, all, 0).some((e) => e.includes('不是你指揮的機體'))).toBe(true);
    expect(m.submitMoves(0, parts[0], 0)).toEqual([]);
    expect(m.viewFor(0, 0).submitted[0]).toBe(true);
    expect(m.viewFor(0, 1).submitted[0]).toBe(false);
    expect(m.viewFor(0).submitted[0]).toBe(false);
    expect(m.viewFor(0).squads).toEqual({ 0: true, 1: false });
    // 小隊的畫面看得到隊友，也知道哪台是誰的
    expect(m.viewFor(0, 0).state.units.filter((u) => u.owner === 0).map((u) => u.squad)).toEqual(rosters[0].map((_, i) => i % 2));
    expect(m.submitMoves(1, aiOrders(m.viewFor(1), rng) as PlayerMoves)).toEqual([]);
    expect(m.resolvedCount).toBe(0);
    m.forceLock();
    expect(m.resolvedCount).toBe(1);
  });
});
