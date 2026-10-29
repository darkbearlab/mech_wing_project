// 指定陣容的 AI 對打：比較不同規則版本下兩隊的勝率（例如王牌少數對老兵多數、干擾對標定飛彈）。
// 用法：RULES=3 npx tsx scripts/matchup.ts <場數> <city|space> <陣容名A> <陣容名B>
import { DEFAULT_SETTINGS, Match, Rng, aiActions, aiMoves, aiPursuits, createGame, killScoreOf, viewState } from '../src';
import type { RosterEntry } from '../src';

const gun = (extra: RosterEntry['equipment'] = []): RosterEntry['equipment'] => [['machine_gun', 'right'], ['bazooka', 'left'], ...extra];
const TEAMS: Record<string, RosterEntry[]> = {
  // 王牌 X-00 四台（肩砲第 4 版起不能裝在 X-00 上，所以兩種規則都不帶）
  aces: Array.from({ length: 4 }, () => ({ chassis: 'X-00', pilot: 'ace', equipment: gun([['arm_gatling', 'builtin', 'rarm'], ['arm_gatling', 'builtin', 'larm']]) })),
  // 老兵 X-00 五台
  vets: Array.from({ length: 5 }, () => ({ chassis: 'X-00', pilot: 'veteran', equipment: gun([['arm_gatling', 'builtin', 'rarm'], ['arm_gatling', 'builtin', 'larm']]) })),
  // 王牌 X-00 三台加兩台帶干擾器的 X-07
  ecm: [
    ...Array.from({ length: 3 }, () => ({ chassis: 'X-00', pilot: 'ace', equipment: gun([['arm_gatling', 'builtin', 'rarm']]) })),
    ...Array.from({ length: 2 }, () => ({ chassis: 'X-07', pilot: 'veteran', equipment: [['machine_gun', 'right'], ['ecm_pod', 'mount', 'pack']] as RosterEntry['equipment'] })),
  ],
  // 標定 X-07 加三台垂直飛彈 X-04（徵招兵）與兩台王牌 X-00
  vls: [
    ...Array.from({ length: 2 }, () => ({ chassis: 'X-00', pilot: 'ace', equipment: gun([['arm_gatling', 'builtin', 'rarm']]) })),
    { chassis: 'X-07', pilot: 'recruit', equipment: [['machine_gun', 'right'], ['designator', 'mount', 'pack']] },
    ...Array.from({ length: 3 }, () => ({ chassis: 'X-04', pilot: 'recruit', equipment: [['vls', 'mount', 'torso'], ['vls', 'mount', 'torso']] as RosterEntry['equipment'] })),
  ],
};

const [games = '40', env = 'city', a = 'aces', b = 'vets'] = process.argv.slice(2);
const rules = Number(process.env.RULES) || undefined;
const settings = env === 'space' ? { ...DEFAULT_SETTINGS, terrain: 'asteroid' as const, environment: 'space' as const } : { ...DEFAULT_SETTINGS, terrain: 'city' as const, environment: 'gravity' as const };
const tally = { win: [0, 0], draw: 0, turns: 0, score: [0, 0] };
for (let g = 0; g < Number(games); g++) {
  const seed = 2000 + g;
  // 奇數場交換兩方，抵銷開場位置的差別
  const swap = g % 2 === 1;
  const rosters: [RosterEntry[], RosterEntry[]] = swap ? [TEAMS[b], TEAMS[a]] : [TEAMS[a], TEAMS[b]];
  const m = new Match(seed, createGame(seed, structuredClone(rosters), { ...settings, killScore: 35, decapitation: true }, rules));
  const rng = new Rng(seed * 7 + 1);
  for (let safety = 0; m.state.winner === null && safety < 200; safety++) {
    const ph = m.state.phase;
    const views = [0, 1].map((p) => ({ you: p as 0 | 1, state: viewState(m.state, p as 0 | 1) }));
    if (ph === 'move' || ph === 'ace') for (const p of [0, 1] as const) m.submitMoves(p, aiMoves(views[p] as never, rng));
    else if (ph === 'pursuit') for (const p of [0, 1] as const) m.submitPursuits(p, aiPursuits(views[p] as never));
    else if (ph === 'action') for (const p of [0, 1] as const) m.submitActions(p, aiActions(views[p] as never, rng));
    else break;
  }
  const w = m.state.winner;
  const side = (p: 0 | 1) => (swap ? 1 - p : p) as 0 | 1;
  if (w === 0 || w === 1) tally.win[side(w)]++;
  else tally.draw++;
  for (const p of [0, 1] as const) tally.score[side(p)] += killScoreOf(m.state, p);
  tally.turns += m.state.turn;
}
const n = Number(games);
console.log(`規則 ${rules ?? '現行'} ${env} ${a} 對 ${b}：${a} 勝 ${tally.win[0]}、${b} 勝 ${tally.win[1]}、平手 ${tally.draw}；平均擊墜分 ${(tally.score[0] / n).toFixed(1)} : ${(tally.score[1] / n).toFixed(1)}、${(tally.turns / n).toFixed(1)} 回合`);
