import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONTENT, builtinPack, replayRecord, useContent, type BattleRecord } from '../src/index';

// 各規則版本的對戰紀錄樣本（scripts/fixture.ts 產生，加上兩場聯賽的紀錄）：改了規則以後舊紀錄也要照當時的規則重播出一樣的結果
const dir = new URL('./fixtures/', import.meta.url);

describe('舊版本紀錄的重播', () => {
  afterEach(() => useContent(DEFAULT_CONTENT));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    it(f, () => {
      const rec = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as BattleRecord;
      // 內建資料也換回紀錄當時的版本
      useContent(builtinPack(rec.contentVersion) ?? DEFAULT_CONTENT);
      const out = replayRecord(rec);
      expect(out.errors).toEqual([]);
      const v = /^rules(\d+)/.exec(f)?.[1];
      if (v) expect(out.rules).toBe(Number(v));
    });
  }
});
