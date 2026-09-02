//! Compact columnar storage and memory arena for MongoDB log data.

use hashbrown::HashMap;
use memchr::memchr;

use crate::fingerprint::{detect_op, generate_fingerprint};
use crate::parse::{parse_line, ParsedLine};

const INGEST_CAP: usize = 32 * 1024 * 1024; // 32MB streaming ingest window

#[derive(Clone, Default)]
pub struct DriverInfo {
    pub name: String,
    pub version: String,
    pub platform: String,
    pub os_name: String,
    pub os_version: String,
    pub count: u32,
}

#[derive(Clone)]
pub struct ErrorRecord {
    pub timestamp: String,
    pub severity: u8,
    pub id: u32,
    pub msg: String,
    pub count: u32,
}

#[derive(Clone)]
pub struct CheckpointRecord {
    pub timestamp: String,
    pub msg: String,
}

pub struct Engine {
    pub ingest: Vec<u8>,
    pub carry: Vec<u8>,
    pub carry_abs: u64,
    pub file_size: u64,

    // Columnar Query Store
    pub timestamps_ms: Vec<i64>,
    pub durations_ms: Vec<u32>,
    pub ns_ids: Vec<u16>,
    pub op_ids: Vec<u8>,
    pub plan_ids: Vec<u16>,
    pub fingerprint_ids: Vec<u16>,
    pub docs_examined: Vec<u32>,
    pub keys_examined: Vec<u32>,
    pub nreturned: Vec<u32>,
    pub num_yields: Vec<u32>,
    pub reslens: Vec<u32>,
    pub is_collscan: Vec<bool>,
    pub command_spans: Vec<(u32, u32)>, // offset and length into command_arena

    // Arenas and Tables
    pub ns_strings: Vec<String>,
    pub ns_table: HashMap<String, u16>,

    pub plan_strings: Vec<String>,
    pub plan_table: HashMap<String, u16>,

    pub fingerprint_strings: Vec<String>,
    pub fingerprint_table: HashMap<String, u16>,
    pub index_suggestions: Vec<String>,

    pub command_arena: Vec<u8>,

    // Diagnostics Stats
    pub conn_accepted: u32,
    pub conn_ended: u32,
    pub conn_peak: u32,
    pub auth_success: u32,
    pub auth_fail: u32,
    pub drivers: Vec<DriverInfo>,
    pub errors: Vec<ErrorRecord>,
    pub checkpoints: Vec<CheckpointRecord>,
    pub dates: Vec<String>,

    pub total_lines: usize,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    pub fn new() -> Self {
        Engine {
            ingest: Vec::with_capacity(4 * 1024 * 1024),
            carry: Vec::new(),
            carry_abs: 0,
            file_size: 0,

            timestamps_ms: Vec::with_capacity(16384),
            durations_ms: Vec::with_capacity(16384),
            ns_ids: Vec::with_capacity(16384),
            op_ids: Vec::with_capacity(16384),
            plan_ids: Vec::with_capacity(16384),
            fingerprint_ids: Vec::with_capacity(16384),
            docs_examined: Vec::with_capacity(16384),
            keys_examined: Vec::with_capacity(16384),
            nreturned: Vec::with_capacity(16384),
            num_yields: Vec::with_capacity(16384),
            reslens: Vec::with_capacity(16384),
            is_collscan: Vec::with_capacity(16384),
            command_spans: Vec::with_capacity(16384),

            ns_strings: Vec::new(),
            ns_table: HashMap::new(),

            plan_strings: Vec::new(),
            plan_table: HashMap::new(),

            fingerprint_strings: Vec::new(),
            fingerprint_table: HashMap::new(),
            index_suggestions: Vec::new(),

            command_arena: Vec::with_capacity(1024 * 1024),

            conn_accepted: 0,
            conn_ended: 0,
            conn_peak: 0,
            auth_success: 0,
            auth_fail: 0,
            drivers: Vec::new(),
            errors: Vec::new(),
            checkpoints: Vec::new(),
            dates: Vec::new(),

            total_lines: 0,
        }
    }

    pub fn clear(&mut self) {
        self.carry.clear();
        self.carry_abs = 0;
        self.timestamps_ms.clear();
        self.durations_ms.clear();
        self.ns_ids.clear();
        self.op_ids.clear();
        self.plan_ids.clear();
        self.fingerprint_ids.clear();
        self.docs_examined.clear();
        self.keys_examined.clear();
        self.nreturned.clear();
        self.num_yields.clear();
        self.reslens.clear();
        self.is_collscan.clear();
        self.command_spans.clear();

        self.ns_strings.clear();
        self.ns_table.clear();
        self.plan_strings.clear();
        self.plan_table.clear();
        self.fingerprint_strings.clear();
        self.fingerprint_table.clear();
        self.index_suggestions.clear();
        self.command_arena.clear();

        self.conn_accepted = 0;
        self.conn_ended = 0;
        self.conn_peak = 0;
        self.auth_success = 0;
        self.auth_fail = 0;
        self.drivers.clear();
        self.errors.clear();
        self.checkpoints.clear();
        self.dates.clear();
        self.total_lines = 0;
    }

    pub fn ingest_ptr(&mut self, len: u32) -> u32 {
        let n = (len as usize).min(INGEST_CAP);
        if self.ingest.len() < n {
            self.ingest.resize(n, 0);
        }
        self.ingest.as_mut_ptr() as u32
    }

    pub fn feed(&mut self, len: u32, abs_off: u64) -> u32 {
        let len = (len as usize).min(self.ingest.len());
        if self.carry.is_empty() {
            self.feed_direct(len)
        } else {
            self.feed_with_carry(len, abs_off)
        }
    }

    fn feed_direct(&mut self, len: usize) -> u32 {
        let before = self.durations_ms.len();
        let ingest = std::mem::take(&mut self.ingest);
        let view = &ingest[..len];
        let mut i = 0usize;

        while let Some(pos) = memchr(b'\n', &view[i..]) {
            let line_end = i + pos;
            let line = &view[i..line_end];
            self.accept_line(line);
            i = line_end + 1;
        }

        if i < len {
            self.carry.extend_from_slice(&view[i..]);
        }

        self.ingest = ingest;
        (self.durations_ms.len() - before) as u32
    }

    fn feed_with_carry(&mut self, len: usize, _abs_off: u64) -> u32 {
        let before = self.durations_ms.len();
        let ingest = std::mem::take(&mut self.ingest);
        let view = &ingest[..len];

        if let Some(pos) = memchr(b'\n', view) {
            self.carry.extend_from_slice(&view[..pos]);
            let carry = std::mem::take(&mut self.carry);
            self.accept_line(&carry);
            let mut i = pos + 1;

            while let Some(next_pos) = memchr(b'\n', &view[i..]) {
                let line_end = i + next_pos;
                let line = &view[i..line_end];
                self.accept_line(line);
                i = line_end + 1;
            }

            if i < len {
                self.carry.extend_from_slice(&view[i..]);
            }
        } else {
            self.carry.extend_from_slice(view);
        }

        self.ingest = ingest;
        (self.durations_ms.len() - before) as u32
    }

    pub fn end_shard(&mut self) {
        if !self.carry.is_empty() {
            let carry = std::mem::take(&mut self.carry);
            self.accept_line(&carry);
        }
    }

    #[inline]
    fn intern_ns(&mut self, ns: &str) -> u16 {
        if let Some(&id) = self.ns_table.get(ns) {
            id
        } else {
            let id = self.ns_strings.len() as u16;
            self.ns_strings.push(ns.to_string());
            self.ns_table.insert(ns.to_string(), id);
            id
        }
    }

    #[inline]
    fn intern_plan(&mut self, plan: &str) -> u16 {
        if let Some(&id) = self.plan_table.get(plan) {
            id
        } else {
            let id = self.plan_strings.len() as u16;
            self.plan_strings.push(plan.to_string());
            self.plan_table.insert(plan.to_string(), id);
            id
        }
    }

    #[inline]
    fn intern_fingerprint(&mut self, fp: &str, suggestion: &str) -> u16 {
        if let Some(&id) = self.fingerprint_table.get(fp) {
            id
        } else {
            let id = self.fingerprint_strings.len() as u16;
            self.fingerprint_strings.push(fp.to_string());
            self.index_suggestions.push(suggestion.to_string());
            self.fingerprint_table.insert(fp.to_string(), id);
            id
        }
    }

    pub fn accept_line(&mut self, line: &[u8]) {
        self.total_lines += 1;
        let line = trim_line(line);
        if line.is_empty() {
            return;
        }

        match parse_line(line) {
            ParsedLine::SlowQuery(q) => {
                let ns_id = self.intern_ns(q.ns);
                let plan_id = self.intern_plan(q.plan_summary);

                let op = detect_op(q.command_bytes);
                let fp_res = generate_fingerprint(op, q.collection, q.command_bytes, q.is_collscan);
                let fp_id = self.intern_fingerprint(&fp_res.fingerprint, &fp_res.index_suggestion);

                // Store command in arena
                let cmd_off = self.command_arena.len() as u32;
                let cmd_len = q.command_bytes.len().min(4096) as u32;
                self.command_arena.extend_from_slice(&q.command_bytes[..cmd_len as usize]);

                self.timestamps_ms.push(q.epoch_ms);
                self.durations_ms.push(q.duration_ms);
                self.ns_ids.push(ns_id);
                self.op_ids.push(op as u8);
                self.plan_ids.push(plan_id);
                self.fingerprint_ids.push(fp_id);
                self.docs_examined.push(q.docs_examined);
                self.keys_examined.push(q.keys_examined);
                self.nreturned.push(q.nreturned);
                self.num_yields.push(q.num_yields);
                self.reslens.push(q.reslen);
                self.is_collscan.push(q.is_collscan);
                self.command_spans.push((cmd_off, cmd_len));

                if q.timestamp.len() >= 10 {
                    let d = &q.timestamp[..10];
                    if self.dates.last().map(|s| s.as_str()) != Some(d) && !self.dates.iter().any(|s| s == d) {
                        self.dates.push(d.to_string());
                    }
                }
            }
            ParsedLine::ConnectionAccepted { connection_count, .. } => {
                self.conn_accepted += 1;
                if connection_count > self.conn_peak {
                    self.conn_peak = connection_count;
                }
            }
            ParsedLine::ConnectionEnded { .. } => {
                self.conn_ended += 1;
            }
            ParsedLine::AuthSuccess { .. } => {
                self.auth_success += 1;
            }
            ParsedLine::AuthFail { .. } => {
                self.auth_fail += 1;
            }
            ParsedLine::ClientMetadata {
                driver_name,
                driver_version,
                platform,
                os_name,
                os_version,
            } => {
                if let Some(existing) = self.drivers.iter_mut().find(|d| d.name == driver_name && d.version == driver_version) {
                    existing.count += 1;
                } else {
                    self.drivers.push(DriverInfo {
                        name: driver_name.to_string(),
                        version: driver_version.to_string(),
                        platform: platform.to_string(),
                        os_name: os_name.to_string(),
                        os_version: os_version.to_string(),
                        count: 1,
                    });
                }
            }
            ParsedLine::Checkpoint { timestamp, msg } => {
                if self.checkpoints.len() < 100 {
                    self.checkpoints.push(CheckpointRecord {
                        timestamp: timestamp.to_string(),
                        msg: msg.to_string(),
                    });
                }
            }
            ParsedLine::Error { timestamp, severity, id, msg } => {
                if let Some(existing) = self.errors.iter_mut().find(|e| e.id == id && e.msg == msg) {
                    existing.count += 1;
                } else if self.errors.len() < 200 {
                    self.errors.push(ErrorRecord {
                        timestamp: timestamp.to_string(),
                        severity,
                        id,
                        msg: msg.to_string(),
                        count: 1,
                    });
                }
            }
            ParsedLine::Ignored => {}
        }
    }

    pub fn slow_query_count(&self) -> u32 {
        self.durations_ms.len() as u32
    }
}

#[inline]
fn trim_line(bytes: &[u8]) -> &[u8] {
    let mut start = 0;
    while start < bytes.len() && (bytes[start] == b' ' || bytes[start] == b'\t' || bytes[start] == b'\r') {
        start += 1;
    }
    let mut end = bytes.len();
    while end > start && (bytes[end - 1] == b' ' || bytes[end - 1] == b'\t' || bytes[end - 1] == b'\r') {
        end -= 1;
    }
    &bytes[start..end]
}
