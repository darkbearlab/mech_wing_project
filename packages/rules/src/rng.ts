// mulberry32：狀態只有一個 32-bit 整數，存在 GameState 裡即可重播。
export class Rng {
  constructor(public state: number) {}

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 1..n */
  die(n: number): number {
    return 1 + Math.floor(this.next() * n);
  }

  d100(): number {
    return this.die(100);
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  pickWeighted<T>(items: T[], weight: (item: T) => number): T {
    const total = items.reduce((s, i) => s + weight(i), 0);
    let r = this.next() * total;
    for (const item of items) {
      r -= weight(item);
      if (r < 0) return item;
    }
    return items[items.length - 1];
  }
}
