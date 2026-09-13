//! Path, date, and normalize-mode interning.

use super::{hash_bytes, path_head16, Engine, PathSlot, PATH_CACHE_SLOTS};
use crate::normalize::{normalize_into, NormalizeMode};
use hashbrown::HashTable;

impl Engine {
    /// Intern a raw path into the path arena; returns its id.
    #[inline(always)]
    pub(super) fn intern_path(&mut self, path: &[u8]) -> u32 {
        if let Some(id) = self.reuse_last_path(path) {
            return id;
        }
        let hash = hash_bytes(path);
        let length = path.len() as u16;
        let head = path_head16(path);
        let cache_slot = (hash as usize) & (PATH_CACHE_SLOTS - 1);
        if let Some(id) = self.probe_path_cache(hash, length, head, cache_slot) {
            return id;
        }
        self.push_new_path(path, hash, length, head, cache_slot)
    }

    /// The last interned path, when this line repeats it (runs of equal paths).
    #[inline(always)]
    fn reuse_last_path(&self, path: &[u8]) -> Option<u32> {
        let last_id = self.last_path_id?;
        let index = last_id as usize;
        if index >= self.path_off.len() {
            return None;
        }
        let offset = self.path_off[index] as usize;
        let length = self.path_len[index] as usize;
        if path.len() == length && &self.path_bytes[offset..offset + length] == path {
            return Some(last_id);
        }
        None
    }

    /// The direct-mapped cache, then the fingerprint table.
    fn probe_path_cache(
        &mut self,
        hash: u64,
        length: u16,
        head: u16,
        cache_slot: usize,
    ) -> Option<u32> {
        let (cached_hash, cached_id, cached_len, cached_head) = self.path_cache[cache_slot];
        if cached_hash == hash
            && cached_len == length
            && cached_head == head
            && cached_id != u32::MAX
        {
            self.last_path_id = Some(cached_id);
            return Some(cached_id);
        }
        let found = self
            .path_table
            .find(hash, |entry| {
                entry.hash == hash && entry.len == length && entry.head == head
            })
            .map(|entry| entry.id)?;
        self.path_cache[cache_slot] = (hash, found, length, head);
        self.last_path_id = Some(found);
        Some(found)
    }

    /// Append a brand-new path to the arena and both lookup structures.
    fn push_new_path(
        &mut self,
        path: &[u8],
        hash: u64,
        length: u16,
        head: u16,
        cache_slot: usize,
    ) -> u32 {
        let next_id = self.path_off.len() as u32;
        let offset = self.path_bytes.len() as u32;
        self.path_bytes.extend_from_slice(path);
        self.path_off.push(offset);
        self.path_len.push(length);
        self.mode_ready = [false; 3];
        self.path_table.insert_unique(
            hash,
            PathSlot {
                hash,
                id: next_id,
                len: length,
                head,
            },
            |entry| entry.hash,
        );
        self.path_cache[cache_slot] = (hash, next_id, length, head);
        self.last_path_id = Some(next_id);
        next_id
    }

    fn path_slice(&self, id: usize) -> &[u8] {
        let offset = self.path_off[id] as usize;
        let length = self.path_len[id] as usize;
        &self.path_bytes[offset..offset + length]
    }

    pub fn path_bytes_of(&self, path_id: usize) -> Option<Vec<u8>> {
        if path_id >= self.path_off.len() {
            return None;
        }
        Some(self.path_slice(path_id).to_vec())
    }

    /// Intern a date into the date table; returns its 1-based id.
    pub(super) fn intern_date(&mut self, date: [u8; 10]) -> u16 {
        let id = match self.dates.iter().position(|&known| known == date) {
            Some(position) => (position + 1) as u16,
            None => {
                self.dates.push(date);
                self.dates.len() as u16
            }
        };
        self.last_date = date;
        self.last_date_id = id;
        id
    }

    fn intern_norm_into(
        norm_bytes: &mut Vec<u8>,
        norm_off: &mut Vec<u32>,
        norm_len: &mut Vec<u16>,
        norm_table: &mut HashTable<u32>,
        path: &[u8],
    ) -> u32 {
        let hash = hash_bytes(path);
        if let Some(&id) = norm_table.find(hash, |&id| {
            let offset = norm_off[id as usize] as usize;
            let length = norm_len[id as usize] as usize;
            &norm_bytes[offset..offset + length] == path
        }) {
            return id;
        }

        let next_id = norm_off.len() as u32;
        let offset = norm_bytes.len() as u32;
        norm_bytes.extend_from_slice(path);
        norm_off.push(offset);
        norm_len.push(path.len() as u16);

        norm_table.insert_unique(hash, next_id, |&id| {
            let offset = norm_off[id as usize] as usize;
            let length = norm_len[id as usize] as usize;
            hash_bytes(&norm_bytes[offset..offset + length])
        });
        next_id
    }

    pub fn norm_path_bytes(&self, mode: u8, norm_id: usize) -> Option<Vec<u8>> {
        let mode_index = mode as usize;
        if mode_index > 2 {
            return None;
        }
        if mode_index == NormalizeMode::Exact as usize {
            return self.path_bytes_of(norm_id);
        }
        if norm_id >= self.norm_off[mode_index].len() {
            return None;
        }
        let offset = self.norm_off[mode_index][norm_id] as usize;
        let length = self.norm_len[mode_index][norm_id] as usize;
        Some(self.norm_bytes[mode_index][offset..offset + length].to_vec())
    }

    pub fn ensure_mode(&mut self, mode: u8) {
        let mode_enum = NormalizeMode::from_u8(mode);
        let mode_index = mode_enum as usize;
        if mode_enum == NormalizeMode::Exact {
            self.mode_ready[mode_index] = true;
            return;
        }
        if self.mode_ready[mode_index] && self.path_to_norm[mode_index].len() == self.path_off.len() {
            return;
        }
        self.norm_bytes[mode_index].clear();
        self.norm_off[mode_index].clear();
        self.norm_len[mode_index].clear();
        self.norm_table[mode_index].clear();
        self.path_to_norm[mode_index].resize(self.path_off.len(), 0);
        self.build_normalized_paths(mode_enum);
        self.mode_ready[mode_index] = true;
    }

    /// Normalize every interned path into the mode's arena.
    fn build_normalized_paths(&mut self, mode: NormalizeMode) {
        let mode_index = mode as usize;
        let norm_bytes = &mut self.norm_bytes[mode_index];
        let norm_off = &mut self.norm_off[mode_index];
        let norm_len = &mut self.norm_len[mode_index];
        let norm_table = &mut self.norm_table[mode_index];
        let path_bytes = &self.path_bytes;
        let path_off = &self.path_off;
        let path_len = &self.path_len;
        let path_to_norm = &mut self.path_to_norm[mode_index];
        let mut scratch = Vec::with_capacity(256);
        for path_id in 0..path_off.len() {
            let offset = path_off[path_id] as usize;
            let length = path_len[path_id] as usize;
            let normalized = normalize_into(&path_bytes[offset..offset + length], mode, &mut scratch);
            path_to_norm[path_id] = Self::intern_norm_into(
                norm_bytes,
                norm_off,
                norm_len,
                norm_table,
                normalized,
            );
        }
    }

    pub fn finalize_paths(&mut self) {
        for mode in 0u8..3 {
            self.ensure_mode(mode);
        }
    }
}
