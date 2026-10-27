// 對戰紀錄上傳：本機模式每場結束（或中途重開）時把紀錄送到內容 API，用來重播檢討 AI 與平衡。
// 只有種子、陣容和雙方指令，沒有任何個人資料；出擊準備畫面可以關掉。
import type { BattleRecord } from '@mech/rules';
import { API } from './content';

const KEY = 'mech-wing-upload';

export function uploadEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setUploadEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {}
}

export function uploadBattle(rec: BattleRecord): void {
  if (!uploadEnabled() || !rec.steps.length) return;
  // 本機開發版不傳到正式 API（要測上傳就用 VITE_CONTENT_API 指向本機的 API）
  if (import.meta.env.DEV && !import.meta.env.VITE_CONTENT_API) return;
  // keepalive：關掉分頁或重開時也送得出去
  fetch(`${API}/battles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec), keepalive: true })
    .then((res) => res.json())
    .then((out) => console.info('對戰紀錄已上傳', out))
    .catch((e) => console.warn('對戰紀錄上傳失敗', e));
}
