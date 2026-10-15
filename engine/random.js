import { createHash, randomBytes } from 'node:crypto';

// A cryptographically seeded deterministic stream. Seeds are CLI/test-only.
export class Random {
  constructor(seed, forbidden = []) {
    this.key = seed === undefined ? randomBytes(32) : createHash('sha256').update(String(seed)).digest();
    this.counter = 0; this.pool = Buffer.alloc(0); this.offset = 0;
    this.names = new Set(forbidden);
  }
  word() {
    if (this.offset + 4 > this.pool.length) {
      const count = Buffer.alloc(8); count.writeBigUInt64BE(BigInt(this.counter++));
      this.pool = createHash('sha256').update(this.key).update(count).digest(); this.offset = 0;
    }
    const value = this.pool.readUInt32LE(this.offset); this.offset += 4; return value;
  }
  next() { return this.word() / 4294967296; }
  int(min, max) {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min || max-min >= 4294967296) throw new RangeError('Invalid random interval');
    const size = max - min + 1, cap = Math.floor(4294967296 / size) * size;
    let word; do { word = this.word(); } while (word >= cap);
    return min + word % size;
  }
  shuffle(array) {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) { const j = this.int(0, i); [result[i], result[j]] = [result[j], result[i]]; }
    return result;
  }
  bytes(n) { return Array.from({length:n}, () => this.int(0,255)); }
  name() {
    let name;
    do { name = '_'; for (let i=0; i<12; i++) name += 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'[this.int(0,51)]; } while (this.names.has(name));
    this.names.add(name); return name;
  }
}
