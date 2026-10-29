// 城市地圖的 AI 對打：確認建築、攀升、多武器齊射在整場對戰裡跑得動，順便看看雙方的戰況。
import { DEFAULT_SETTINGS, EQUIPMENT, config, Match, Rng, aiActions, aiMoves, aiPursuits, createGame, pickRosters, viewState } from '../src';
import type { GameEvent } from '../src';

const games = Number(process.argv[2] ?? 30);
const tally = { win: [0, 0], draw: 0, turns: 0, shots: 0, multi: 0, cover: 0, blockedFail: 0, wall: 0, drop: 0, climb: 0, mark: 0, markedHits: 0, lunge: 0, jump: 0, guided: 0, blast: 0, deploy: 0, walled: 0, mine: 0, mineBlast: 0, barricade: 0, arm: 0, bshot: 0, blevel: 0, collapse: 0, launch: 0, landed: 0, lost: 0, screen: 0, atgm: 0, bump: 0, bumpLight: 0, bumpStun: 0 };
for (let g = 0; g < games; g++) {
  const seed = 1000 + g;
  const st = createGame(seed, pickRosters(seed), { ...DEFAULT_SETTINGS, terrain: 'city', environment: 'gravity' }, Number(process.env.RULES) || undefined);
  const m = new Match(seed, st);
  const rng = new Rng(seed * 7 + 1);
  const count = (es: GameEvent[]) => {
    const perUnit = new Map<string, number>();
    for (const e of es) {
      if (e.type === 'shot') {
        tally.shots++;
        perUnit.set(e.attacker, (perUnit.get(e.attacker) ?? 0) + 1);
      }
      if (e.type === 'obstacle') tally.wall++;
      if (e.type === 'contact' && e.result === 'bump') {
        tally.bump++;
        if (e.vc < config.BUMP_STUN_VC) tally.bumpLight++;
      }
      if (e.type === 'mark') tally.mark++;
      if (e.type === 'shot' && EQUIPMENT[e.weapon]?.fire) tally.guided++;
      if (e.type === 'blast') tally.blast++;
      if (e.type === 'mine') tally.mine++;
      if (e.type === 'buildingShot') {
        tally.bshot++;
        if (e.collapsed) tally.collapse++;
      }
      if (e.type === 'elevate' && e.how === 'drop' && e.t === 1) tally.blevel++;
      if (e.type === 'mineBlast') tally.mineBlast++;
      if (e.type === 'launch') tally.launch++;
      if (e.type === 'launch' && e.weapon === 'atgm') tally.atgm++;
      if (e.type === 'shot' && e.inbound) tally.landed++;
      if (e.type === 'inboundLost') tally.lost++;
      if (e.type === 'smoke' && e.screen) tally.screen++;
      if (e.type === 'barricade') tally.barricade++;
      if (e.type === 'shot' && EQUIPMENT[e.weapon]?.fire === 'antiRadiation') tally.arm++;
      if (e.type === 'deploy' && e.up) tally.deploy++;
      if (e.type === 'lunge') e.jump ? tally.jump++ : tally.lunge++;
      if (e.type === 'elevate') e.how === 'drop' ? tally.drop++ : tally.climb++;
      if (e.type === 'actionFail' && e.reason.includes('擋住')) tally.blockedFail++;
    }
    for (const n of perUnit.values()) if (n > 1) tally.multi++;
  };
  for (let safety = 0; m.state.winner === null && safety < 200; safety++) {
    const ph = m.state.phase;
    const views = [0, 1].map((p) => ({ you: p as 0 | 1, state: viewState(m.state, p as 0 | 1) }));
    if (ph === 'move' || ph === 'ace') for (const p of [0, 1] as const) m.submitMoves(p, aiMoves(views[p] as never, rng));
    else if (ph === 'pursuit') for (const p of [0, 1] as const) m.submitPursuits(p, aiPursuits(views[p] as never));
    else if (ph === 'action') {
      tally.bumpStun += m.state.turnInfo?.bumped.filter((id) => m.state.units.find((u) => u.id === id)?.status === 'active').length ?? 0;
      for (const p of [0, 1] as const) m.submitActions(p, aiActions(views[p] as never, rng));
    }
    else break;
    count(m.eventsFor(0));
  }
  const w = m.state.winner;
  if (w === 0 || w === 1) tally.win[w]++;
  else tally.draw++;
  tally.turns += m.state.turn;
}
console.log(`${games} 場：A 勝 ${tally.win[0]}、B 勝 ${tally.win[1]}、平手 ${tally.draw}，平均 ${(tally.turns / games).toFixed(1)} 回合`);
console.log(`射擊 ${tally.shots}、一次動作多武器開火 ${tally.multi}、撞牆 ${tally.wall}、攀升 ${tally.climb}、落下 ${tally.drop}、射擊線被擋 ${tally.blockedFail}、標定 ${tally.mark}、突進 ${tally.lunge}、跳劈 ${tally.jump}、導引武器射擊 ${tally.guided}、迫擊砲散布 ${tally.blast}、展開盾牆 ${tally.deploy}、埋雷 ${tally.mine}、踩雷 ${tally.mineBlast}、路障 ${tally.barricade}、反輻射飛彈 ${tally.arm}、射擊建築 ${tally.bshot}、打平 ${tally.collapse}`);
console.log(`飛行彈藥發射 ${tally.launch}（反戰車 ${tally.atgm}）、命中結算 ${tally.landed}、落空 ${tally.lost}、放煙幕 ${tally.screen}`);
console.log(`擦撞 ${tally.bump}（相對速度 < ${config.BUMP_STUN_VC}：${tally.bumpLight}）、因擦撞（含撞牆）失去動作的機體次數 ${tally.bumpStun}`);
