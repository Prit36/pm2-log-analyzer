//! Compact shard aggregates. Full group maps cross the worker boundary so top-N
//! selection and distinct counts are exact after merging all shards.

use hashbrown::{HashMap, HashSet};

use crate::aggregate::{Counts, Diagnostics, Histogram, Metrics, Partial, TimingAcc};

struct Writer(Vec<u8>);

impl Writer {
    fn u32(&mut self, value: usize) {
        self.0.extend_from_slice(&(value as u32).to_le_bytes());
    }
    fn u64(&mut self, value: u64) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }
    fn string(&mut self, value: &str) {
        self.u32(value.len());
        self.0.extend_from_slice(value.as_bytes());
    }
    fn counts(&mut self, value: &Counts) {
        self.u64(value.count);
        self.u64(value.errors);
        self.u64(value.bytes);
    }
    fn timing(&mut self, value: &TimingAcc) {
        self.u64(value.count);
        self.0.extend_from_slice(&value.sum.to_le_bytes());
        self.0.extend_from_slice(&value.min.to_le_bytes());
        self.0.extend_from_slice(&value.max.to_le_bytes());
        let buckets = value.hist.buckets();
        self.u32(buckets.len());
        for (key, count) in buckets {
            self.0.extend_from_slice(&key.to_le_bytes());
            self.u64(count);
        }
    }
    fn metrics(&mut self, value: &Metrics) {
        self.counts(&value.counts);
        self.timing(&value.request);
        self.timing(&value.upstream);
    }
    fn metrics_map(&mut self, map: &HashMap<String, Metrics>) {
        self.u32(map.len());
        for (key, value) in map {
            self.string(key);
            self.metrics(value);
        }
    }
    fn counts_map(&mut self, map: &HashMap<String, Counts>) {
        self.u32(map.len());
        for (key, value) in map {
            self.string(key);
            self.counts(value);
        }
    }
    fn strings(&mut self, values: &HashSet<String>) {
        self.u32(values.len());
        for value in values {
            self.string(value);
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    cursor: usize,
}
type ReadResult<T> = Result<T, &'static str>;

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> ReadResult<&'a [u8]> {
        let end = self
            .cursor
            .checked_add(count)
            .ok_or("Invalid Nginx partial length")?;
        let bytes = self
            .bytes
            .get(self.cursor..end)
            .ok_or("Truncated Nginx partial")?;
        self.cursor = end;
        Ok(bytes)
    }
    fn u32(&mut self) -> ReadResult<usize> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().map_err(|_| "Invalid u32")?) as usize)
    }
    fn u64(&mut self) -> ReadResult<u64> {
        Ok(u64::from_le_bytes(
            self.take(8)?.try_into().map_err(|_| "Invalid u64")?,
        ))
    }
    fn length(&mut self) -> ReadResult<usize> {
        let length = self.u32()?;
        if length > self.bytes.len() - self.cursor {
            return Err("Invalid Nginx partial count");
        }
        Ok(length)
    }
    fn string(&mut self) -> ReadResult<String> {
        let length = self.length()?;
        String::from_utf8(self.take(length)?.to_vec()).map_err(|_| "Invalid Nginx partial UTF-8")
    }
    fn counts(&mut self) -> ReadResult<Counts> {
        Ok(Counts {
            count: self.u64()?,
            errors: self.u64()?,
            bytes: self.u64()?,
        })
    }
    fn timing(&mut self) -> ReadResult<TimingAcc> {
        let count = self.u64()?;
        let sum = f64::from_le_bytes(self.take(8)?.try_into().map_err(|_| "Invalid sum")?);
        let min = f32::from_le_bytes(self.take(4)?.try_into().map_err(|_| "Invalid minimum")?);
        let max = f32::from_le_bytes(self.take(4)?.try_into().map_err(|_| "Invalid maximum")?);
        let length = self.length()?;
        let mut hist = Histogram::default();
        for _ in 0..length {
            let key = i16::from_le_bytes(
                self.take(2)?
                    .try_into()
                    .map_err(|_| "Invalid timing bucket")?,
            );
            hist.add(key, self.u64()?);
        }
        Ok(TimingAcc {
            count,
            sum,
            min,
            max,
            hist,
        })
    }
    fn metrics(&mut self) -> ReadResult<Metrics> {
        Ok(Metrics {
            counts: self.counts()?,
            request: self.timing()?,
            upstream: self.timing()?,
        })
    }
    fn metrics_map(&mut self) -> ReadResult<HashMap<String, Metrics>> {
        let length = self.length()?;
        let mut map = HashMap::new();
        for _ in 0..length {
            map.insert(self.string()?, self.metrics()?);
        }
        Ok(map)
    }
    fn counts_map(&mut self) -> ReadResult<HashMap<String, Counts>> {
        let length = self.length()?;
        let mut map = HashMap::new();
        for _ in 0..length {
            map.insert(self.string()?, self.counts()?);
        }
        Ok(map)
    }
    fn strings(&mut self) -> ReadResult<HashSet<String>> {
        let length = self.length()?;
        let mut set = HashSet::new();
        for _ in 0..length {
            set.insert(self.string()?);
        }
        Ok(set)
    }
}

impl Partial {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Writer(b"NGX1".to_vec());
        out.metrics(&self.summary);
        out.u32(self.endpoints.len());
        for ((method, path), metrics) in &self.endpoints {
            out.string(method);
            out.string(path);
            out.metrics(metrics);
        }
        out.metrics_map(&self.hourly);
        out.metrics_map(&self.daily);
        out.counts_map(&self.clients);
        out.counts_map(&self.referrers);
        out.counts_map(&self.agents);
        out.u32(self.statuses.len());
        for (status, count) in &self.statuses {
            out.0.extend_from_slice(&status.to_le_bytes());
            out.u64(*count);
        }
        out.strings(&self.dates);
        out.strings(&self.methods);
        out.u64(self.diagnostics.total_lines);
        out.u64(self.diagnostics.matched_lines);
        out.u64(self.diagnostics.unmatched_count);
        out.u64(self.diagnostics.invalid_timing_count);
        out.u32(self.diagnostics.unmatched_sample.len());
        for sample in &self.diagnostics.unmatched_sample {
            out.string(sample);
        }
        out.0
    }

    pub fn decode(bytes: &[u8]) -> ReadResult<Self> {
        let mut input = Reader { bytes, cursor: 0 };
        if input.take(4)? != b"NGX1" {
            return Err("Unsupported Nginx partial version");
        }
        let summary = input.metrics()?;
        let length = input.length()?;
        let mut endpoints = HashMap::new();
        for _ in 0..length {
            let method = input.string()?;
            let path = input.string()?;
            endpoints.insert((method, path), input.metrics()?);
        }
        let hourly = input.metrics_map()?;
        let daily = input.metrics_map()?;
        let clients = input.counts_map()?;
        let referrers = input.counts_map()?;
        let agents = input.counts_map()?;
        let length = input.length()?;
        let mut statuses = HashMap::new();
        for _ in 0..length {
            let status =
                u16::from_le_bytes(input.take(2)?.try_into().map_err(|_| "Invalid status")?);
            statuses.insert(status, input.u64()?);
        }
        let dates = input.strings()?;
        let methods = input.strings()?;
        let mut diagnostics = Diagnostics {
            total_lines: input.u64()?,
            matched_lines: input.u64()?,
            unmatched_count: input.u64()?,
            invalid_timing_count: input.u64()?,
            unmatched_sample: Vec::new(),
        };
        let length = input.length()?;
        for _ in 0..length {
            diagnostics.unmatched_sample.push(input.string()?);
        }
        if input.cursor != bytes.len() {
            return Err("Trailing Nginx partial data");
        }
        Ok(Self {
            summary,
            endpoints,
            hourly,
            daily,
            clients,
            referrers,
            agents,
            statuses,
            dates,
            methods,
            diagnostics,
        })
    }
}
