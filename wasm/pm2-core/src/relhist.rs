//! Relative-error histogram (parity with src/parser/relHist.ts, a=0.01).

use hashbrown::HashMap;

const RELATIVE_ACCURACY: f64 = 0.01;
const GAMMA: f64 = (1.0 + RELATIVE_ACCURACY) / (1.0 - RELATIVE_ACCURACY);
/// 1/ln(γ); precomputed so accept() never calls ln(γ) (value.ln() still per sample).
const INV_LOG_GAMMA: f64 = 1.0 / 0.020000666688891502; // == 1.0 / GAMMA.ln()

#[derive(Clone, Debug)]
pub struct RelHist {
    buckets: HashMap<i32, u32>,
    pub count: u32,
}

impl Default for RelHist {
    fn default() -> Self {
        Self {
            buckets: HashMap::new(),
            count: 0,
        }
    }
}

impl RelHist {
    pub fn new() -> Self {
        Self::default()
    }

    #[inline]
    pub fn accept(&mut self, value: f32) {
        let v = value as f64;
        if !(v > 0.0) || !v.is_finite() {
            return;
        }
        let key = (v.ln() * INV_LOG_GAMMA).ceil() as i32;
        *self.buckets.entry(key).or_insert(0) += 1;
        self.count += 1;
    }

    #[allow(dead_code)]
    pub fn merge(&mut self, other: &RelHist) {
        for (&k, &c) in &other.buckets {
            *self.buckets.entry(k).or_insert(0) += c;
        }
        self.count += other.count;
    }

    #[allow(dead_code)]
    pub fn quantile(&self, q: f64) -> f32 {
        if self.count == 0 {
            return 0.0;
        }
        let mut keys: Vec<i32> = self.buckets.keys().copied().collect();
        keys.sort_unstable();
        if q <= 0.0 {
            return bucket_value(keys[0]);
        }
        if q >= 1.0 {
            return bucket_value(*keys.last().unwrap());
        }
        let target = q * (self.count as f64 - 1.0);
        let mut rank = 0u32;
        for &k in &keys {
            let c = *self.buckets.get(&k).unwrap();
            if (rank + c) as f64 > target {
                return bucket_value(k);
            }
            rank += c;
        }
        bucket_value(*keys.last().unwrap())
    }

    /// Encode as [count:u32][n:u32][key:i32, cnt:u32]×n little-endian (keys sorted).
    pub fn to_wire(&self) -> Vec<u8> {
        let mut keys: Vec<i32> = self.buckets.keys().copied().collect();
        keys.sort_unstable();
        let mut out = Vec::with_capacity(8 + keys.len() * 8);
        out.extend_from_slice(&self.count.to_le_bytes());
        let n = keys.len() as u32;
        out.extend_from_slice(&n.to_le_bytes());
        for k in keys {
            let c = self.buckets[&k];
            out.extend_from_slice(&k.to_le_bytes());
            out.extend_from_slice(&c.to_le_bytes());
        }
        out
    }

    #[allow(dead_code)]
    pub fn from_wire(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 8 {
            return None;
        }
        let count = u32::from_le_bytes(bytes[0..4].try_into().ok()?);
        let n = u32::from_le_bytes(bytes[4..8].try_into().ok()?);
        let mut h = RelHist::new();
        h.count = count;
        let mut off = 8usize;
        for _ in 0..n {
            if off + 8 > bytes.len() {
                return None;
            }
            let k = i32::from_le_bytes(bytes[off..off + 4].try_into().ok()?);
            let c = u32::from_le_bytes(bytes[off + 4..off + 8].try_into().ok()?);
            h.buckets.insert(k, c);
            off += 8;
        }
        Some(h)
    }
}

fn bucket_value(key: i32) -> f32 {
    GAMMA.powf(key as f64 - 0.5) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantile_approx() {
        let mut h = RelHist::new();
        for i in 1..=1000 {
            h.accept((i * 10) as f32);
        }
        let p95 = h.quantile(0.95);
        assert!((p95 - 9500.0).abs() / 9500.0 < 0.02, "p95={p95}");
    }
}
