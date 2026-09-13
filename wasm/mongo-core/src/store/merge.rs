//! Merging decoded shards into the coordinator engine.

use super::{push_unique, CheckpointRecord, DriverInfo, Engine, ErrorRecord, UserMeta};

impl Engine {
    /// Decodes a serialized shard wire and merges it directly into `self`.
    pub fn merge_shard_bytes(&mut self, data: &[u8]) -> Result<(), &'static str> {
        let other = Self::decode_shard(data)?;
        self.merge(other);
        Ok(())
    }

    /// Fast zero-copy columnar merge of another Engine into `self`.
    /// Remaps local string IDs to global IDs and merges diagnostics, metadata,
    /// and user activity in <1ms.
    pub fn merge(&mut self, other: Engine) {
        if other.total_lines == 0 {
            return;
        }
        if self.total_lines == 0 {
            *self = other;
            return;
        }
        self.merge_counters(&other);
        let remap = self.merge_arenas(&other);
        self.merge_columns(&other, &remap);
        self.merge_context_tables(&other, &remap);
        self.merge_drivers(&other.drivers);
        self.merge_errors(&other.errors);
        self.merge_checkpoints(&other.checkpoints);
        self.merge_dates(&other.dates);
        self.backfill_ctx_users();
    }

    /// Scalar counters and the operation mask.
    fn merge_counters(&mut self, other: &Engine) {
        self.total_lines += other.total_lines;
        self.conn_accepted += other.conn_accepted;
        self.conn_ended += other.conn_ended;
        if other.conn_peak > self.conn_peak {
            self.conn_peak = other.conn_peak;
        }
        self.auth_success += other.auth_success;
        self.auth_fail += other.auth_fail;
        self.ops_mask |= other.ops_mask;
    }

    /// Intern every string of `other` into `self`, recording the id remaps.
    fn merge_arenas(&mut self, other: &Engine) -> IdRemap {
        let mut remap = IdRemap {
            namespaces: Vec::with_capacity(other.ns_strings.len()),
            plans: Vec::with_capacity(other.plan_strings.len()),
            fingerprints: Vec::with_capacity(other.fingerprint_strings.len()),
            remotes: Vec::with_capacity(other.remote_strings.len()),
            users: Vec::with_capacity(other.user_strings.len()),
            contexts: Vec::with_capacity(other.ctx_strings.len()),
        };
        for namespace in &other.ns_strings {
            remap.namespaces.push(self.intern_ns(namespace));
        }
        for plan in &other.plan_strings {
            remap.plans.push(self.intern_plan(plan));
        }
        for (index, fingerprint) in other.fingerprint_strings.iter().enumerate() {
            let suggestion = other
                .index_suggestions
                .get(index)
                .map(String::as_str)
                .unwrap_or("");
            remap
                .fingerprints
                .push(self.intern_fingerprint(fingerprint, suggestion));
        }
        for remote in &other.remote_strings {
            remap.remotes.push(self.intern_remote(remote));
        }
        for (index, name) in other.user_strings.iter().enumerate() {
            let global_id = self.intern_user(name);
            remap.users.push(global_id);
            if index < other.user_meta.len() {
                self.merge_user_meta(global_id, &other.user_meta[index]);
            }
        }
        for (index, ctx) in other.ctx_strings.iter().enumerate() {
            let global_id = self.intern_ctx(ctx);
            remap.contexts.push(global_id);
            if index < other.ctx_to_user.len() {
                self.link_context_user(global_id, other.ctx_to_user[index], &remap.users);
            }
        }
        remap
    }

    /// Fold one user's seen window, counters, and client addresses into `self`.
    fn merge_user_meta(&mut self, global_id: u16, other: &UserMeta) {
        let meta = &mut self.user_meta[global_id as usize];
        meta.auth_success_count += other.auth_success_count;
        meta.auth_fail_count += other.auth_fail_count;
        if meta.auth_db.is_empty() && !other.auth_db.is_empty() {
            meta.auth_db = other.auth_db.clone();
        }
        if meta.app_name.is_empty() && !other.app_name.is_empty() {
            meta.app_name = other.app_name.clone();
        }
        for ip in &other.client_ips {
            push_unique(&mut meta.client_ips, ip);
        }
        if meta.first_seen_ms == 0
            || (other.first_seen_ms > 0 && other.first_seen_ms < meta.first_seen_ms)
        {
            meta.first_seen_ms = other.first_seen_ms;
        }
        if other.last_seen_ms > meta.last_seen_ms {
            meta.last_seen_ms = other.last_seen_ms;
        }
    }

    /// Point one remapped context at its (remapped) user.
    fn link_context_user(&mut self, global_context: u16, local_user: u16, users: &[u16]) {
        if local_user == 0 {
            return;
        }
        let global_user = users.get(local_user as usize).copied().unwrap_or(0);
        if global_user != 0 && (global_context as usize) < self.ctx_to_user.len() {
            self.ctx_to_user[global_context as usize] = global_user;
        }
    }

    /// Append `other`'s rows, remapping their interned ids.
    fn merge_columns(&mut self, other: &Engine, remap: &IdRemap) {
        self.timestamps_ms.extend_from_slice(&other.timestamps_ms);
        self.durations_ms.extend_from_slice(&other.durations_ms);
        self.op_ids.extend_from_slice(&other.op_ids);
        self.docs_examined.extend_from_slice(&other.docs_examined);
        self.keys_examined.extend_from_slice(&other.keys_examined);
        self.nreturned.extend_from_slice(&other.nreturned);
        self.num_yields.extend_from_slice(&other.num_yields);
        self.reslens.extend_from_slice(&other.reslens);
        self.is_collscan.extend_from_slice(&other.is_collscan);

        append_remapped(&mut self.ns_ids, &other.ns_ids, &remap.namespaces);
        append_remapped(&mut self.plan_ids, &other.plan_ids, &remap.plans);
        append_remapped(
            &mut self.fingerprint_ids,
            &other.fingerprint_ids,
            &remap.fingerprints,
        );
        append_remapped(&mut self.remote_ids, &other.remote_ids, &remap.remotes);
        append_remapped(&mut self.ctx_ids, &other.ctx_ids, &remap.contexts);
        append_remapped(&mut self.user_ids, &other.user_ids, &remap.users);
    }

    /// Fold `other`'s per-context auth failures and application names in.
    fn merge_context_tables(&mut self, other: &Engine, remap: &IdRemap) {
        for (local_id, &fail_count) in other.ctx_auth_fails.iter().enumerate() {
            if fail_count == 0 {
                continue;
            }
            let Some(global_id) = remap.global_context(local_id) else {
                continue;
            };
            let index = global_id as usize;
            if index >= self.ctx_auth_fails.len() {
                self.ctx_auth_fails.resize(index + 1, 0);
            }
            self.ctx_auth_fails[index] += fail_count;
        }
        for (local_id, app_name) in other.ctx_app_names.iter().enumerate() {
            if app_name.is_empty() {
                continue;
            }
            let Some(global_id) = remap.global_context(local_id) else {
                continue;
            };
            let index = global_id as usize;
            if index >= self.ctx_app_names.len() {
                self.ctx_app_names.resize(index + 1, String::new());
            }
            if self.ctx_app_names[index].is_empty() {
                self.ctx_app_names[index] = app_name.clone();
            }
        }
    }

    /// Fold `other`'s driver versions in, counting repeats.
    fn merge_drivers(&mut self, drivers: &[DriverInfo]) {
        for driver in drivers {
            let existing = self
                .drivers
                .iter_mut()
                .find(|known| known.name == driver.name && known.version == driver.version);
            match existing {
                Some(known) => known.count += driver.count,
                None => self.drivers.push(driver.clone()),
            }
        }
    }

    /// Fold `other`'s errors in, counting repeats and capping the list.
    fn merge_errors(&mut self, errors: &[ErrorRecord]) {
        for error in errors {
            let existing = self
                .errors
                .iter_mut()
                .find(|known| known.id == error.id && known.msg == error.msg);
            if let Some(known) = existing {
                known.count += error.count;
            } else if self.errors.len() < 200 {
                self.errors.push(error.clone());
            }
        }
    }

    fn merge_checkpoints(&mut self, checkpoints: &[CheckpointRecord]) {
        for checkpoint in checkpoints {
            if self.checkpoints.len() < 100 {
                self.checkpoints.push(checkpoint.clone());
            }
        }
    }

    fn merge_dates(&mut self, dates: &[String]) {
        for date in dates {
            push_unique(&mut self.dates, date);
        }
    }
}

/// Local-to-global string-id maps for one merged shard.
struct IdRemap {
    namespaces: Vec<u16>,
    plans: Vec<u16>,
    fingerprints: Vec<u16>,
    remotes: Vec<u16>,
    users: Vec<u16>,
    contexts: Vec<u16>,
}

impl IdRemap {
    /// The global context id for a local one; `None` for the "no context" sentinel.
    fn global_context(&self, local_id: usize) -> Option<u16> {
        self.contexts.get(local_id).copied().filter(|&id| id != u16::MAX)
    }
}

/// Append `source` ids through `map`; ids the map lacks become `u16::MAX`.
fn append_remapped(target: &mut Vec<u16>, source: &[u16], map: &[u16]) {
    target.reserve(source.len());
    for &id in source {
        target.push(map.get(id as usize).copied().unwrap_or(u16::MAX));
    }
}
