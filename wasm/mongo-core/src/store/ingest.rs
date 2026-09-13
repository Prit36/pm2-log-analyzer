//! Shard ingest: byte windows, carry handling, and line acceptance.

use super::{
    push_unique, trim_line, CheckpointRecord, DriverInfo, Engine, ErrorRecord,
    INGEST_CAP,
};

use memchr::memchr;

use crate::fingerprint::{detect_op, generate_fingerprint, MongoOp};
use crate::parse::{
    extract_command_slice, parse_iso_epoch, parse_line, AuthSuccess, ClientMetadata, ParsedLine,
    ParsedSlowQuery,
};

impl Engine {
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
        let cursor = self.consume_lines(view, 0);
        if cursor < view.len() {
            self.carry.extend_from_slice(&view[cursor..]);
        }
        self.ingest = ingest;
        (self.durations_ms.len() - before) as u32
    }

    fn feed_with_carry(&mut self, len: usize, _abs_off: u64) -> u32 {
        let before = self.durations_ms.len();
        let ingest = std::mem::take(&mut self.ingest);
        let view = &ingest[..len];
        self.consume_lines_with_carry(view);
        self.ingest = ingest;
        (self.durations_ms.len() - before) as u32
    }

    pub fn feed_slice(&mut self, slice: &[u8]) -> u32 {
        let before = self.durations_ms.len();
        if self.carry.is_empty() {
            let cursor = self.consume_lines(slice, 0);
            if cursor < slice.len() {
                self.carry.extend_from_slice(&slice[cursor..]);
            }
        } else {
            self.consume_lines_with_carry(slice);
        }
        (self.durations_ms.len() - before) as u32
    }

    /// Parse complete lines from `from` on; returns the index of the trailing
    /// partial line, or `view.len()` when the view ends on a newline.
    fn consume_lines(&mut self, view: &[u8], from: usize) -> usize {
        let mut cursor = from;
        while let Some(pos) = memchr(b'\n', &view[cursor..]) {
            let line_end = cursor + pos;
            self.accept_line(&view[cursor..line_end]);
            cursor = line_end + 1;
        }
        cursor
    }

    /// Finish the carry's partial line, then parse the rest of the view.
    fn consume_lines_with_carry(&mut self, view: &[u8]) {
        let Some(pos) = memchr(b'\n', view) else {
            self.carry.extend_from_slice(view);
            return;
        };
        self.carry.extend_from_slice(&view[..pos]);
        let carry = std::mem::take(&mut self.carry);
        self.accept_line(&carry);
        let cursor = self.consume_lines(view, pos + 1);
        if cursor < view.len() {
            self.carry.extend_from_slice(&view[cursor..]);
        }
    }

    pub fn end_shard(&mut self) {
        if !self.carry.is_empty() {
            let carry = std::mem::take(&mut self.carry);
            self.accept_line(&carry);
        }
    }

    /// High-performance multi-core shard ingestion: parses slice [shard_start..shard_end]
    /// with lookahead into [shard_end..shard_end + MONGO_LINE_EXTEND].
    /// Guarantees that each log line is parsed by exactly one shard without duplicate
    /// or missed lines.
    pub fn parse_shard(
        &mut self,
        slice: &[u8],
        shard_start: usize,
        shard_end: usize,
        file_size: usize,
    ) -> usize {
        let before = self.durations_ms.len();
        let mut cursor = 0usize;

        // If not the first shard, skip the partial line at the start (parsed by previous shard)
        if shard_start > 0 {
            let Some(position) = memchr(b'\n', slice) else {
                return 0;
            };
            cursor = position + 1;
        }

        while cursor < slice.len() {
            let abs_line_start = shard_start + cursor;
            if abs_line_start >= shard_end {
                // Line starts at or beyond this shard's boundary; next shard owns it
                break;
            }
            let line_end = match memchr(b'\n', &slice[cursor..]) {
                Some(position) => cursor + position,
                None => {
                    if shard_start + slice.len() >= file_size {
                        slice.len()
                    } else {
                        break;
                    }
                }
            };
            self.accept_line(&slice[cursor..line_end]);
            cursor = line_end + 1;
        }

        self.durations_ms.len() - before
    }

    /// Parse shard slice directly from the Wasm ingest window without copying.
    pub fn parse_shard_ingest(
        &mut self,
        len: u32,
        shard_start: usize,
        shard_end: usize,
        file_size: usize,
    ) -> usize {
        let n = (len as usize).min(self.ingest.len());
        let ingest = std::mem::take(&mut self.ingest);
        let count = self.parse_shard(&ingest[..n], shard_start, shard_end, file_size);
        self.ingest = ingest;
        count
    }

    pub fn accept_line(&mut self, line: &[u8]) {
        self.total_lines += 1;
        let line = trim_line(line);
        if line.is_empty() {
            return;
        }
        match parse_line(line) {
            ParsedLine::SlowQuery(query) => self.accept_slow_query(query),
            ParsedLine::ConnectionAccepted { connection_count } => {
                self.conn_accepted += 1;
                if connection_count > self.conn_peak {
                    self.conn_peak = connection_count;
                }
            }
            ParsedLine::ConnectionEnded => self.conn_ended += 1,
            ParsedLine::AuthSuccess(success) => self.accept_auth_success(success),
            ParsedLine::AuthFail { ctx, user } => self.accept_auth_fail(ctx, user),
            ParsedLine::ClientMetadata(metadata) => self.accept_client_metadata(metadata),
            ParsedLine::Checkpoint { timestamp, msg } => self.accept_checkpoint(timestamp, msg),
            ParsedLine::Error {
                timestamp,
                severity,
                id,
                msg,
            } => self.accept_error(timestamp.to_string(), severity, id, msg),
            ParsedLine::Ignored => {}
        }
    }

    /// A slow query: intern its dimensions, resolve its fingerprint, and push its columns.
    fn accept_slow_query(&mut self, query: ParsedSlowQuery) {
        let ids = self.intern_slow_query_ids(&query);
        self.touch_user(&query, ids.user_id);
        let fingerprint_id = self.resolve_op_fingerprint(&query, ids.ns_id);
        self.push_slow_query_columns(&query, &ids, fingerprint_id);
    }

    /// Intern the namespace, plan, remote, context, and user of one slow query.
    fn intern_slow_query_ids(&mut self, query: &ParsedSlowQuery) -> SlowQueryIds {
        let ctx_id = self.intern_ctx(query.ctx);
        let user_id = if !query.user.is_empty() {
            self.intern_user(query.user)
        } else if ctx_id != u16::MAX && (ctx_id as usize) < self.ctx_to_user.len() {
            self.ctx_to_user[ctx_id as usize]
        } else {
            0
        };
        SlowQueryIds {
            ns_id: self.intern_ns(query.ns),
            plan_id: self.intern_plan(query.plan_summary),
            remote_id: self.intern_remote(query.remote),
            ctx_id,
            user_id,
        }
    }

    /// Record the query's first/last sighting and client address on its user.
    fn touch_user(&mut self, query: &ParsedSlowQuery, user_id: u16) {
        if user_id == 0 || (user_id as usize) >= self.user_meta.len() {
            return;
        }
        let meta = &mut self.user_meta[user_id as usize];
        if meta.first_seen_ms == 0 || query.epoch_ms < meta.first_seen_ms {
            meta.first_seen_ms = query.epoch_ms;
        }
        if query.epoch_ms > meta.last_seen_ms {
            meta.last_seen_ms = query.epoch_ms;
        }
        if !query.remote.is_empty() {
            push_unique(&mut meta.client_ips, host_part(query.remote));
        }
    }

    /// The query-hash cache lookup, falling back to a fresh fingerprint.
    fn resolve_op_fingerprint(&mut self, query: &ParsedSlowQuery, ns_id: u16) -> (MongoOp, u16) {
        if query.query_hash.is_empty() {
            return self.fingerprint_query(query);
        }
        let hash = rapidhash::v3::rapidhash_v3(query.query_hash.as_bytes());
        let cached = self
            .last_qhash
            .filter(|&(last_ns, last_hash, _)| last_ns == ns_id && last_hash == hash)
            .map(|(_, _, found)| found);
        if let Some(found) = cached {
            return found;
        }
        let cache_key = (ns_id, hash);
        if let Some(&cached) = self.query_hash_cache.get(&cache_key) {
            self.last_qhash = Some((ns_id, hash, cached));
            return cached;
        }
        let computed = self.fingerprint_query(query);
        self.query_hash_cache.insert(cache_key, computed);
        self.last_qhash = Some((ns_id, hash, computed));
        computed
    }

    /// Detect the operation and intern the fingerprint of one slow query.
    fn fingerprint_query(&mut self, query: &ParsedSlowQuery) -> (MongoOp, u16) {
        let command = extract_command_slice(query.line).unwrap_or(b"{}");
        let op = detect_op(command);
        let fingerprint = generate_fingerprint(op, query.collection, command, query.is_collscan);
        let id = self.intern_fingerprint(&fingerprint.fingerprint, &fingerprint.index_suggestion);
        (op, id)
    }

    /// Append one slow query's values to every column.
    fn push_slow_query_columns(
        &mut self,
        query: &ParsedSlowQuery,
        ids: &SlowQueryIds,
        (op, fingerprint_id): (MongoOp, u16),
    ) {
        let op_code = op as u8;
        self.timestamps_ms.push(query.epoch_ms);
        self.durations_ms.push(query.duration_ms);
        self.ns_ids.push(ids.ns_id);
        self.op_ids.push(op_code);
        self.ops_mask |= 1 << op_code;
        self.plan_ids.push(ids.plan_id);
        self.fingerprint_ids.push(fingerprint_id);
        self.docs_examined.push(query.docs_examined);
        self.keys_examined.push(query.keys_examined);
        self.nreturned.push(query.nreturned);
        self.num_yields.push(query.num_yields);
        self.reslens.push(query.reslen);
        self.is_collscan.push(query.is_collscan);
        self.remote_ids.push(ids.remote_id);
        self.user_ids.push(ids.user_id);
        self.ctx_ids.push(ids.ctx_id);
        self.record_query_date(query.timestamp);
    }

    /// Record a new calendar date the first time it is seen.
    fn record_query_date(&mut self, timestamp: &str) {
        if timestamp.len() < 10 {
            return;
        }
        let date_bytes = timestamp[..10].as_bytes();
        if date_bytes == self.last_date {
            return;
        }
        self.last_date.copy_from_slice(date_bytes);
        push_unique(&mut self.dates, &timestamp[..10]);
    }

    /// A successful authentication: bind the context to the user and count it.
    fn accept_auth_success(&mut self, success: AuthSuccess) {
        self.auth_success += 1;
        let user_id = self.intern_user(success.user);
        self.bind_ctx_user(success.ctx, user_id);
        if (user_id as usize) >= self.user_meta.len() {
            return;
        }
        let meta = &mut self.user_meta[user_id as usize];
        meta.auth_success_count += 1;
        if !success.db.is_empty() && meta.auth_db.is_empty() {
            meta.auth_db = success.db.to_string();
        }
        if !success.app_name.is_empty() && meta.app_name.is_empty() {
            meta.app_name = success.app_name.to_string();
        }
        if !success.client.is_empty() {
            push_unique(&mut meta.client_ips, host_part(success.client));
        }
        let epoch = parse_iso_epoch(success.timestamp);
        if meta.first_seen_ms == 0 || (epoch > 0 && epoch < meta.first_seen_ms) {
            meta.first_seen_ms = epoch;
        }
        if epoch > meta.last_seen_ms {
            meta.last_seen_ms = epoch;
        }
    }

    /// A failed authentication: count it against the user, else against the context.
    fn accept_auth_fail(&mut self, ctx: &str, user: &str) {
        self.auth_fail += 1;
        let ctx_id = if ctx.is_empty() {
            u16::MAX
        } else {
            self.intern_ctx(ctx)
        };
        let user_id = if !user.is_empty() {
            self.intern_user(user)
        } else if ctx_id != u16::MAX && (ctx_id as usize) < self.ctx_to_user.len() {
            self.ctx_to_user[ctx_id as usize]
        } else {
            0
        };
        if user_id > 0 && (user_id as usize) < self.user_meta.len() {
            self.user_meta[user_id as usize].auth_fail_count += 1;
            return;
        }
        if ctx_id != u16::MAX {
            let index = ctx_id as usize;
            if index >= self.ctx_auth_fails.len() {
                self.ctx_auth_fails.resize(index + 1, 0);
            }
            self.ctx_auth_fails[index] += 1;
        }
    }

    /// `client metadata`: record the app name per context and the driver versions.
    fn accept_client_metadata(&mut self, metadata: ClientMetadata) {
        if !metadata.ctx.is_empty() && !metadata.app_name.is_empty() {
            self.record_ctx_app_name(metadata.ctx, metadata.app_name);
        }
        if let Some(existing) = self.drivers.iter_mut().find(|driver| {
            driver.name == metadata.driver_name && driver.version == metadata.driver_version
        }) {
            existing.count += 1;
            return;
        }
        self.drivers.push(DriverInfo {
            name: metadata.driver_name.to_string(),
            version: metadata.driver_version.to_string(),
            platform: metadata.platform.to_string(),
            os_name: metadata.os_name.to_string(),
            os_version: metadata.os_version.to_string(),
            count: 1,
        });
    }

    /// Remember a context's application name and copy it onto its user.
    fn record_ctx_app_name(&mut self, ctx: &str, app_name: &str) {
        let ctx_id = self.intern_ctx(ctx);
        let index = ctx_id as usize;
        if index >= self.ctx_app_names.len() {
            self.ctx_app_names.resize(index + 1, String::new());
        }
        if self.ctx_app_names[index].is_empty() {
            self.ctx_app_names[index] = app_name.to_string();
        }
        let user_id = if index < self.ctx_to_user.len() {
            self.ctx_to_user[index]
        } else {
            0
        };
        if user_id > 0 && (user_id as usize) < self.user_meta.len() {
            let meta = &mut self.user_meta[user_id as usize];
            if meta.app_name.is_empty() {
                meta.app_name = app_name.to_string();
            }
        }
    }

    /// Bind a context to its user, when both are known.
    fn bind_ctx_user(&mut self, ctx: &str, user_id: u16) {
        if ctx.is_empty() {
            return;
        }
        let ctx_id = self.intern_ctx(ctx) as usize;
        if ctx_id < self.ctx_to_user.len() {
            self.ctx_to_user[ctx_id] = user_id;
        }
    }

    /// Keep the most recent checkpoints, capped.
    fn accept_checkpoint(&mut self, timestamp: &str, msg: &str) {
        if self.checkpoints.len() < 100 {
            self.checkpoints.push(CheckpointRecord {
                timestamp: timestamp.to_string(),
                msg: msg.to_string(),
            });
        }
    }

    /// Keep the first 200 distinct errors, counting repeats.
    fn accept_error(&mut self, timestamp: String, severity: u8, id: u32, msg: &str) {
        if let Some(existing) = self
            .errors
            .iter_mut()
            .find(|error| error.id == id && error.msg == msg)
        {
            existing.count += 1;
            return;
        }
        if self.errors.len() >= 200 {
            return;
        }
        self.errors.push(ErrorRecord {
            timestamp,
            severity,
            id,
            msg: msg.to_string(),
            count: 1,
        });
    }

}

/// The interned dimension ids of one slow query.
#[derive(Clone, Copy)]
struct SlowQueryIds {
    ns_id: u16,
    plan_id: u16,
    remote_id: u16,
    ctx_id: u16,
    user_id: u16,
}

/// The host part of a `host:port` client or remote address.
fn host_part(address: &str) -> &str {
    match address.find(':') {
        Some(colon) => &address[..colon],
        None => address,
    }
}
