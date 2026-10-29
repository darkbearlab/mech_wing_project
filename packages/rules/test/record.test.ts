import { describe, expect, it } from 'vitest';
import { Match, Rng, aiOrders, checkRecord, contentVersion, createGame, randomRoster, replayRecord, submitStep, type BattleRecord, type PlayerId, type TurnPhase, config } from '../src/index';

/** 用 AI 打 maxSteps 次結算，照客戶端的格式記下來 */
function recordGame(seed: number, maxResolves = 999): { rec: BattleRecord; match: Match } {
  const rng = new Rng(seed + 1);
  const r0 = new Rng(seed + 2);
  const rosters: BattleRecord['rosters'] = [randomRoster(() => r0.next(), 3), randomRoster(() => r0.next(), 3)];
  const match = new Match(seed, createGame(seed, rosters));
  const rec: BattleRecord = { format: 1, seed, contentVersion: contentVersion(), rules: config.RULES_VERSION, rosters: structuredClone(rosters), seats: ['human', 'ai'], startedAt: '', steps: [], winner: null, turns: 0 };
  while (match.phase !== 'over' && maxResolves-- > 0) {
    const before = match.resolvedCount;
    for (const p of [0, 1] as PlayerId[]) {
      const phase = match.phase as TurnPhase;
      const v = match.viewFor(p);
      if (v.submitted[p]) continue;
      const orders = aiOrders(v, rng);
      expect(submitStep(match, { seat: p, phase, orders })).toEqual([]);
      rec.steps.push({ seat: p, phase, orders: JSON.parse(JSON.stringify(orders)) });
      if (match.resolvedCount !== before) break;
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
      expect(resolves).toBe(match.resolvedCount);
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
