// 本機模式：Match 直接跑在瀏覽器裡，給 GitHub Pages 這類沒有伺服器的環境用。
// 回傳的訊息格式和 WebSocket 伺服器相同，main.ts 不需要分辨來源。
import { Match, Rng, aiActions, aiMoves, createGame, type ClientMessage, type GameEvent, type PlayerId, type PlayerView, type RosterEntry, type ServerMessage } from '@mech/rules';

interface Unseen {
  /** 結算前的畫面，播放動畫需要起點 */
  before: PlayerView;
  events: GameEvent[];
}

/** hotseat：同一台裝置輪流；ai：A 方是人、B 方是電腦；aivai：雙方都是電腦（觀戰） */
export type Opponent = 'hotseat' | 'ai' | 'aivai';

const randomSeed = () => (Math.random() * 2 ** 32) >>> 0;

export class LocalGame {
  private match: Match;
  private rng = new Rng(randomSeed());
  /** 各席位還沒看過的結算事件；換手時才播放，避免對方看到 */
  private unseen: [Unseen | null, Unseen | null] = [null, null];

  constructor(
    private deliver: (msg: ServerMessage) => void,
    public opponent: Opponent = 'ai',
    /** 出擊準備選的陣容；沒有就照資料包的隨機規則 */
    public rosters?: [RosterEntry[], RosterEntry[]],
  ) {
    this.match = this.newMatch();
  }

  private newMatch(): Match {
    const seed = randomSeed();
    return new Match(seed, createGame(seed, this.rosters));
  }

  private aiSeats(): PlayerId[] {
    return this.opponent === 'aivai' ? [0, 1] : this.opponent === 'ai' ? [1] : [];
  }

  /** 處理指令；回傳下一個該拿裝置的席位，送出失敗則回傳 null */
  submit(seat: PlayerId, msg: ClientMessage): PlayerId | null {
    if (msg.t === 'reset') {
      this.match = this.newMatch();
      this.unseen = [null, null];
      return 0;
    }
    const ok = this.step(() => {
      const errors = msg.t === 'moves' ? this.match.submitMoves(seat, msg.moves) : this.match.submitActions(seat, msg.actions);
      if (errors.length) this.deliver({ t: 'error', errors });
      return errors.length === 0;
    });
    if (!ok) return null;
    return this.opponent === 'hotseat' ? ((1 - seat) as PlayerId) : seat;
  }

  /** 電腦對戰電腦：雙方各下一步 */
  autoStep(): void {
    this.step(() => true);
  }

  /** 先讓人送出，再讓電腦補上還沒送出的席位；有結算就記下各席位要播放的內容 */
  private step(human: () => boolean): boolean {
    const before = this.match.resolvedCount;
    const views = [this.match.viewFor(0), this.match.viewFor(1)];
    if (!human()) return false;
    for (const p of this.aiSeats()) {
      const phase = this.match.phase;
      if (phase === 'over' || this.match.resolvedCount !== before) break;
      const v = this.match.viewFor(p);
      if (v.submitted[p]) continue;
      if (phase === 'move') this.match.submitMoves(p, aiMoves(v, this.rng));
      else this.match.submitActions(p, aiActions(v, this.rng));
    }
    if (this.match.resolvedCount !== before) this.unseen = [{ before: views[0], events: this.match.eventsFor(0) }, { before: views[1], events: this.match.eventsFor(1) }];
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
