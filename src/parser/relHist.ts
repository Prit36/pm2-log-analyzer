/**
 * Positive-only relative-error quantile sketch (DDSketch-style buckets).
 * relativeAccuracy a=0.01 → γ=(1+a)/(1-a); key = ceil(ln(v)/ln(γ)).
 */

const RELATIVE_ACCURACY = 0.01;
const GAMMA = (1 + RELATIVE_ACCURACY) / (1 - RELATIVE_ACCURACY);
const INV_LOG_GAMMA = 1 / Math.log(GAMMA);

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
}

function bucketValue(key: number): number {
  return Math.pow(GAMMA, key - 0.5);
}

export function makeRelHist(): RelHist {
  return new RelHist();
}
