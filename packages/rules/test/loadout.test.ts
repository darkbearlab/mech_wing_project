import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTENT, validateContent } from '../src/content';
import { DEFAULT_ROSTERS, LOADOUTS } from '../src/data';
import { gearSlots, gearToSlots, slotFits, slotsToGear } from '../src/loadout';

describe('武裝掛點', () => {
  it('人形機：左右手、三個武器架、雙肩背腿掛點、兩臂內藏', () => {
    expect(gearSlots('X-00').map((s) => s.name)).toEqual(['右手', '左手', '右架', '左架', '背架', '右肩', '左肩', '背部', '腿部', '右臂內建', '左臂內建', '右臂內藏', '左臂內藏']);
  });

  it('武器腕型：手被內建武器佔住，沒有手、武器架和內藏', () => {
    expect(gearSlots('X-13').map((s) => s.kind)).toEqual(['mount', 'mount', 'mount', 'mount']);
  });

  it('掛點只收合適的裝備：盾牌不能上武器架、外掛武器只能上掛點', () => {
    const [hand, , rack] = gearSlots('X-00');
    const mount = gearSlots('X-00').find((s) => s.kind === 'mount')!;
    expect(slotFits(hand, 'shield')).toBe(true);
    expect(slotFits(rack, 'shield')).toBe(false);
    expect(slotFits(rack, 'shoulder_cannon')).toBe(false);
    expect(slotFits(mount, 'shoulder_cannon')).toBe(true);
  });

  it('所有預設配裝放進掛點再換回來：不多不少，資料檢查也通過', () => {
    const sets: [string, (typeof LOADOUTS)[string][number]][] = [
      ...Object.entries(LOADOUTS).flatMap(([c, ls]) => ls.map((g) => [c, g] as [string, typeof g])),
      ...DEFAULT_ROSTERS.flat().map((e) => [e.chassis, e.equipment] as [string, typeof e.equipment]),
    ];
    for (const [chassis, gear] of sets) {
      const { filled, extra } = gearToSlots(chassis, gear);
      expect(extra, `${chassis} ${JSON.stringify(gear)}`).toEqual([]);
      const back = slotsToGear(chassis, filled);
      expect(back.map(([d]) => d).sort()).toEqual(gear.map(([d]) => d).sort());
      const pack = { ...DEFAULT_CONTENT, loadouts: { [chassis]: [back] }, rosters: DEFAULT_CONTENT.rosters };
      expect(validateContent(pack)).toEqual([]);
    }
  });

  it('同側武器架：寫在左臂的收納武器回到左架', () => {
    const { filled } = gearToSlots('X-00', [['beam_rifle', 'right'], ['bazooka', 'stowed', 'larm'], ['beam_saber', 'stowed']]);
    expect(filled['rack-left']).toBe('bazooka');
    expect(filled['rack-back']).toBe('beam_saber');
    expect(slotsToGear('X-00', filled)).toEqual([['beam_rifle', 'right'], ['bazooka', 'stowed', 'larm'], ['beam_saber', 'stowed']]);
  });
});
