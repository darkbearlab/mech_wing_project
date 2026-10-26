import { describe, expect, it } from 'vitest';
import { Match, Rng, aiActions, aiMoves, checkRecord, contentVersion, createGame, randomRoster, replayRecord, type BattleRecord, type PlayerActions, type PlayerId, type PlayerMoves } from '../src/index';

/** 用 AI 打 maxSteps 次結算，照客戶端的格式記下來 */
function recordGame(seed: number, maxResolves = 999): { rec: BattleRecord; match: Match } {
  const rng = new Rng(seed + 1);
  const r0 = new Rng(seed + 2);
  const rosters: BattleRecord['rosters'] = [randomRoster(() => r0.next(), 3), randomRoster(() => r0.next(), 3)];
  const match = new Match(seed, createGame(seed, rosters));
  const rec: BattleRecord = { format: 1, seed, contentVersion: contentVersion(), rosters: structuredClone(rosters), seats: ['human', 'ai'], startedAt: '', steps: [], winner: null, turns: 0 };
  while (match.phase !== 'over' && maxResolves-- > 0) {
    for (const p of [0, 1] as PlayerId[]) {
      const phase = match.phase as 'move' | 'action';
      const v = match.viewFor(p);
      const orders = phase === 'move' ? aiMoves(v, rng) : aiActions(v, rng);
      if (phase === 'move') match.submitMoves(p, orders as PlayerMoves);
      else match.submitActions(p, orders as PlayerActions);
      rec.steps.push({ seat: p, phase, orders: JSON.parse(JSON.stringify(orders)) });
    }
  }
  rec.winner = match.state.winner;
  rec.turns = match.state.turn;
  return { rec: JSON.parse(JSON.stringify(rec)), match };
}

describe('對戰紀錄', () => {
  it('重播得到一樣的結果（打完與打到一半）', () => {
    for (const [seed, cut] of [[11, 999], [12, 999], [13, 7]]) {
      const { rec, match } = recordGame(seed, cut);
      expect(checkRecord(rec)).toBeNull();
      let resolves = 0;
      const out = replayRecord(rec, () => resolves++);
      expect(out.errors).toEqual([]);
      expect(resolves).toBe(rec.steps.length / 2);
      expect(JSON.stringify(out.match.state)).toBe(JSON.stringify(match.state));
    }
  });

  it('指令被改過時會回報對不上', () => {
    const { rec } = recordGame(14);
    const out = replayRecord({ ...rec, steps: rec.steps.slice(0, 4), winner: 0 });
    expect(out.errors.join()).toMatch(/結果對不上/);
    expect(checkRecord({ ...rec, steps: [{ seat: 3 }] })).toMatch(/steps/);
    expect(checkRecord(null)).not.toBeNull();
  });
});
