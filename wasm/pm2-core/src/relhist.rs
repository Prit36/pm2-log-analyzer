use hashbrown::HashMap;

#[allow(dead_code)]
const RELATIVE_ACCURACY: f64 = 0.01;
#[allow(dead_code)]
const GAMMA: f64 = (1.0 + RELATIVE_ACCURACY) / (1.0 - RELATIVE_ACCURACY);
/// 1/ln(γ); precomputed so accept() never calls ln(γ) (value.ln() still per sample).
pub const INV_LOG_GAMMA: f64 = 1.0 / 0.020000666688891502; // == 1.0 / GAMMA.ln()
pub const DENSE_LIMIT: usize = 512;

#[inline(always)]
pub fn relhist_key(value: f32) -> Option<i32> {
    let v = value as f64;
    if !(v > 0.0) || !v.is_finite() {
        None
    } else {
        Some((v.ln() * INV_LOG_GAMMA).ceil() as i32)
    }
}

#[derive(Clone, Debug)]
pub struct RelHist {
    dense: [u32; DENSE_LIMIT],
    sparse: HashMap<i32, u32>,
    pub count: u32,
}

impl Default for RelHist {
    fn default() -> Self {
        Self {
            dense: [0; DENSE_LIMIT],
            sparse: HashMap::new(),
            count: 0,
        }
    }
}

impl RelHist {
    pub fn new() -> Self {
        Self::default()
    }

    #[inline(always)]
    pub fn accept_key(&mut self, key: i32) {
        self.count += 1;
        if key >= 0 && (key as usize) < DENSE_LIMIT {
            self.dense[key as usize] += 1;
        } else {
            *self.sparse.entry(key).or_insert(0) += 1;
        }
    }

    /// Encode as [count:u32][n:u32][key:i32, cnt:u32]×n little-endian (keys sorted).
    pub fn to_wire(&self) -> Vec<u8> {
        let mut neg_keys: Vec<i32> = self.sparse.keys().copied().filter(|&k| k < 0).collect();
        neg_keys.sort_unstable();

        let mut high_keys: Vec<i32> = self
            .sparse
            .keys()
            .copied()
            .filter(|&k| k >= DENSE_LIMIT as i32)
            .collect();
        high_keys.sort_unstable();

        let mut dense_count = 0usize;
        for i in 0..DENSE_LIMIT {
            if self.dense[i] > 0 {
                dense_count += 1;
            }
        }

        let total_n = neg_keys.len() + dense_count + high_keys.len();
        let mut out = Vec::with_capacity(8 + total_n * 8);
        out.extend_from_slice(&self.count.to_le_bytes());
        out.extend_from_slice(&(total_n as u32).to_le_bytes());

        for k in neg_keys {
            let c = self.sparse[&k];
            out.extend_from_slice(&k.to_le_bytes());
            out.extend_from_slice(&c.to_le_bytes());
        }
        for i in 0..DENSE_LIMIT {
            let c = self.dense[i];
            if c > 0 {
                let k = i as i32;
                out.extend_from_slice(&k.to_le_bytes());
                out.extend_from_slice(&c.to_le_bytes());
            }
        }
        for k in high_keys {
            let c = self.sparse[&k];
            out.extend_from_slice(&k.to_le_bytes());
            out.extend_from_slice(&c.to_le_bytes());
        }
        out
    }

    pub fn merge(&mut self, other: &RelHist) {
        self.count += other.count;
        for i in 0..DENSE_LIMIT {
            self.dense[i] += other.dense[i];
        }
        for (&k, &v) in &other.sparse {
            *self.sparse.entry(k).or_insert(0) += v;
        }
    }

    pub fn from_wire(buf: &[u8]) -> Option<Self> {
        if buf.len() < 8 {
            return None;
        }
        let count = u32::from_le_bytes(buf[0..4].try_into().ok()?);
        let n = u32::from_le_bytes(buf[4..8].try_into().ok()?) as usize;
        if buf.len() < 8 + n * 8 {
            return None;
        }
        let mut dense = [0u32; DENSE_LIMIT];
        let mut sparse = HashMap::new();
        let mut off = 8;
        for _ in 0..n {
            let key = i32::from_le_bytes(buf[off..off + 4].try_into().ok()?);
            let cnt = u32::from_le_bytes(buf[off + 4..off + 8].try_into().ok()?);
            off += 8;
            if key >= 0 && (key as usize) < DENSE_LIMIT {
                dense[key as usize] = cnt;
            } else {
                sparse.insert(key, cnt);
            }
        }
        Some(Self {
            dense,
            sparse,
            count,
        })
    }

    /// Ascending keys that carry a non-zero count.
    fn ordered_keys(&self) -> Vec<i32> {
        let mut neg: Vec<i32> = self.sparse.keys().copied().filter(|&k| k < 0).collect();
        neg.sort_unstable();
        let mut high: Vec<i32> = self
            .sparse
            .keys()
            .copied()
            .filter(|&k| k >= DENSE_LIMIT as i32)
            .collect();
        high.sort_unstable();

        let mut keys = Vec::with_capacity(neg.len() + high.len() + 64);
        keys.extend_from_slice(&neg);
        for i in 0..DENSE_LIMIT {
            if self.dense[i] > 0 {
                keys.push(i as i32);
            }
        }
        keys.extend_from_slice(&high);
        keys
    }

    #[inline]
    fn count_at(&self, key: i32) -> u32 {
        if key >= 0 && (key as usize) < DENSE_LIMIT {
            self.dense[key as usize]
        } else {
            self.sparse.get(&key).copied().unwrap_or(0)
        }
    }

    /// Approximate quantile in milliseconds (parity with the JS `RelHist.quantile`).
    pub fn quantile_ms(&self, q: f64) -> f32 {
        if self.count == 0 {
            return 0.0;
        }
        let keys = self.ordered_keys();
        let last = *keys.last().expect("count > 0 implies keys");
        if q <= 0.0 {
            return bucket_value(keys[0]);
        }
        if q >= 1.0 {
            return bucket_value(last);
        }
        let target = q * (self.count as f64 - 1.0);
        let mut rank = 0u32;
        for &k in &keys {
            if (rank + self.count_at(k)) as f64 > target {
                return bucket_value(k);
            }
            rank += self.count_at(k);
        }
        bucket_value(last)
    }

    /// p50/p90/p95/p99 in a single pass (parity with the JS `RelHist.quantiles4`).
    pub fn quantiles4_ms(&self) -> [f32; 4] {
        if self.count == 0 {
            return [0.0; 4];
        }
        let keys = self.ordered_keys();
        let last_val = bucket_value(*keys.last().expect("count > 0 implies keys"));
        let count = self.count as f64;
        let targets = [
            0.5 * (count - 1.0),
            0.9 * (count - 1.0),
            0.95 * (count - 1.0),
            0.99 * (count - 1.0),
        ];
        let mut out = [-1.0f32; 4];
        let mut rank = 0u32;
        for &k in &keys {
            let next_rank = rank + self.count_at(k);
            let v = bucket_value(k);
            for i in 0..4 {
                if out[i] < 0.0 && next_rank as f64 > targets[i] {
                    out[i] = v;
                }
            }
            rank = next_rank;
        }
        [
            if out[0] < 0.0 { last_val } else { out[0] },
            if out[1] < 0.0 { last_val } else { out[1] },
            if out[2] < 0.0 { last_val } else { out[2] },
            if out[3] < 0.0 { last_val } else { out[3] },
        ]
    }
}

#[inline]
fn bucket_value(key: i32) -> f32 {
    GAMMA.powf(key as f64 - 0.5) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quantile(h: &RelHist, q: f64) -> f32 {
        h.quantile_ms(q)
    }

    #[test]
    fn quantile_approx() {
        let mut h = RelHist::new();
        for i in 1..=1000 {
            h.accept_key(relhist_key((i * 10) as f32).unwrap());
        }
        let p95 = quantile(&h, 0.95);
        assert!((p95 - 9500.0).abs() / 9500.0 < 0.02, "p95={p95}");
    }
}
