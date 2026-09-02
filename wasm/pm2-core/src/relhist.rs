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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bucket_value(key: i32) -> f32 {
        GAMMA.powf(key as f64 - 0.5) as f32
    }

    fn quantile(h: &RelHist, q: f64) -> f32 {
        if h.count == 0 {
            return 0.0;
        }
        let wire = h.to_wire();
        let n = u32::from_le_bytes(wire[4..8].try_into().unwrap()) as usize;
        let mut keys = Vec::with_capacity(n);
        let mut counts = Vec::with_capacity(n);
        let mut off = 8usize;
        for _ in 0..n {
            let k = i32::from_le_bytes(wire[off..off + 4].try_into().unwrap());
            let c = u32::from_le_bytes(wire[off + 4..off + 8].try_into().unwrap());
            keys.push(k);
            counts.push(c);
            off += 8;
        }
        if q <= 0.0 {
            return bucket_value(keys[0]);
        }
        if q >= 1.0 {
            return bucket_value(*keys.last().unwrap());
        }
        let target = q * (h.count as f64 - 1.0);
        let mut rank = 0u32;
        for i in 0..n {
            let c = counts[i];
            if (rank + c) as f64 > target {
                return bucket_value(keys[i]);
            }
            rank += c;
        }
        bucket_value(*keys.last().unwrap())
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
