//! Compact columnar storage and memory arena for MongoDB log data.

use crate::fingerprint::MongoOp;
use hashbrown::HashMap;

mod ingest;
mod intern;
mod merge;
mod wire;

const INGEST_CAP: usize = 128 * 1024 * 1024; // 128MB streaming ingest window
pub const MONGO_LINE_EXTEND: usize = 256 * 1024; // 256KB lookahead to complete trailing line crossing shard boundary

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

/// Columnar store for one MongoDB log shard.
///
/// `Default` is the zero state, with no arena seeded; use [`Engine::new`] for a
/// ready-to-ingest engine.
#[derive(Default)]
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
    pub ctx_auth_fails: Vec<u32>,
    pub ctx_app_names: Vec<String>,
    pub ops_mask: u16,

    pub query_hash_cache: HashMap<(u16, u64), (MongoOp, u16)>,

    pub(crate) last_ns_id: u16,
    pub(crate) last_plan_id: u16,
    pub(crate) last_remote_id: u16,
    pub(crate) last_ctx_id: u16,
    pub(crate) last_user_id: u16,
    pub(crate) last_qhash: Option<(u16, u64, (MongoOp, u16))>,
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

impl Engine {
    /// A fresh engine with the ingest window and columns pre-sized.
    pub fn new() -> Self {
        let mut engine = Self::default();
        engine.reserve_arenas();
        engine.seed_system_user();
        engine
    }

    /// Pre-size the ingest window and the columnar store to the ingest scale.
    fn reserve_arenas(&mut self) {
        self.ingest.reserve(32 * 1024 * 1024);
        self.timestamps_ms.reserve(65_536);
        self.durations_ms.reserve(65_536);
        self.ns_ids.reserve(65_536);
        self.op_ids.reserve(65_536);
        self.plan_ids.reserve(65_536);
        self.fingerprint_ids.reserve(65_536);
        self.docs_examined.reserve(65_536);
        self.keys_examined.reserve(65_536);
        self.nreturned.reserve(65_536);
        self.num_yields.reserve(65_536);
        self.reslens.reserve(65_536);
        self.is_collscan.reserve(65_536);
        self.remote_ids.reserve(65_536);
        self.user_ids.reserve(65_536);
        self.ctx_ids.reserve(65_536);
    }

    /// User id 0 is the synthetic `system` user every unauthenticated row falls back to.
    fn seed_system_user(&mut self) {
        self.user_strings.push("system".to_string());
        self.user_table.insert("system".to_string(), 0);
        self.user_meta.push(UserMeta::default());
    }

    /// Drop every parse result, keeping the engine ready for the next shard.
    pub fn clear(&mut self) {
        *self = Self::default();
        self.seed_system_user();
        self.reserve_arenas();
    }

    pub fn slow_query_count(&self) -> u32 {
        self.durations_ms.len() as u32
    }
}

/// Push `value` when the list does not already hold it.
fn push_unique(list: &mut Vec<String>, value: &str) {
    if !list.iter().any(|existing| existing == value) {
        list.push(value.to_string());
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


