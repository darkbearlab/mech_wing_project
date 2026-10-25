// 本機輪流模式：Match 直接跑在瀏覽器裡，給 GitHub Pages 這類沒有伺服器的環境用。
// 回傳的訊息格式和 WebSocket 伺服器相同，main.ts 不需要分辨來源。
import { Match, type ClientMessage, type GameEvent, type PlayerId, type PlayerView, type ServerMessage } from '@mech/rules';

interface Unseen {
  /** 結算前的畫面，播放動畫需要起點 */
  before: PlayerView;
  events: GameEvent[];
}

const randomSeed = () => (Math.random() * 2 ** 32) >>> 0;

export class LocalGame {
  private match = new Match(randomSeed());
  /** 各席位還沒看過的結算事件；換手時才播放，避免對方看到 */
  private unseen: [Unseen | null, Unseen | null] = [null, null];

  constructor(private deliver: (msg: ServerMessage) => void) {}

  /** 處理指令；回傳下一個該拿裝置的席位，送出失敗則回傳 null */
  submit(seat: PlayerId, msg: ClientMessage): PlayerId | null {
    if (msg.t === 'reset') {
      this.match = new Match(randomSeed());
      this.unseen = [null, null];
      return 0;
    }
    const before = this.match.resolvedCount;
    const views = [this.match.viewFor(0), this.match.viewFor(1)];
    const errors = this.match.submitPlans(seat, msg.plans);
    if (errors.length) {
      this.deliver({ t: 'error', errors });
      return null;
    }
    if (this.match.resolvedCount !== before) this.unseen = [{ before: views[0], events: this.match.eventsFor(0) }, { before: views[1], events: this.match.eventsFor(1) }];
    return (1 - seat) as PlayerId;
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
