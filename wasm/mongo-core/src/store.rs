//! Compact columnar storage and memory arena for MongoDB log data.

use hashbrown::HashMap;
use memchr::memchr;

use crate::fingerprint::{detect_op, generate_fingerprint, MongoOp};
use crate::parse::{extract_command_slice, parse_line, ParsedLine};

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

#[derive(Clone, Default)]
pub struct UserMeta {
    pub auth_db: String,
    pub app_name: String,
    pub client_ips: Vec<String>,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub auth_success_count: u32,
    pub auth_fail_count: u32,
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
    pub remote_ids: Vec<u16>,
    pub user_ids: Vec<u16>,
    pub ctx_ids: Vec<u16>,

    // Arenas and Tables
    pub ns_strings: Vec<String>,
    pub ns_table: HashMap<String, u16>,

    pub plan_strings: Vec<String>,
    pub plan_table: HashMap<String, u16>,

    pub fingerprint_strings: Vec<String>,
    pub fingerprint_table: HashMap<String, u16>,
    pub index_suggestions: Vec<String>,

    pub remote_strings: Vec<String>,
    pub remote_table: HashMap<String, u16>,

    pub user_strings: Vec<String>,
    pub user_table: HashMap<String, u16>,
    pub user_meta: Vec<UserMeta>,
    pub ctx_to_user: Vec<u16>,
    pub ctx_strings: Vec<String>,
    pub ctx_table: HashMap<String, u16>,
    pub ops_mask: u16,

    pub query_hash_cache: HashMap<(u16, u64), (MongoOp, u16)>,

    pub(crate) last_ns_id: u16,
    pub(crate) last_plan_id: u16,
    pub(crate) last_remote_id: u16,
    pub(crate) last_ctx_id: u16,
    pub(crate) last_user_id: u16,
    pub(crate) last_qhash: (u16, u64, (MongoOp, u16)),
    pub(crate) last_date: [u8; 10],

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
            ingest: Vec::with_capacity(32 * 1024 * 1024),
            carry: Vec::new(),
            carry_abs: 0,
            file_size: 0,

            timestamps_ms: Vec::with_capacity(65536),
            durations_ms: Vec::with_capacity(65536),
            ns_ids: Vec::with_capacity(65536),
            op_ids: Vec::with_capacity(65536),
            plan_ids: Vec::with_capacity(65536),
            fingerprint_ids: Vec::with_capacity(65536),
            docs_examined: Vec::with_capacity(65536),
            keys_examined: Vec::with_capacity(65536),
            nreturned: Vec::with_capacity(65536),
            num_yields: Vec::with_capacity(65536),
            reslens: Vec::with_capacity(65536),
            is_collscan: Vec::with_capacity(65536),
            remote_ids: Vec::with_capacity(65536),
            user_ids: Vec::with_capacity(65536),
            ctx_ids: Vec::with_capacity(65536),

            ns_strings: Vec::new(),
            ns_table: HashMap::new(),

            plan_strings: Vec::new(),
            plan_table: HashMap::new(),

            fingerprint_strings: Vec::new(),
            fingerprint_table: HashMap::new(),
            index_suggestions: Vec::new(),

            remote_strings: Vec::new(),
            remote_table: HashMap::new(),

            user_strings: vec!["system".to_string()],
            user_table: {
                let mut m = HashMap::new();
                m.insert("system".to_string(), 0);
                m
            },
            user_meta: vec![UserMeta::default()],
            ctx_to_user: Vec::new(),
            ctx_strings: Vec::new(),
            ctx_table: HashMap::new(),
            ops_mask: 0,

            query_hash_cache: HashMap::new(),

            last_ns_id: u16::MAX,
            last_plan_id: u16::MAX,
            last_remote_id: u16::MAX,
            last_ctx_id: u16::MAX,
            last_user_id: u16::MAX,
            last_qhash: (u16::MAX, 0, (MongoOp::Find, 0)),
            last_date: [0u8; 10],

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
        self.remote_ids.clear();
        self.user_ids.clear();
        self.ctx_ids.clear();

        self.ns_strings.clear();
        self.ns_table.clear();
        self.plan_strings.clear();
        self.plan_table.clear();
        self.fingerprint_strings.clear();
        self.fingerprint_table.clear();
        self.index_suggestions.clear();
        self.remote_strings.clear();
        self.remote_table.clear();

        self.user_strings.clear();
        self.user_table.clear();
        self.user_strings.push("system".to_string());
        self.user_table.insert("system".to_string(), 0);
        self.user_meta.clear();
        self.user_meta.push(UserMeta::default());
        self.ctx_to_user.clear();
        self.ctx_strings.clear();
        self.ctx_table.clear();
        self.ops_mask = 0;

        self.query_hash_cache.clear();

        self.last_ns_id = u16::MAX;
        self.last_plan_id = u16::MAX;
        self.last_remote_id = u16::MAX;
        self.last_ctx_id = u16::MAX;
        self.last_user_id = u16::MAX;
        self.last_qhash = (u16::MAX, 0, (MongoOp::Find, 0));
        self.last_date = [0u8; 10];

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
        if self.last_ns_id != u16::MAX && self.ns_strings[self.last_ns_id as usize] == ns {
            return self.last_ns_id;
        }
        let id = if let Some(&id) = self.ns_table.get(ns) {
            id
        } else {
            let id = self.ns_strings.len() as u16;
            self.ns_strings.push(ns.to_string());
            self.ns_table.insert(ns.to_string(), id);
            id
        };
        self.last_ns_id = id;
        id
    }

    #[inline]
    fn intern_plan(&mut self, plan: &str) -> u16 {
        if self.last_plan_id != u16::MAX && self.plan_strings[self.last_plan_id as usize] == plan {
            return self.last_plan_id;
        }
        let id = if let Some(&id) = self.plan_table.get(plan) {
            id
        } else {
            let id = self.plan_strings.len() as u16;
            self.plan_strings.push(plan.to_string());
            self.plan_table.insert(plan.to_string(), id);
            id
        };
        self.last_plan_id = id;
        id
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

    #[inline]
    fn intern_remote(&mut self, remote: &str) -> u16 {
        if self.last_remote_id != u16::MAX && self.remote_strings[self.last_remote_id as usize] == remote {
            return self.last_remote_id;
        }
        let id = if let Some(&id) = self.remote_table.get(remote) {
            id
        } else {
            let id = self.remote_strings.len() as u16;
            self.remote_strings.push(remote.to_string());
            self.remote_table.insert(remote.to_string(), id);
            id
        };
        self.last_remote_id = id;
        id
    }

    #[inline]
    pub fn intern_user(&mut self, user: &str) -> u16 {
        let name = if user.is_empty() { "system" } else { user };
        if self.last_user_id != u16::MAX && self.user_strings[self.last_user_id as usize] == name {
            return self.last_user_id;
        }
        let id = if let Some(&id) = self.user_table.get(name) {
            id
        } else {
            let id = self.user_strings.len() as u16;
            self.user_strings.push(name.to_string());
            self.user_table.insert(name.to_string(), id);
            self.user_meta.push(UserMeta::default());
            id
        };
        self.last_user_id = id;
        id
    }

    #[inline]
    pub fn intern_ctx(&mut self, ctx: &str) -> u16 {
        if ctx.is_empty() {
            return u16::MAX;
        }
        if self.last_ctx_id != u16::MAX && self.ctx_strings[self.last_ctx_id as usize] == ctx {
            return self.last_ctx_id;
        }
        let id = if let Some(&id) = self.ctx_table.get(ctx) {
            id
        } else {
            let id = self.ctx_strings.len() as u16;
            self.ctx_strings.push(ctx.to_string());
            self.ctx_table.insert(ctx.to_string(), id);
            self.ctx_to_user.push(0);
            id
        };
        self.last_ctx_id = id;
        id
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
                let remote_id = self.intern_remote(q.remote);
                let ctx_id = self.intern_ctx(q.ctx);

                let u_id = if !q.user.is_empty() {
                    self.intern_user(q.user)
                } else if ctx_id != u16::MAX && (ctx_id as usize) < self.ctx_to_user.len() {
                    self.ctx_to_user[ctx_id as usize]
                } else {
                    0
                };

                if u_id > 0 && (u_id as usize) < self.user_meta.len() {
                    let meta = &mut self.user_meta[u_id as usize];
                    if meta.first_seen_ms == 0 || q.epoch_ms < meta.first_seen_ms {
                        meta.first_seen_ms = q.epoch_ms;
                    }
                    if q.epoch_ms > meta.last_seen_ms {
                        meta.last_seen_ms = q.epoch_ms;
                    }
                    if !q.remote.is_empty() {
                        let ip = if let Some(colon) = q.remote.find(':') {
                            &q.remote[..colon]
                        } else {
                            q.remote
                        };
                        if !meta.client_ips.iter().any(|c| c == ip) {
                            meta.client_ips.push(ip.to_string());
                        }
                    }
                }

                let (op, fp_id) = if !q.query_hash.is_empty() {
                    let qhash_u64 = rapidhash::v3::rapidhash_v3(q.query_hash.as_bytes());
                    if self.last_qhash.0 == ns_id && self.last_qhash.1 == qhash_u64 {
                        self.last_qhash.2
                    } else {
                        let cache_key = (ns_id, qhash_u64);
                        if let Some(&(cached_op, cached_fp_id)) = self.query_hash_cache.get(&cache_key) {
                            self.last_qhash = (ns_id, qhash_u64, (cached_op, cached_fp_id));
                            (cached_op, cached_fp_id)
                        } else {
                            let cmd = extract_command_slice(q.line).unwrap_or(b"{}");
                            let op = detect_op(cmd);
                            let fp_res = generate_fingerprint(op, q.collection, cmd, q.is_collscan);
                            let fp_id = self.intern_fingerprint(&fp_res.fingerprint, &fp_res.index_suggestion);
                            self.query_hash_cache.insert(cache_key, (op, fp_id));
                            self.last_qhash = (ns_id, qhash_u64, (op, fp_id));
                            (op, fp_id)
                        }
                    }
                } else {
                    let cmd = extract_command_slice(q.line).unwrap_or(b"{}");
                    let op = detect_op(cmd);
                    let fp_res = generate_fingerprint(op, q.collection, cmd, q.is_collscan);
                    let fp_id = self.intern_fingerprint(&fp_res.fingerprint, &fp_res.index_suggestion);
                    (op, fp_id)
                };

                let op_u8 = op as u8;
                self.timestamps_ms.push(q.epoch_ms);
                self.durations_ms.push(q.duration_ms);
                self.ns_ids.push(ns_id);
                self.op_ids.push(op_u8);
                self.ops_mask |= 1 << op_u8;
                self.plan_ids.push(plan_id);
                self.fingerprint_ids.push(fp_id);
                self.docs_examined.push(q.docs_examined);
                self.keys_examined.push(q.keys_examined);
                self.nreturned.push(q.nreturned);
                self.num_yields.push(q.num_yields);
                self.reslens.push(q.reslen);
                self.is_collscan.push(q.is_collscan);
                self.remote_ids.push(remote_id);
                self.user_ids.push(u_id);
                self.ctx_ids.push(ctx_id);

                if q.timestamp.len() >= 10 {
                    let d_bytes = q.timestamp[..10].as_bytes();
                    if d_bytes != self.last_date {
                        self.last_date.copy_from_slice(d_bytes);
                        let d_str = &q.timestamp[..10];
                        if !self.dates.iter().any(|s| s == d_str) {
                            self.dates.push(d_str.to_string());
                        }
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
            ParsedLine::AuthSuccess {
                timestamp,
                ctx,
                user,
                db,
                client,
                app_name,
            } => {
                self.auth_success += 1;
                let u_id = self.intern_user(user);
                if !ctx.is_empty() {
                    let ctx_id = self.intern_ctx(ctx);
                    if (ctx_id as usize) < self.ctx_to_user.len() {
                        self.ctx_to_user[ctx_id as usize] = u_id;
                    }
                }
                if (u_id as usize) < self.user_meta.len() {
                    let meta = &mut self.user_meta[u_id as usize];
                    meta.auth_success_count += 1;
                    if !db.is_empty() && meta.auth_db.is_empty() {
                        meta.auth_db = db.to_string();
                    }
                    if !app_name.is_empty() && meta.app_name.is_empty() {
                        meta.app_name = app_name.to_string();
                    }
                    if !client.is_empty() {
                        let ip = if let Some(colon) = client.find(':') {
                            &client[..colon]
                        } else {
                            client
                        };
                        if !meta.client_ips.iter().any(|c| c == ip) {
                            meta.client_ips.push(ip.to_string());
                        }
                    }
                    let epoch = crate::parse::parse_iso_epoch(timestamp);
                    if meta.first_seen_ms == 0 || (epoch > 0 && epoch < meta.first_seen_ms) {
                        meta.first_seen_ms = epoch;
                    }
                    if epoch > meta.last_seen_ms {
                        meta.last_seen_ms = epoch;
                    }
                }
            }
            ParsedLine::AuthFail { ctx, user, .. } => {
                self.auth_fail += 1;
                let u_id = if !user.is_empty() {
                    self.intern_user(user)
                } else if !ctx.is_empty() {
                    let ctx_id = self.intern_ctx(ctx);
                    if (ctx_id as usize) < self.ctx_to_user.len() {
                        self.ctx_to_user[ctx_id as usize]
                    } else {
                        0
                    }
                } else {
                    0
                };
                if u_id > 0 && (u_id as usize) < self.user_meta.len() {
                    self.user_meta[u_id as usize].auth_fail_count += 1;
                }
            }
            ParsedLine::ClientMetadata {
                ctx,
                app_name,
                driver_name,
                driver_version,
                platform,
                os_name,
                os_version,
            } => {
                if !ctx.is_empty() && !app_name.is_empty() {
                    let ctx_id = self.intern_ctx(ctx);
                    let u_id = if (ctx_id as usize) < self.ctx_to_user.len() {
                        self.ctx_to_user[ctx_id as usize]
                    } else {
                        0
                    };
                    if u_id > 0 && (u_id as usize) < self.user_meta.len() {
                        let meta = &mut self.user_meta[u_id as usize];
                        if meta.app_name.is_empty() {
                            meta.app_name = app_name.to_string();
                        }
                    }
                }
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

#[inline(always)]
pub(crate) fn trim_line(bytes: &[u8]) -> &[u8] {
    let mut end = bytes.len();
    if end > 0 && bytes[end - 1] == b'\r' {
        end -= 1;
    }
    let mut start = 0;
    while start < end && (bytes[start] == b' ' || bytes[start] == b'\t') {
        start += 1;
    }
    while end > start && (bytes[end - 1] == b' ' || bytes[end - 1] == b'\t') {
        end -= 1;
    }
    &bytes[start..end]
}
