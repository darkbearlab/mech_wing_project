// 用現在的規則讓電腦打一場，存成重播測試的樣本（test/fixtures/rules<版本>-ai.json）。
// 每次 RULES_VERSION 加一版就跑一次：之後改規則時，舊版本的樣本都還要重播得出一樣的結果。
import { writeFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, Match, Rng, aiOrders, config, contentVersion, createGame, pickRosters, submitStep, type BattleRecord, type BattleSettings, type BattleStep, type PlayerId, type TurnPhase } from '../src/index';

const seed = 3000 + config.RULES_VERSION;
const settings: BattleSettings = { ...DEFAULT_SETTINGS, terrain: 'city', environment: 'gravity', supply: true };
const rosters = pickRosters(seed);
const m = new Match(seed, createGame(seed, rosters, settings));
const rng = new Rng(seed);
const steps: BattleStep[] = [];
for (let safety = 0; m.phase !== 'over' && safety < 400; safety++) {
  for (const p of [0, 1] as PlayerId[]) {
    const v = m.viewFor(p);
    if (v.submitted[p] || m.phase === ('over' as string)) continue;
    const s: BattleStep = { seat: p, phase: m.phase as TurnPhase, orders: JSON.parse(JSON.stringify(aiOrders(v, rng))) };
    const errors = submitStep(m, s);
    if (errors.length) throw new Error(errors.join('；'));
    steps.push(s);
  }
}
const rec: BattleRecord = { format: 1, seed, contentVersion: contentVersion(), rules: config.RULES_VERSION, rosters, settings, seats: ['ai', 'ai'], startedAt: '', steps, winner: m.state.winner, turns: m.state.turn };
const out = new URL(`../test/fixtures/rules${config.RULES_VERSION}-ai.json`, import.meta.url);
writeFileSync(out, JSON.stringify(rec));
console.log(`rules ${config.RULES_VERSION}: ${steps.length} steps, winner ${m.state.winner}, turn ${m.state.turn}`);
