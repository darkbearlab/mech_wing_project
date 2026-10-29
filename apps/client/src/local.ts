// 本機模式：Match 直接跑在瀏覽器裡，給 GitHub Pages 這類沒有伺服器的環境用。
// 回傳的訊息格式和 WebSocket 伺服器相同，main.ts 不需要分辨來源。
import { DEFAULT_SETTINGS, config, Match, Rng, aiOrders, scriptedOrders, type Scenario, contentVersion, createGame, submitStep, type BattleRecord, type BattleSettings, type BattleStep, type ClientMessage, type GameEvent, type PlayerId, type PlayerView, type RosterEntry, type ServerMessage } from '@mech/rules';
import { draftPack } from './content';
import { uploadBattle } from './record';

interface Unseen {
  /** 結算前的畫面，播放動畫需要起點 */
  before: PlayerView;
  events: GameEvent[];
}

/** hotseat：同一台裝置輪流；ai：A 方是人、B 方是電腦；aiA：B 方是人、A 方是電腦（重演戰役扮演對手方）；aivai：雙方都是電腦（觀戰） */
export type Opponent = 'hotseat' | 'ai' | 'aiA' | 'aivai';

const randomSeed = () => (Math.random() * 2 ** 32) >>> 0;

export class LocalGame {
  private match: Match;
  private rng = new Rng(randomSeed());
  /** 各席位還沒看過的結算事件；換手時才播放，避免對方看到 */
  private unseen: [Unseen | null, Unseen | null] = [null, null];
  /** 這場的紀錄；結束或中途重開時上傳 */
  private record!: BattleRecord;
  private uploaded = false;

  constructor(
    private deliver: (msg: ServerMessage) => void,
    public opponent: Opponent = 'ai',
    /** 出擊準備選的陣容；沒有就照資料包的隨機規則 */
    public rosters?: [RosterEntry[], RosterEntry[]],
    /** 勝利條件與部署方式 */
    public settings: BattleSettings = DEFAULT_SETTINGS,
    /** 重演戰役：電腦那一方照劇本走 */
    public scenario?: Scenario,
  ) {
    this.match = this.newMatch();
  }

  private newMatch(): Match {
    const seed = randomSeed();
    const seats = (this.aiSeats().length === 2 ? ['ai', 'ai'] : this.aiSeats().length === 1 ? ['human', 'ai'] : ['human', 'human']) as BattleRecord['seats'];
    const version = contentVersion();
    this.record = {
      format: 1,
      seed,
      contentVersion: version,
      rules: config.RULES_VERSION,
      pack: version === 'draft' ? (draftPack ?? undefined) : undefined,
      rosters: this.rosters && structuredClone(this.rosters),
      settings: structuredClone(this.settings),
      seats,
      build: __BUILD__,
      startedAt: new Date().toISOString(),
      steps: [],
      winner: null,
      turns: 0,
    };
    this.uploaded = false;
    return new Match(seed, createGame(seed, this.rosters, this.settings));
  }

  /** 送出這一步的指令並記進紀錄 */
  private send(seat: PlayerId, orders: BattleStep['orders']): string[] {
    const phase = this.match.phase;
    if (phase === 'over') return ['對戰已結束'];
    const step: BattleStep = { seat, phase, orders: structuredClone(orders) };
    const errors = submitStep(this.match, step);
    if (!errors.length) this.record.steps.push(step);
    return errors;
  }

  /** 上傳這場的紀錄（每場只傳一次）；關掉分頁時也會呼叫 */
  upload(): void {
    if (this.uploaded) return;
    this.uploaded = true;
    uploadBattle({ ...this.record, winner: this.match.state.winner, turns: this.match.state.turn });
  }

  private aiSeats(): PlayerId[] {
    return this.opponent === 'aivai' ? [0, 1] : this.opponent === 'ai' ? [1] : this.opponent === 'aiA' ? [0] : [];
  }

  private humanSeats(): PlayerId[] {
    return ([0, 1] as PlayerId[]).filter((p) => !this.aiSeats().includes(p));
  }

  /** 處理指令；回傳下一個該拿裝置的席位，送出失敗則回傳 null */
  submit(seat: PlayerId, msg: ClientMessage): PlayerId | null {
    if (msg.t === 'setup' || msg.t === 'join' || msg.t === 'note') return null;
    if (msg.t === 'reset') {
      // 打到一半重開也上傳，卡住而放棄的對局最值得檢討
      this.upload();
      this.match = this.newMatch();
      this.unseen = [null, null];
      return 0;
    }
    const ok = this.step(() => {
      const errors = this.send(seat, msg.t === 'moves' ? msg.moves : msg.t === 'pursuits' ? msg.pursuits : msg.t === 'deploy' ? msg.deploy : msg.actions);
      if (errors.length) this.deliver({ t: 'error', errors });
      return errors.length === 0;
    });
    if (!ok) return null;
    if (this.opponent !== 'hotseat') return seat;
    // 同機輪流：交給這一步還要下指令的一方（王牌移動、追擊可能只有一方要下）
    const other = (1 - seat) as PlayerId;
    if (this.match.phase === 'over') return other;
    return !this.match.viewFor(other).submitted[other] ? other : !this.match.viewFor(seat).submitted[seat] ? seat : other;
  }

  /** 電腦對戰電腦：走一步 */
  autoStep(): void {
    this.step(() => true);
  }

  /**
   * 先讓人送出，再讓電腦補上還沒送出的席位。結算後如果下一步只有電腦要下指令（例如只有電腦能追擊），
   * 電腦接著下，直到輪到人或對戰結束；各席位還沒看過的結算事件累積起來，換手時一起播放
   */
  private step(human: () => boolean): boolean {
    let views = [this.match.viewFor(0), this.match.viewFor(1)];
    let seen = this.match.resolvedCount;
    if (!human()) return false;
    let resolved = false;
    const capture = () => {
      if (this.match.resolvedCount === seen) return false;
      for (const p of [0, 1] as PlayerId[]) {
        const prev = this.unseen[p];
        const events = this.match.eventsFor(p);
        this.unseen[p] = prev ? { before: prev.before, events: [...prev.events, ...events] } : { before: views[p], events };
      }
      views = [this.match.viewFor(0), this.match.viewFor(1)];
      seen = this.match.resolvedCount;
      resolved = true;
      return true;
    };
    capture();
    for (let guard = 0; guard < 12 && this.match.phase !== 'over'; guard++) {
      if (this.opponent === 'aivai' ? resolved : this.humanSeats().some((p) => !this.match.viewFor(p).submitted[p])) break;
      let acted = false;
      for (const p of this.aiSeats()) {
        if ((this.match.phase as string) === 'over') break;
        const v = this.match.viewFor(p);
        if (v.submitted[p]) continue;
        this.send(p, this.scenario ? scriptedOrders(this.scenario, v, this.rng) : aiOrders(v, this.rng));
        acted = true;
        if (capture()) break;
      }
      if (!acted) break;
    }
    if (this.match.phase === 'over') this.upload();
    return true;
  }

  takeOver(seat: PlayerId): void {
    const unseen = this.unseen[seat];
    this.unseen[seat] = null;
    if (unseen) {
      this.deliver({ t: 'state', view: unseen.before, connected: [true, true], deadline: null });
      this.deliver({ t: 'resolved', events: unseen.events });
    }
    this.deliver({ t: 'state', view: this.match.viewFor(seat), connected: [true, true], deadline: null });
  }
}
