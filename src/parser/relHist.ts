/**
 * Positive-only relative-error quantile sketch (DDSketch-style buckets).
 * relativeAccuracy a=0.01 → γ=(1+a)/(1-a); key = ceil(ln(v)/ln(γ)).
 */

const RELATIVE_ACCURACY = 0.01;
const GAMMA = (1 + RELATIVE_ACCURACY) / (1 - RELATIVE_ACCURACY);
const INV_LOG_GAMMA = 1 / Math.log(GAMMA);

const BUCKET_TABLE_SIZE = 512;
const BUCKET_TABLE = new Float32Array(BUCKET_TABLE_SIZE);
for (let k = 0; k < BUCKET_TABLE_SIZE; k++) {
  BUCKET_TABLE[k] = Math.pow(GAMMA, k - 0.5);
}

function bucketValue(key: number): number {
  if (key >= 0 && key < BUCKET_TABLE_SIZE) {
    return BUCKET_TABLE[key]!;
  }
  return Math.pow(GAMMA, key - 0.5);
}

export type RelHistWire = { buckets: [number, number][]; count: number };

export class RelHist {
  private buckets = new Map<number, number>();
  count = 0;

  accept(value: number): void {
    if (!(value > 0) || !Number.isFinite(value)) return;
    const key = Math.ceil(Math.log(value) * INV_LOG_GAMMA);
    this.buckets.set(key, (this.buckets.get(key) ?? 0) + 1);
    this.count++;
  }

  merge(other: RelHist): void {
    for (const [k, c] of other.buckets) {
      this.buckets.set(k, (this.buckets.get(k) ?? 0) + c);
    }
    this.count += other.count;
  }

  mergeWire(wire: RelHistWire): void {
    for (const [k, c] of wire.buckets) {
      this.buckets.set(k, (this.buckets.get(k) ?? 0) + c);
    }
    this.count += wire.count;
  }

  toWire(): RelHistWire {
    const buckets: [number, number][] = [];
    for (const [k, c] of this.buckets) buckets.push([k, c]);
    return { buckets, count: this.count };
  }

  static fromWire(wire: RelHistWire): RelHist {
    const h = new RelHist();
    h.mergeWire(wire);
    return h;
  }

  quantile(q: number): number {
    if (this.count === 0) return 0;
    const keys = Array.from(this.buckets.keys()).sort((a, b) => a - b);
    if (q <= 0) return bucketValue(keys[0]!);
    if (q >= 1) return bucketValue(keys[keys.length - 1]!);
    const target = q * (this.count - 1);
    let rank = 0;
    for (const k of keys) {
      const c = this.buckets.get(k)!;
      if (rank + c > target) return bucketValue(k);
      rank += c;
    }
    return bucketValue(keys[keys.length - 1]!);
  }

  quantiles4(): [number, number, number, number] {
    const count = this.count;
    if (count === 0) return [0, 0, 0, 0];
    const keys = Array.from(this.buckets.keys()).sort((a, b) => a - b);
    const lastVal = bucketValue(keys[keys.length - 1]!);
    const t50 = 0.5 * (count - 1);
    const t90 = 0.9 * (count - 1);
    const t95 = 0.95 * (count - 1);
    const t99 = 0.99 * (count - 1);
    let p50 = -1;
    let p90 = -1;
    let p95 = -1;
    let p99 = -1;
    let rank = 0;
    for (const k of keys) {
      const c = this.buckets.get(k)!;
      const nextRank = rank + c;
      const v = bucketValue(k);
      if (p50 < 0 && nextRank > t50) p50 = v;
      if (p90 < 0 && nextRank > t90) p90 = v;
      if (p95 < 0 && nextRank > t95) p95 = v;
      if (p99 < 0 && nextRank > t99) p99 = v;
      rank = nextRank;
    }
    return [
      p50 < 0 ? lastVal : p50,
      p90 < 0 ? lastVal : p90,
      p95 < 0 ? lastVal : p95,
      p99 < 0 ? lastVal : p99,
    ];
  }
}

export function makeRelHist(): RelHist {
  return new RelHist();
}
