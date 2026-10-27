// 戰鬥紀錄檢討工具：讓 AI 打一場（或很多場），印出逐回合的經過或整批的問題統計。
//   npm run battle -- 7                    第 7 號種子打一場，印出逐回合紀錄
//   npm run battle -- 7 mirror             雙方同一套隨機陣容（鏡像對戰）
//   npm run battle -- --stats 200 mirror   打 200 場，只看統計（撞隕石、落單、集火、平手…）
//   npm run battle -- --replay logs/battle-12.json   重播線上上傳的對戰紀錄（先用 npm run admin -w @mech/api -- battle 12 下載）
// 陣容模式：config（照設定）、random、mirror、default。PACK=資料包.json 用指定的資料包。
// FROM=logs/battle-12.json：用那場紀錄的地圖與陣容開局，雙方都交給 AI（--stats 時每場 AI 的亂數不同）。
// AI_OLD=../src/ai_old.ts：一方換成另一份 AI（兩邊輪流換），統計分成「新」「舊」比較。
// SCENARIO=0080-ep5：照重演戰役開局（雙方都是電腦，電腦方照劇本走）。
// 勝利條件：WIN=kill50,decap,goal,control6（預設 kill50,decap）、TURNS=12、DEPLOY=free（預設照順序排開）、ENV=gravity（預設宇宙）、SEED0=起始種子。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  BODY_PART_NAMES,
  DEFAULT_ROSTERS,
  EQUIPMENT,
  Match,
  Rng,
  aiActions,
  aiMoves,
  aiOrders,
  createGame,
  hitChance,
  lineOfFire,
  parseManeuver,
  pickRosters,
  randomRoster,
  readyRanged,
  replayRecord,
  SCENARIOS,
  scriptedOrders,
  killScoreOf,
  submitStep,
  useContent,
  type BattleRecord,
  type BattleSettings,
  type ContentPack,
  type GameEvent,
  type PlayerActions,
  type PlayerId,
  type PlayerMoves,
  type PlayerPursuits,
  type PlayerDeploy,
  type TurnPhase,
  type PlayerView,
  type RosterEntry,
  type UnitState,
} from '../src/index';

const API = process.env.MECH_API ?? 'https://mech-wing-api.darkbearlab.workers.dev';
if (process.env.PACK) useContent(JSON.parse(readFileSync(process.env.PACK, 'utf-8')));

/** 換成紀錄用的資料包：草稿附在紀錄裡，正式版本從 API 抓 */
async function usePackOf(rec: BattleRecord) {
  if (rec.pack) useContent(rec.pack);
  else if (!process.env.PACK && !rec.contentVersion.startsWith('builtin')) {
    const res = await fetch(`${API}/packs/${encodeURIComponent(rec.contentVersion)}`);
    if (!res.ok) throw new Error(`抓不到資料包 ${rec.contentVersion}：HTTP ${res.status}`);
    useContent((await res.json()) as ContentPack);
  }
}

const args = process.argv.slice(2);
const replayMode = args[0] === '--replay';
const statsMode = args[0] === '--stats';
const games = statsMode ? Number(args[1] ?? 100) : 1;
const seed0 = statsMode ? Number(process.env.SEED0 ?? 1) : Number(args[0] ?? 1);
const mode = (statsMode ? args[2] : args[1]) ?? 'config';
/** 從環境變數讀勝利條件 */
function settingsFromEnv(): BattleSettings {
  const win = (process.env.WIN ?? 'kill50,decap').split(',').map((x) => x.trim());
  const num = (prefix: string) => {
    const w = win.find((x) => x.startsWith(prefix));
    return w ? Number(w.slice(prefix.length)) || undefined : undefined;
  };
  return {
    killScore: num('kill'),
    decapitation: win.includes('decap'),
    goal: win.includes('goal'),
    control: num('control'),
    turnLimit: Number(process.env.TURNS ?? 12),
    deploy: process.env.DEPLOY === 'free' ? 'free' : 'fixed',
    environment: process.env.ENV === 'gravity' ? 'gravity' : 'space',
  };
}
const scenario = process.env.SCENARIO ? SCENARIOS.find((x) => x.id === process.env.SCENARIO) : undefined;
if (process.env.SCENARIO && !scenario) throw new Error(`沒有劇本 ${process.env.SCENARIO}（有：${SCENARIOS.map((x) => x.id).join('、')}）`);
const settings = scenario ? scenario.settings() : settingsFromEnv();
const from = process.env.FROM ? (JSON.parse(readFileSync(process.env.FROM, 'utf-8')) as BattleRecord) : null;

interface Ai {
  aiMoves: (v: PlayerView, rng: Rng) => PlayerMoves;
  aiActions: (v: PlayerView, rng: Rng) => PlayerActions;
  aiOrders?: (v: PlayerView, rng: Rng) => PlayerMoves | PlayerActions | PlayerPursuits | PlayerDeploy;
}
const newAi: Ai = { aiMoves, aiActions, aiOrders };
const oldAi: Ai | null = process.env.AI_OLD ? await import(pathToFileURL(resolve(process.env.AI_OLD)).href) : null;
/** 舊版 AI 沒有 aiOrders 時：王牌移動照移動出、追擊放棄 */
const ordersOf = (ai: Ai, v: PlayerView, rng: Rng) =>
  scenario && ai === newAi ? scriptedOrders(scenario, v, rng) : ai.aiOrders ? ai.aiOrders(v, rng) : v.phase === 'pursuit' || v.phase === 'deploy' ? {} : v.phase === 'action' ? ai.aiActions(v, rng) : ai.aiMoves(v, rng);

function rosters(seed: number): [RosterEntry[], RosterEntry[]] {
  if (scenario) return scenario.rosters();
  if (from) return structuredClone(from.rosters ?? pickRosters(from.seed));
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

/** 各操作者（A／B 方，或比較時的「新」「舊」）分開累計的統計 */
interface Side {
  wins: number;
  rockHits: number;
  rockRepeat: number;
  friendlyBumps: number;
  shots: number;
  hits: number;
  lowShots: number;
  locks: number;
  volleys: number;
  pursuitVolleys: number;
  defers: number;
  ntKillStress: number;
  outnumbered: number;
  unitTurns: number;
  noActionTurns: number;
  focusShots: number;
  actionTurnsWithShots: number;
  lost: number;
}
const newSide = (): Side => ({ wins: 0, rockHits: 0, rockRepeat: 0, friendlyBumps: 0, shots: 0, hits: 0, lowShots: 0, locks: 0, volleys: 0, pursuitVolleys: 0, defers: 0, ntKillStress: 0, outnumbered: 0, unitTurns: 0, noActionTurns: 0, focusShots: 0, actionTurnsWithShots: 0, lost: 0 });
const S = { games: 0, turns: 0, draws: 0, ends: {} as Record<string, number>, reasons: {} as Record<string, number>, side: {} as Record<string, Side> };
const sideOf = (name: string) => (S.side[name] ??= newSide());

/** 能射到 target 的最高命中率（看得到射線、在射界與距離內）；打不到回傳 0 */
function bestChance(a: UnitState, t: UnitState, m: Match): number {
  let best = 0;
  for (const w of readyRanged(a)) {
    const h = hitChance({ attacker: a, attackerSkill: 0, weapon: EQUIPMENT[w.defId], target: t, targetSkill: null, relSpeed: null, shooterMelee: false, cover: lineOfFire(m.state.obstacles, a.pos, t.pos) });
    if (h) best = Math.max(best, h.chance);
  }
  return best;
}

const REASON = { annihilation: '全滅', decapitation: '斬首', killScore: '擊墜分', goal: '達陣', control: '據點', turnLimit: '回合上限' };

type Orders = PlayerMoves | PlayerActions | PlayerPursuits | PlayerDeploy | null;

/** 整理一場對戰的經過；verbose 時印出逐回合紀錄，同時累計統計。names 是兩方在統計裡的名字 */
function reporter(m: Match, verbose: boolean, seatNote = ['', ''], names = ['A', 'B']) {
  const label = (id: string) => m.state.units.find((u) => u.id === id)?.label ?? id;
  const unit = (id: string) => m.state.units.find((u) => u.id === id);
  const owner = (id: string) => unit(id)?.owner;
  const side = (p: number | undefined) => sideOf(names[p ?? 0]);
  const lastRock = new Map<string, number>();
  const say = (s: string) => verbose && console.log(s);

  if (verbose) {
    say(`隕石：${m.state.obstacles.map((o) => `${o.kind === 'rock' ? '大隕石' : '隕石群'}(${f1(o.x)},${f1(o.y)}) r${f1(o.r)}`).join('、')}`);
    for (const u of m.state.units) say(`  ${u.label}${seatNote[u.owner]} 駕駛 ${u.pilotId}　${u.equipment.map((e) => `${EQUIPMENT[e.defId].name}(${e.location})`).join('、')}`);
  }

  let turn = m.state.turn;
  // 每次結算後呼叫：phase 是剛結算的階段，plans 是雙方這次送出的指令
  const resolved = (phase: TurnPhase, plans: [Orders, Orders]) => {
    const events: GameEvent[] = m.turnResolvedEvents;
    if (phase === 'pursuit') say(`── 第 ${turn} 回合 追擊 ──`);
    if (phase === 'deploy') {
      say('── 部署 ──');
      for (const u of m.state.units) say(`  ${u.label} → (${f1(u.pos.x)},${f1(u.pos.y)}) 朝 ${deg(u.facing)}° 動能 ${u.momentum}`);
    }
    if (phase === 'move' || phase === 'ace') {
      say(phase === 'move' ? `\n── 第 ${turn} 回合 移動 ──` : `── 第 ${turn} 回合 王牌移動 ──`);
      for (const p of [0, 1] as const) {
        for (const [id, plan] of Object.entries((plans[p] ?? {}) as PlayerMoves)) {
          const u = unit(id)!;
          if (phase === 'move') side(p).unitTurns++;
          if (plan.defer) {
            side(p).defers++;
            say(`  ${label(id)} 擱置移動（王牌移動）`);
            continue;
          }
          // 落單：打得到我的敵機，比「能還擊其中任一台的隊友＋我」還多
          const foes = m.state.units.filter((e) => e.owner !== p && e.status === 'active' && bestChance(e, u, m) > 0);
          const mates = m.state.units.filter((a) => a.owner === p && a.id !== id && a.status === 'active' && foes.some((e) => bestChance(a, e, m) > 0));
          const alone = u.status === 'active' && foes.length >= 2 && foes.length > mates.length + 1;
          if (alone) side(p).outnumbered++;
          say(`  ${label(id)} ${parseManeuver(plan.maneuver).name}${plan.stance === 'melee' ? '・近戰姿態' : ''}${plan.facingOffset ? `・轉身 ${plan.facingOffset}` : ''}${plan.grapple ? `・纏鬥選 ${plan.grapple}` : ''}　→ (${f1(u.pos.x)},${f1(u.pos.y)}) 朝 ${deg(u.facing)}° 動能 ${u.momentum}　[${hp(u)}] 推 ${u.propellant} 壓 ${u.stress}${alone ? `　← 落單（${foes.length} 台敵機打得到，${mates.length} 台隊友能支援）` : ''}`);
        }
      }
    } else say(`── 第 ${turn} 回合 行動 ──`);

    const shotTargets: Record<string, string[]> = { 0: [], 1: [] };
    for (const e of events) {
      switch (e.type) {
        case 'obstacle': {
          side(owner(e.unit)).rockHits++;
          if (lastRock.get(e.unit) === turn - 1) side(owner(e.unit)).rockRepeat++;
          lastRock.set(e.unit, turn);
          say(`  ！${label(e.unit)} 撞上大隕石${e.damage ? `，受 ${e.damage} 點衝擊` : ''}`);
          break;
        }
        case 'contact':
          if (e.result !== 'none') {
            if (owner(e.a) === owner(e.b)) side(owner(e.a)).friendlyBumps++;
            say(`  ${label(e.a)} 與 ${label(e.b)} 接觸（Vc ${e.vc}）：${e.result}${owner(e.a) === owner(e.b) ? '　← 友軍互撞' : ''}`);
          }
          break;
        case 'clash':
          say(`  近戰對決 ${label(e.attacker)} vs ${label(e.defender)}：${e.winner ? `${label(e.winner)} 勝` : '平手'}${e.damage ? `，${e.damage} 點` : ''}`);
          break;
        case 'grapple':
          say(`  纏鬥 ${label(e.a)} ${e.choiceA} vs ${label(e.b)} ${e.choiceB}：${e.summary}`);
          break;
        case 'shot': {
          const s = side(owner(e.attacker));
          s.shots += e.shots;
          s.hits += e.hits;
          s.volleys++;
          if (e.pursuit) s.pursuitVolleys++;
          if ((e.chance ?? 100) < 20) s.lowShots++;
          shotTargets[String(owner(e.attacker))].push(e.target);
          say(`  ${e.pursuit ? '追擊！' : ''}${label(e.attacker)} ${EQUIPMENT[e.weapon].name} → ${label(e.target)}（距離帶 ${e.band}，命中率 ${e.chance}%）${e.hits}/${e.shots} 中${e.blocked ? `，盾擋 ${e.blocked}` : ''}`);
          break;
        }
        case 'damage':
          if (e.destroyed) say(`    ${label(e.unit)} 的 ${unit(e.unit)?.parts[e.part]?.name ?? e.part} 被破壞`);
          break;
        case 'status':
          S.ends[e.status] = (S.ends[e.status] ?? 0) + 1;
          side(owner(e.unit)).lost++;
          say(`  ★ ${label(e.unit)} ${{ destroyed: '被擊毀', withdrawn: '飛出地圖', disabled: '停止動作' }[e.status]}${e.by ? `（${label(e.by)} 擊墜）` : ''}`);
          break;
        case 'actionFail':
          say(`  ${label(e.unit)} 動作落空：${e.reason}`);
          break;
        case 'swap':
          say(`  ${label(e.unit)} 換上 ${e.equip ? EQUIPMENT[unit(e.unit)!.equipment.find((x) => x.id === e.equip)!.defId].name : '空手'}`);
          break;
        case 'lock':
          side(owner(e.unit)).locks++;
          say(`  ${label(e.unit)} 鎖定 ${label(e.target)}`);
          break;
        case 'stress':
          if (e.reason.includes('新人類')) {
            if (e.reason.startsWith('擊墜')) side(owner(e.unit)).ntKillStress += e.amount;
            say(`  ${label(e.unit)} 壓力 ${e.amount > 0 ? '+' : ''}${e.amount}（${e.reason}）→ ${e.total}`);
          }
          break;
        case 'smoke':
          say(`  ${label(e.unit)} 丟出煙霧彈 → (${f1(e.at.x)},${f1(e.at.y)})`);
          break;
        case 'decoy':
          say(`  ${label(e.unit)} 放出欺敵氣球`);
          break;
        case 'decoyPop':
          say(`  ✕ 欺敵氣球破了（${e.reason}${e.by ? `，${label(e.by)}` : ''}）`);
          break;
        case 'purge':
          say(`  ${label(e.unit)} 拋棄外裝甲`);
          break;
        case 'arrive':
          say(`  ＋ ${label(e.unit)} 增援進場`);
          break;
        case 'objective':
          say(`  ◎ ${e.text}`);
          break;
        case 'pilot':
          say(`  ${label(e.unit)} 駕駛 ${e.state}`);
          break;
      }
    }
    if (phase === 'action') {
      for (const p of [0, 1] as const) {
        const acts = (plans[p] ?? {}) as PlayerActions;
        for (const a of Object.values(acts)) if (a.action.type === 'none' && !a.swap) side(p).noActionTurns++;
        const t = shotTargets[p];
        if (t.length >= 2) {
          side(p).actionTurnsWithShots++;
          const top = Math.max(...Object.values(t.reduce<Record<string, number>>((c, x) => ((c[x] = (c[x] ?? 0) + 1), c), {})));
          side(p).focusShots += top / t.length;
        }
      }
    }
    turn = m.state.turn;
  };
  const finish = () => {
    S.games++;
    S.turns += m.state.turn;
    if (m.state.winReason) S.reasons[m.state.winReason] = (S.reasons[m.state.winReason] ?? 0) + 1;
    if (m.state.winner === 'draw') S.draws++;
    else if (m.state.winner !== null) side(m.state.winner).wins++;
    say(`\n結果：${m.state.winner === null ? '沒打完（中途重開或關掉）' : m.state.winner === 'draw' ? '平手' : `${m.state.winner === 0 ? 'A' : 'B'} 方勝`}（第 ${m.state.turn} 回合${m.state.winReason ? `，${REASON[m.state.winReason]}` : ''}）　擊墜分 A ${killScoreOf(m.state, 0)} / B ${killScoreOf(m.state, 1)}`);
  };
  return { resolved, finish };
}

/** 雙方都由 AI 操作打一場；比較模式下第 g 場奇數局讓舊 AI 拿 A 方 */
function play(g: number, verbose: boolean) {
  const seed = from ? from.seed : seed0 + g;
  const m = new Match(seed, createGame(seed, rosters(seed), from?.settings ?? settings));
  const rng = new Rng((seed0 + g) * 7919 + 3);
  const ais: [Ai, Ai] = oldAi ? (g % 2 ? [oldAi, newAi] : [newAi, oldAi]) : [newAi, newAi];
  const names = oldAi ? ais.map((a) => (a === newAi ? '新' : '舊')) : ['A', 'B'];
  if (verbose) console.log(`種子 ${seed}，陣容 ${from ? `照 ${process.env.FROM}` : `模式 ${mode}`}，資料 ${m.state.contentVersion}${oldAi ? `，A 方 ${names[0]} AI、B 方 ${names[1]} AI` : ''}`);
  const r = reporter(m, verbose, ['', ''], names);
  let guard = 0;
  while (m.phase !== 'over' && guard++ < 100) {
    const phase = m.phase as TurnPhase;
    const plans: [Orders, Orders] = [null, null];
    const before = m.resolvedCount;
    for (const p of [0, 1] as PlayerId[]) {
      const v = m.viewFor(p);
      if (v.submitted[p]) continue;
      const errs = submitStep(m, { seat: p, phase, orders: (plans[p] = ordersOf(ais[p], v, rng)) });
      if (errs.length) throw new Error(`${'AB'[p]} 方 AI 的 ${phase} 指令不合法：${errs.join('；')}`);
      if (m.resolvedCount !== before) break;
    }
    r.resolved(phase, plans);
  }
  r.finish();
}

/** 重播上傳的對戰紀錄 */
async function replay(file: string) {
  const rec = JSON.parse(readFileSync(file, 'utf-8')) as BattleRecord;
  await usePackOf(rec);
  const who = { human: '（玩家）', ai: '（電腦）' };
  console.log(`紀錄 ${file}：${rec.startedAt}，種子 ${rec.seed}，資料 ${rec.contentVersion}，建置 ${rec.build ?? '?'}，A 方${who[rec.seats[0]]} B 方${who[rec.seats[1]]}`);
  let r: ReturnType<typeof reporter> | null = null;
  const { match, errors } = replayRecord(rec, (m, phase, orders) => {
    r ??= reporter(m, true, [who[rec.seats[0]], who[rec.seats[1]]]);
    r.resolved(phase, orders);
  });
  (r ?? reporter(match, true)).finish();
  if (errors.length) console.log(`\n⚠ 重播有問題：\n  ${errors.join('\n  ')}`);
}

if (replayMode) await replay(args[1]);
else {
  if (from) await usePackOf(from);
  for (let g = 0; g < games; g++) play(g, !statsMode);
}

if (statsMode && !replayMode) {
  const pct = (a: number, b: number) => `${((a / Math.max(1, b)) * 100).toFixed(0)}%`;
  const per = (n: number) => (n / S.games).toFixed(2);
  console.log(`[${from ? `FROM ${process.env.FROM}` : mode}] ${S.games} 場，平均 ${(S.turns / S.games).toFixed(1)} 回合，平手 ${S.draws}　退場 ${JSON.stringify(S.ends)}`);
  console.log(`勝負原因 ${Object.entries(S.reasons).map(([k, n]) => `${REASON[k as keyof typeof REASON]} ${n}`).join('、')}　條件 ${JSON.stringify(settings)}`);
  for (const [name, s] of Object.entries(S.side).sort()) {
    console.log(
      `${name}：勝 ${s.wins}　損失 每場 ${per(s.lost)} 台　落單 ${pct(s.outnumbered, s.unitTurns)} 的機體回合　撞隕石 每場 ${per(s.rockHits)}（連撞 ${per(s.rockRepeat)}）　友軍互撞 每場 ${per(s.friendlyBumps)}`,
    );
    console.log(`　　射擊 每場 ${per(s.shots)} 發、命中率 ${pct(s.hits, s.shots)}、低命中（<20%）開火 ${pct(s.lowShots, s.volleys)}　鎖定 每場 ${per(s.locks)} 次　追擊開火 每場 ${per(s.pursuitVolleys)} 次　王牌擱置 每場 ${per(s.defers)} 次　新人類擊墜壓力 每場 ${per(s.ntKillStress)}　集火 ${pct(s.focusShots, s.actionTurnsWithShots)}　沒行動 ${pct(s.noActionTurns, s.unitTurns)}`);
  }
}
