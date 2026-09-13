//! String, context, and user interning plus the post-merge backfill.

use super::{Engine, UserMeta};

impl Engine {
    /// Backfill user_ids and user metadata where user was 0 but context was authenticated later or in another shard.
    pub fn backfill_ctx_users(&mut self) {
        if self.ctx_to_user.is_empty() {
            return;
        }
        self.backfill_user_ids();
        self.backfill_auth_failures();
        self.backfill_app_names();
    }

    /// Assign each row without a user the user its context authenticated as.
    fn backfill_user_ids(&mut self) {
        for index in 0..self.user_ids.len() {
            if self.user_ids[index] != 0 {
                continue;
            }
            let ctx_id = self.ctx_ids[index];
            if ctx_id == u16::MAX || (ctx_id as usize) >= self.ctx_to_user.len() {
                continue;
            }
            let user_id = self.ctx_to_user[ctx_id as usize];
            if user_id != 0 {
                self.user_ids[index] = user_id;
            }
        }
    }

    /// Add orphaned failed-auth counts to their user's totals.
    fn backfill_auth_failures(&mut self) {
        for (ctx_id, &fail_count) in self.ctx_auth_fails.iter().enumerate() {
            if fail_count == 0 || ctx_id >= self.ctx_to_user.len() {
                continue;
            }
            let user_id = self.ctx_to_user[ctx_id];
            if user_id > 0 && (user_id as usize) < self.user_meta.len() {
                self.user_meta[user_id as usize].auth_fail_count += fail_count;
            }
        }
        self.ctx_auth_fails.clear();
    }

    /// Copy per-context application names onto their user when unset.
    fn backfill_app_names(&mut self) {
        for (ctx_id, app_name) in self.ctx_app_names.iter().enumerate() {
            if app_name.is_empty() || ctx_id >= self.ctx_to_user.len() {
                continue;
            }
            let user_id = self.ctx_to_user[ctx_id];
            if user_id == 0 || (user_id as usize) >= self.user_meta.len() {
                continue;
            }
            let meta = &mut self.user_meta[user_id as usize];
            if meta.app_name.is_empty() {
                meta.app_name = app_name.clone();
            }
        }
        self.ctx_app_names.clear();
    }

    #[inline]
    pub(super) fn intern_ns(&mut self, ns: &str) -> u16 {
        if self
            .ns_strings
            .get(self.last_ns_id as usize)
            .is_some_and(|known| known == ns)
        {
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
    pub(super) fn intern_plan(&mut self, plan: &str) -> u16 {
        if self
            .plan_strings
            .get(self.last_plan_id as usize)
            .is_some_and(|known| known == plan)
        {
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
    pub(super) fn intern_fingerprint(&mut self, fp: &str, suggestion: &str) -> u16 {
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
    pub(super) fn intern_remote(&mut self, remote: &str) -> u16 {
        if self
            .remote_strings
            .get(self.last_remote_id as usize)
            .is_some_and(|known| known == remote)
        {
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
    pub(super) fn intern_user(&mut self, user: &str) -> u16 {
        let name = if user.is_empty() { "system" } else { user };
        if self
            .user_strings
            .get(self.last_user_id as usize)
            .is_some_and(|known| known == name)
        {
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
    pub(super) fn intern_ctx(&mut self, ctx: &str) -> u16 {
        if ctx.is_empty() {
            return u16::MAX;
        }
        if self
            .ctx_strings
            .get(self.last_ctx_id as usize)
            .is_some_and(|known| known == ctx)
        {
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

}
