import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONTENT, useContent, type ContentPack } from '../src/content';
import { hitChance } from '../src/combat';
import { damageUnit, type Ctx } from '../src/damage';
import { EQUIPMENT } from '../src/data';
import { Match } from '../src/match';
import { DEFAULT_SETTINGS } from '../src/objectives';
import { resolveTurn } from '../src/resolve';
import { Rng } from '../src/rng';
import { createGame } from '../src/setup';
import { armorOf, readyRanged } from '../src/unit';
import { viewState } from '../src/visibility';
import type { PlayerActions, PlayerMoves } from '../src/types';
import type { RosterEntry } from '../src/data';

beforeEach(() => {
  const pack: ContentPack = structuredClone({ ...DEFAULT_CONTENT, version: 'test-pocket' });
  pack.equipment['armor'] = { id: 'armor', name: '追加裝甲', kind: 'armor', mount: 'mounted', weight: 0, durability: 8, evasionPenalty: 10, accelPenalty: 1, lockWeapons: true };
  pack.equipment['smoke'] = { id: 'smoke', name: '煙霧彈', kind: 'utility', utility: 'smoke', mount: 'mounted', weight: 1, durability: 1, ammo: 2 };
  pack.equipment['balloon'] = { id: 'balloon', name: '欺敵氣球', kind: 'utility', utility: 'decoy', mount: 'mounted', weight: 1, durability: 1, ammo: 3 };
  useContent(pack);
});
afterEach(() => useContent(DEFAULT_CONTENT));

const plain: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['beam_rifle', 'right']] };
const armored: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['beam_rifle', 'right'], ['armor', 'mount', 'torso']] };
const tricky: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['beam_rifle', 'right'], ['smoke', 'mount', 'torso'], ['balloon', 'mount', 'torso']] };
const quiet = { ...DEFAULT_SETTINGS, killScore: undefined, decapitation: false };
const hover = { maneuver: 'hover-S-0', stance: 'shoot' as const, facingOffset: 0, limiter: false };
const holdAll = (ids: string[], extra: Record<string, object> = {}): PlayerMoves => Object.fromEntries(ids.map((id) => [id, { ...hover, ...(extra[id] ?? {}) }]));
const at = (owner: 0 | 1, index: number, x: number, y: number, facing: number) => ({ owner, index, x, y, facing, momentum: 0 });

describe('外裝甲', () => {
  it('先吸收傷害；穿著時只有頭部武器能用、迴避下降；可以免費拋棄', () => {
    const s = createGame(1, [[armored], [plain]], { ...quiet, placements: [at(0, 0, 10, 10, Math.PI / 2), at(1, 0, 10, 14, -Math.PI / 2)] });
    const [u, enemy] = s.units;
    expect(armorOf(u)).not.toBeNull();
    expect(readyRanged(u).map((e) => EQUIPMENT[e.defId].id)).toEqual(['head_vulcan']);
    const chance = (t: typeof u) => hitChance({ attacker: enemy, attackerSkill: 3, weapon: EQUIPMENT['beam_rifle'], target: t, targetSkill: 3, relSpeed: null, shooterMelee: false })!.chance;
    const before = chance(u);
    const ctx: Ctx = { state: s, rng: new Rng(1), events: [] };
    damageUnit(ctx, u, 5, 'focused');
    expect(Object.values(u.parts).filter((p) => p.kind === 'body').every((p) => p.damage === 0)).toBe(true);
    const r = resolveTurn(s, [holdAll([u.id], { [u.id]: { purge: true } }), holdAll([enemy.id])]).state;
    const after = r.units[0];
    expect(armorOf(after)).toBeNull();
    expect(readyRanged(after).some((e) => e.defId === 'beam_rifle')).toBe(true);
    expect(chance(after)).toBe(before - 10);
  });
});

describe('煙霧與欺敵氣球', () => {
  it('煙霧：射擊 −30；隔著煙霧只看得到不明機體；氣球在煙霧裡看起來像機體，出了煙霧就是氣球；被打中就破', () => {
    const s = createGame(1, [[plain], [tricky]], { ...quiet, environment: 'gravity', placements: [at(0, 0, 12, 4, Math.PI / 2), at(1, 0, 12, 12, -Math.PI / 2)] });
    const m = new Match(1, s);
    const z = s.units[1];
    const smokeId = z.equipment.find((e) => e.defId === 'smoke')!.id;
    const balloonId = z.equipment.find((e) => e.defId === 'balloon')!.id;
    m.submitMoves(0, holdAll([s.units[0].id]));
    m.submitMoves(1, holdAll([z.id]));
    m.submitActions(0, {});
    m.submitActions(1, { [z.id]: { action: { type: 'smoke', weapon: smokeId, at: { x: 12, y: 11 } } } } as PlayerActions);
    expect(m.state.obstacles.some((o) => o.kind === 'smoke')).toBe(true);
    // 煙霧裡放氣球
    m.submitMoves(0, holdAll([s.units[0].id]));
    m.submitMoves(1, holdAll([z.id]));
    m.submitActions(0, {});
    m.submitActions(1, { [z.id]: { action: { type: 'decoy', weapon: balloonId, at: { x: 13.5, y: 12 } } } } as PlayerActions);
    expect(m.state.decoys).toHaveLength(1);
    const v = viewState(m.state, 0);
    const contacts = v.units.filter((u) => u.owner === 1);
    expect(contacts.length).toBe(2);
    expect(contacts.every((u) => u.unknown && u.label === '不明機體')).toBe(true);
    // 打氣球：破掉
    const decoyId = m.state.decoys![0].id;
    m.submitMoves(0, holdAll([s.units[0].id]));
    m.submitMoves(1, holdAll([z.id]));
    m.submitActions(0, { [s.units[0].id]: { action: { type: 'shoot', weapon: s.units[0].equipment[0].id, target: decoyId } } } as PlayerActions);
    m.submitActions(1, {});
    expect(m.state.decoys).toHaveLength(0);
    expect(m.turnResolvedEvents.some((e) => e.type === 'decoyPop')).toBe(true);
    // 煙霧會散
    for (let i = 0; i < 6 && m.state.obstacles.some((o) => o.kind === 'smoke'); i++) {
      m.submitMoves(0, holdAll([s.units[0].id]));
      m.submitMoves(1, holdAll([z.id]));
      m.submitActions(0, {});
      m.submitActions(1, {});
    }
    expect(m.state.obstacles.some((o) => o.kind === 'smoke')).toBe(false);
  });

  it('事先布置的氣球出了煙霧就被看穿成氣球；敵機靠近就破', () => {
    const s = createGame(1, [[plain], [tricky]], { ...quiet, placements: [at(0, 0, 12, 4, Math.PI / 2), at(1, 0, 12, 14, -Math.PI / 2)], prepared: { decoys: [{ owner: 1, index: 0, x: 12, y: 8 }] } });
    expect(viewState(s, 0).balloons).toHaveLength(1);
    const r = resolveTurn(s, [holdAll([s.units[0].id], { [s.units[0].id]: { maneuver: 'straight-S-2' } }), holdAll([s.units[1].id])]).state;
    expect(r.decoys).toHaveLength(0);
  });
});

describe('增援', () => {
  it('指定回合才進場；之前不算全滅', () => {
    const s = createGame(1, [[plain], [plain]], { ...quiet, reinforcements: [{ owner: 0, entry: plain, turn: 2, x: 12, y: 2, facing: Math.PI / 2 }] });
    expect(s.units).toHaveLength(2);
    s.units[0].status = 'destroyed';
    const r = resolveTurn(s, [{}, holdAll([s.units[1].id])]).state;
    expect(r.winner).toBeNull();
    expect(r.units.some((u) => u.id === 'p0u1' && u.status === 'active')).toBe(true);
  });
});
