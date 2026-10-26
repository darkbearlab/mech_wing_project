// 戰鬥紀錄檢討工具：讓 AI 打一場（或很多場），印出逐回合的經過或整批的問題統計。
//   npm run battle -- 7                    第 7 號種子打一場，印出逐回合紀錄
//   npm run battle -- 7 mirror             雙方同一套隨機陣容（鏡像對戰）
//   npm run battle -- --stats 200 mirror   打 200 場，只看統計（撞隕石、卡住、集火、平手…）
// 陣容模式：config（照設定）、random、mirror、default。PACK=資料包.json 用指定的資料包。
import { readFileSync } from 'node:fs';
import {
  BODY_PART_NAMES,
  DEFAULT_ROSTERS,
  EQUIPMENT,
  Match,
  Rng,
  aiActions,
  aiMoves,
  createGame,
  parseManeuver,
  pickRosters,
  randomRoster,
  useContent,
  type GameEvent,
  type PlayerActions,
  type PlayerId,
  type PlayerMoves,
  type RosterEntry,
  type UnitState,
} from '../src/index';

if (process.env.PACK) useContent(JSON.parse(readFileSync(process.env.PACK, 'utf-8')));

const args = process.argv.slice(2);
const statsMode = args[0] === '--stats';
const games = statsMode ? Number(args[1] ?? 100) : 1;
const seed0 = statsMode ? 1 : Number(args[0] ?? 1);
const mode = (statsMode ? args[2] : args[1]) ?? 'config';

function rosters(seed: number): [RosterEntry[], RosterEntry[]] {
  if (mode === 'default') return structuredClone(DEFAULT_ROSTERS);
  const rng = new Rng(seed * 2654435761);
  const a = randomRoster(() => rng.next());
  if (mode === 'mirror') return [a, structuredClone(a)];
  if (mode === 'random') return [a, randomRoster(() => rng.next())];
  return pickRosters(seed);
}

const f1 = (n: number) => n.toFixed(1);
const deg = (r: number) => Math.round((r * 180) / Math.PI);
const hp = (u: UnitState) => {
  const body = Object.values(u.parts).filter((p) => p.kind === 'body');
  return body.map((p) => `${(p.name || BODY_PART_NAMES[p.id] || p.id).slice(0, 2)}${p.durability - p.damage}`).join(' ');
};

interface Stats {
  games: number;
  turns: number;
  wins: Record<string, number>;
  rockHits: number;
  rockRepeat: number;
  stuckTurns: number;
  shots: number;
  hits: number;
  noActionTurns: number;
  unitTurns: number;
  focusShots: number;
  actionTurnsWithShots: number;
  ends: Record<string, number>;
  friendlyBumps: number;
}
const S: Stats = { games: 0, turns: 0, wins: { 0: 0, 1: 0, draw: 0 }, rockHits: 0, rockRepeat: 0, stuckTurns: 0, shots: 0, hits: 0, noActionTurns: 0, unitTurns: 0, focusShots: 0, actionTurnsWithShots: 0, ends: {}, friendlyBumps: 0 };

function play(seed: number, verbose: boolean) {
  const m = new Match(seed, createGame(seed, rosters(seed)));
  const rng = new Rng(seed * 7919 + 3);
  const label = (id: string) => m.state.units.find((u) => u.id === id)?.label ?? id;
  const owner = (id: string) => m.state.units.find((u) => u.id === id)?.owner;
  const lastRock = new Map<string, number>();
  const say = (s: string) => verbose && console.log(s);

  if (verbose) {
    say(`種子 ${seed}，陣容模式 ${mode}，資料 ${m.state.contentVersion}`);
    say(`隕石：${m.state.obstacles.map((o) => `${o.kind === 'rock' ? '大隕石' : '隕石群'}(${f1(o.x)},${f1(o.y)}) r${f1(o.r)}`).join('、')}`);
    for (const u of m.state.units) say(`  ${u.label} 駕駛 ${u.pilotId}　${u.equipment.map((e) => `${EQUIPMENT[e.defId].name}(${e.location})`).join('、')}`);
  }

  let guard = 0;
  while (m.phase !== 'over' && guard++ < 100) {
    const phase = m.phase;
    const turn = m.state.turn;
    const plans: [PlayerMoves | PlayerActions | null, PlayerMoves | PlayerActions | null] = [null, null];
    for (const p of [0, 1] as PlayerId[]) {
      const v = m.viewFor(p);
      if (phase === 'move') m.submitMoves(p, (plans[p] = aiMoves(v, rng)));
      else m.submitActions(p, (plans[p] = aiActions(v, rng)));
    }
    const events: GameEvent[] = m.turnResolvedEvents;
    if (phase === 'move') {
      say(`\n── 第 ${turn} 回合 移動 ──`);
      for (const p of [0, 1] as const) {
        for (const [id, plan] of Object.entries((plans[p] ?? {}) as PlayerMoves)) {
          const u = m.state.units.find((x) => x.id === id)!;
          S.unitTurns++;
          say(`  ${label(id)} ${parseManeuver(plan.maneuver).name}${plan.stance === 'melee' ? '・近戰姿態' : ''}${plan.facingOffset ? `・轉身 ${plan.facingOffset}` : ''}${plan.grapple ? `・纏鬥選 ${plan.grapple}` : ''}　→ (${f1(u.pos.x)},${f1(u.pos.y)}) 朝 ${deg(u.facing)}° 動能 ${u.momentum}　[${hp(u)}] 推 ${u.propellant} 壓 ${u.stress}`);
        }
      }
    } else say(`── 第 ${turn} 回合 行動 ──`);

    const shotTargets: Record<string, string[]> = { 0: [], 1: [] };
    for (const e of events) {
      switch (e.type) {
        case 'obstacle': {
          S.rockHits++;
          if (lastRock.get(e.unit) === turn - 1) S.rockRepeat++;
          lastRock.set(e.unit, turn);
          S.stuckTurns++;
          say(`  ！${label(e.unit)} 撞上大隕石${e.damage ? `，受 ${e.damage} 點衝擊` : ''}`);
          break;
        }
        case 'contact':
          if (e.result !== 'none') {
            if (owner(e.a) === owner(e.b)) S.friendlyBumps++;
            say(`  ${label(e.a)} 與 ${label(e.b)} 接觸（Vc ${e.vc}）：${e.result}${owner(e.a) === owner(e.b) ? '　← 友軍互撞' : ''}`);
          }
          break;
        case 'clash':
          say(`  近戰對決 ${label(e.attacker)} vs ${label(e.defender)}：${e.winner ? `${label(e.winner)} 勝` : '平手'}${e.damage ? `，${e.damage} 點` : ''}`);
          break;
        case 'grapple':
          say(`  纏鬥 ${label(e.a)} ${e.choiceA} vs ${label(e.b)} ${e.choiceB}：${e.summary}`);
          break;
        case 'shot':
          S.shots += e.shots;
          S.hits += e.hits;
          shotTargets[String(owner(e.attacker))].push(e.target);
          say(`  ${label(e.attacker)} ${EQUIPMENT[e.weapon].name} → ${label(e.target)}（距離帶 ${e.band}，命中率 ${e.chance}%）${e.hits}/${e.shots} 中${e.blocked ? `，盾擋 ${e.blocked}` : ''}`);
          break;
        case 'damage':
          if (e.destroyed) say(`    ${label(e.unit)} 的 ${m.state.units.find((u) => u.id === e.unit)?.parts[e.part]?.name ?? e.part} 被破壞`);
          break;
        case 'status':
          S.ends[e.status] = (S.ends[e.status] ?? 0) + 1;
          say(`  ★ ${label(e.unit)} ${{ destroyed: '被擊毀', withdrawn: '飛出地圖', disabled: '停止動作' }[e.status]}`);
          break;
        case 'actionFail':
          say(`  ${label(e.unit)} 動作落空：${e.reason}`);
          break;
        case 'swap':
          say(`  ${label(e.unit)} 換上 ${e.equip ? EQUIPMENT[m.state.units.find((u) => u.id === e.unit)!.equipment.find((x) => x.id === e.equip)!.defId].name : '空手'}`);
          break;
        case 'lock':
          say(`  ${label(e.unit)} 鎖定 ${label(e.target)}`);
          break;
        case 'pilot':
          say(`  ${label(e.unit)} 駕駛 ${e.state}`);
          break;
      }
    }
    if (phase === 'action') {
      for (const p of [0, 1] as const) {
        const acts = (plans[p] ?? {}) as PlayerActions;
        for (const a of Object.values(acts)) if (a.action.type === 'none' && !a.swap) S.noActionTurns++;
        const t = shotTargets[p];
        if (t.length >= 2) {
          S.actionTurnsWithShots++;
          const top = Math.max(...Object.values(t.reduce<Record<string, number>>((c, x) => ((c[x] = (c[x] ?? 0) + 1), c), {})));
          S.focusShots += top / t.length;
        }
      }
    }
  }
  S.games++;
  S.turns += m.state.turn;
  S.wins[String(m.state.winner)]++;
  say(`\n結果：${m.state.winner === 'draw' ? '平手' : `${m.state.winner === 0 ? 'A' : 'B'} 方勝`}（第 ${m.state.turn} 回合）`);
}

for (let g = 0; g < games; g++) play(seed0 + g, !statsMode);

if (statsMode) {
  const per = (n: number) => (n / S.games).toFixed(2);
  console.log(`[${mode}] ${S.games} 場，平均 ${(S.turns / S.games).toFixed(1)} 回合　勝負 ${JSON.stringify(S.wins)}　退場 ${JSON.stringify(S.ends)}`);
  console.log(`撞隕石 每場 ${per(S.rockHits)} 次（連續兩回合撞 ${per(S.rockRepeat)} 次）　友軍互撞 每場 ${per(S.friendlyBumps)} 次`);
  console.log(`射擊 每場 ${per(S.shots)} 發、命中率 ${((S.hits / Math.max(1, S.shots)) * 100).toFixed(1)}%　沒行動的機體回合 ${((S.noActionTurns / Math.max(1, S.unitTurns)) * 100).toFixed(0)}%`);
  console.log(`集火程度（兩發以上的回合，打同一目標的比例）${((S.focusShots / Math.max(1, S.actionTurnsWithShots)) * 100).toFixed(0)}%`);
}
