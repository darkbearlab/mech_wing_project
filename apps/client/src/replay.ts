// 對戰紀錄的清單與重播：從內容 API 讀紀錄（要管理金鑰），照紀錄一步一步重算，用觀戰的畫面播放，並列出玩家（代理）每一步留下的話。
import {
  recordStart,
  replayRecord,
  type BattleNote,
  type BattleRecord,
  type GameEvent,
  type PlayerView,
  type ServerMessage,
  type TurnPhase,
} from "@mech/rules";
import { API } from "./content";

/** 和機庫編輯器共用同一把管理金鑰 */
const KEY_STORE = "mech.adminKey";

export function adminKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
}

export function setAdminKey(key: string): void {
  try {
    localStorage.setItem(KEY_STORE, key);
  } catch {}
}

export interface BattleRow {
  id: number;
  created_at: string;
  content_version: string;
  opponent: string;
  winner: string | null;
  turns: number;
  room: string | null;
  notes: number | null;
}

async function get<T>(path: string): Promise<T> {
  const key = adminKey();
  const res = await fetch(`${API}${path}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  if (res.status === 401) throw new Error("需要管理金鑰");
  if (!res.ok) throw new Error(`讀取失敗（${res.status}）`);
  return (await res.json()) as T;
}

export const listBattles = (limit = 200) =>
  get<BattleRow[]>(`/battles?limit=${limit}`);
export const loadBattle = (id: number) => get<BattleRecord>(`/battles/${id}`);

/** 一次結算：結算前是第幾回合、哪一步，結算的事件與結算後的畫面 */
export interface Frame {
  turn: number;
  phase: TurnPhase;
  events: GameEvent[];
  view: PlayerView;
}

/** 重播一場紀錄：shown 是已經播到第幾次結算（0 是開場） */
export class RecordPlayer {
  readonly frames: Frame[] = [];
  readonly start: PlayerView;
  readonly errors: string[];
  shown = 0;

  constructor(
    readonly rec: BattleRecord,
    private deliver: (msg: ServerMessage) => void,
  ) {
    let turn = 1;
    const out = replayRecord(rec, (m, phase) => {
      this.frames.push({
        turn,
        phase,
        events: m.spectatorEvents(),
        view: m.spectatorView(),
      });
      turn = m.state.turn;
    });
    this.errors = out.errors;
    // 照紀錄當時的規則版本開場
    this.start = recordStart(rec, out.rules).spectatorView();
  }

  private state(view: PlayerView) {
    this.deliver({
      t: "state",
      view,
      connected: [true, true],
      deadline: null,
      game: 1,
    });
  }

  begin() {
    this.shown = 0;
    this.state(this.start);
  }

  /** 播下一次結算（有動畫） */
  next(): boolean {
    const f = this.frames[this.shown];
    if (!f) return false;
    this.shown++;
    this.deliver({ t: "resolved", events: f.events });
    this.state(f.view);
    return true;
  }

  /** 跳到第 n 次結算之後（沒有動畫） */
  seek(n: number) {
    this.shown = Math.max(0, Math.min(this.frames.length, n));
    this.state(this.shown ? this.frames[this.shown - 1].view : this.start);
  }

  get current(): Frame | null {
    return this.shown ? this.frames[this.shown - 1] : null;
  }

  /** 剛播完的這一步，雙方送出指令時留下的話 */
  notesNow(): BattleNote[] {
    const f = this.current;
    return f
      ? (this.rec.notes ?? []).filter(
          (n) => n.turn === f.turn && n.phase === f.phase,
        )
      : [];
  }

  /** 播到最後：對戰結束後的感想 */
  notesOver(): BattleNote[] {
    return this.shown >= this.frames.length
      ? (this.rec.notes ?? []).filter((n) => n.phase === "over")
      : [];
  }

  /** 下一步雙方送出指令時寫的話（還沒播出結果，先看他們打算怎麼做） */
  notesNext(): BattleNote[] {
    const f = this.frames[this.shown];
    return f
      ? (this.rec.notes ?? []).filter(
          (n) => n.turn === f.turn && n.phase === f.phase,
        )
      : [];
  }
}
