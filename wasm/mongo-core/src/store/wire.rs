//! Shard wire format: encode, decode, and merge.

use super::{CheckpointRecord, DriverInfo, Engine, ErrorRecord, UserMeta};
use hashbrown::HashMap;

/// A number that writes itself little-endian into a byte sink.
trait LittleEndian {
    fn write_le(self, out: &mut Vec<u8>);
}

macro_rules! impl_little_endian {
    ($($type:ty),* $(,)?) => {
        $(impl LittleEndian for $type {
            fn write_le(self, out: &mut Vec<u8>) {
                out.extend_from_slice(&self.to_le_bytes());
            }
        })*
    };
}

impl_little_endian!(u16, u32, u64, i64, f32);

/// Append each number of `column` as little-endian bytes.
fn encode_numbers<Value: LittleEndian + Copy>(out: &mut Vec<u8>, column: &[Value]) {
    out.reserve(column.len() * std::mem::size_of::<Value>());
    for &value in column {
        value.write_le(out);
    }
}

/// Read `count` little-endian values into a fresh vector.
fn decode_column<Value>(
    reader: &mut ShardReader,
    count: usize,
    error: &'static str,
    read: impl Fn(&mut ShardReader) -> Option<Value>,
) -> Result<Vec<Value>, &'static str> {
    let mut values = Vec::with_capacity(count);
    for _ in 0..count {
        values.push(read(reader).ok_or(error)?);
    }
    Ok(values)
}

/// Map each name to its index; later duplicates win, as the encoder wrote them.
fn index_by_name(names: &[String]) -> HashMap<String, u16> {
    let mut table = HashMap::with_capacity(names.len());
    for (index, name) in names.iter().enumerate() {
        table.insert(name.clone(), index as u16);
    }
    table
}

/// Append a `u16`-length-prefixed vector of unsigned shorts.
fn encode_u16_vec(out: &mut Vec<u8>, values: &[u16]) {
    out.extend_from_slice(&(values.len() as u16).to_le_bytes());
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
}

/// Append a `u16`-length-prefixed vector of unsigned ints.
fn encode_u32_vec(out: &mut Vec<u8>, values: &[u32]) {
    out.extend_from_slice(&(values.len() as u16).to_le_bytes());
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
}

impl Engine {
    /// Serializes shard columnar data, string tables, and diagnostics into a compact
    /// binary wire format for zero-copy transfer across Web Worker threads.
    pub fn encode_shard(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4096 + self.durations_ms.len() * 48);
        out.extend_from_slice(b"MGSH");
        out.extend_from_slice(&1u16.to_le_bytes());
        self.encode_diagnostics(&mut out);
        self.encode_arena(&mut out);
        self.encode_columns(&mut out);
        out
    }

    /// Counters, drivers, errors, checkpoints, and dates.
    fn encode_diagnostics(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&(self.total_lines as u64).to_le_bytes());
        out.extend_from_slice(&self.conn_accepted.to_le_bytes());
        out.extend_from_slice(&self.conn_ended.to_le_bytes());
        out.extend_from_slice(&self.conn_peak.to_le_bytes());
        out.extend_from_slice(&self.auth_success.to_le_bytes());
        out.extend_from_slice(&self.auth_fail.to_le_bytes());
        out.extend_from_slice(&self.ops_mask.to_le_bytes());

        out.extend_from_slice(&(self.drivers.len() as u32).to_le_bytes());
        for driver in &self.drivers {
            write_str_u16(out, &driver.name);
            write_str_u16(out, &driver.version);
            write_str_u16(out, &driver.platform);
            write_str_u16(out, &driver.os_name);
            write_str_u16(out, &driver.os_version);
            out.extend_from_slice(&driver.count.to_le_bytes());
        }

        out.extend_from_slice(&(self.errors.len() as u32).to_le_bytes());
        for error in &self.errors {
            write_str_u16(out, &error.timestamp);
            out.push(error.severity);
            out.extend_from_slice(&error.id.to_le_bytes());
            write_str_u16(out, &error.msg);
            out.extend_from_slice(&error.count.to_le_bytes());
        }

        out.extend_from_slice(&(self.checkpoints.len() as u32).to_le_bytes());
        for checkpoint in &self.checkpoints {
            write_str_u16(out, &checkpoint.timestamp);
            write_str_u16(out, &checkpoint.msg);
        }

        write_str_vec(out, &self.dates);
    }

    /// The string arena and its side tables.
    fn encode_arena(&self, out: &mut Vec<u8>) {
        write_str_vec(out, &self.ns_strings);
        write_str_vec(out, &self.plan_strings);

        out.extend_from_slice(&(self.fingerprint_strings.len() as u16).to_le_bytes());
        for (index, fingerprint) in self.fingerprint_strings.iter().enumerate() {
            write_str_u16(out, fingerprint);
            let suggestion = self
                .index_suggestions
                .get(index)
                .map(String::as_str)
                .unwrap_or("");
            write_str_u16(out, suggestion);
        }

        write_str_vec(out, &self.remote_strings);
        write_str_vec(out, &self.user_strings);
        self.encode_user_meta(out);
        write_str_vec(out, &self.ctx_strings);
        encode_u16_vec(out, &self.ctx_to_user);
        encode_u32_vec(out, &self.ctx_auth_fails);
        write_str_vec(out, &self.ctx_app_names);
    }

    /// Per-user authentication metadata.
    fn encode_user_meta(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&(self.user_meta.len() as u16).to_le_bytes());
        for meta in &self.user_meta {
            write_str_u16(out, &meta.auth_db);
            write_str_u16(out, &meta.app_name);
            write_str_vec(out, &meta.client_ips);
            out.extend_from_slice(&meta.first_seen_ms.to_le_bytes());
            out.extend_from_slice(&meta.last_seen_ms.to_le_bytes());
            out.extend_from_slice(&meta.auth_success_count.to_le_bytes());
            out.extend_from_slice(&meta.auth_fail_count.to_le_bytes());
        }
    }

    /// The columnar rows.
    fn encode_columns(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&(self.durations_ms.len() as u32).to_le_bytes());
        if self.durations_ms.is_empty() {
            return;
        }
        encode_numbers(out, &self.timestamps_ms);
        encode_numbers(out, &self.durations_ms);
        encode_numbers(out, &self.ns_ids);
        out.extend_from_slice(&self.op_ids);
        encode_numbers(out, &self.plan_ids);
        encode_numbers(out, &self.fingerprint_ids);
        encode_numbers(out, &self.docs_examined);
        encode_numbers(out, &self.keys_examined);
        encode_numbers(out, &self.nreturned);
        encode_numbers(out, &self.num_yields);
        encode_numbers(out, &self.reslens);
        for collscan in &self.is_collscan {
            out.push(u8::from(*collscan));
        }
        encode_numbers(out, &self.remote_ids);
        encode_numbers(out, &self.user_ids);
        encode_numbers(out, &self.ctx_ids);
    }

    /// Decodes a serialized shard wire into an Engine.
    pub fn decode_shard(data: &[u8]) -> Result<Engine, &'static str> {
        let mut reader = ShardReader::new(data);
        let magic = reader.take(4).ok_or("truncated shard header")?;
        if magic != b"MGSH" {
            return Err("invalid shard magic");
        }
        if reader.u16() != Some(1) {
            return Err("unsupported shard version");
        }

        let mut engine = Engine::new();
        // A decoded shard never ingests: drop the window the constructor reserved.
        engine.ingest = Vec::new();
        engine.decode_diagnostics(&mut reader)?;
        engine.decode_arena(&mut reader)?;
        engine.decode_columns(&mut reader)?;
        Ok(engine)
    }

    /// Counters, drivers, errors, and checkpoints.
    fn decode_diagnostics(&mut self, reader: &mut ShardReader) -> Result<(), &'static str> {
        self.total_lines = reader.u64().ok_or("truncated total_lines")? as usize;
        self.conn_accepted = reader.u32().ok_or("truncated conn_accepted")?;
        self.conn_ended = reader.u32().ok_or("truncated conn_ended")?;
        self.conn_peak = reader.u32().ok_or("truncated conn_peak")?;
        self.auth_success = reader.u32().ok_or("truncated auth_success")?;
        self.auth_fail = reader.u32().ok_or("truncated auth_fail")?;
        self.ops_mask = reader.u16().ok_or("truncated ops_mask")?;

        let driver_count = reader.u32().ok_or("truncated drivers count")? as usize;
        self.drivers = Vec::with_capacity(driver_count);
        for _ in 0..driver_count {
            self.drivers.push(DriverInfo {
                name: reader.str_u16().ok_or("truncated driver name")?,
                version: reader.str_u16().ok_or("truncated driver version")?,
                platform: reader.str_u16().ok_or("truncated driver platform")?,
                os_name: reader.str_u16().ok_or("truncated driver os_name")?,
                os_version: reader.str_u16().ok_or("truncated driver os_version")?,
                count: reader.u32().ok_or("truncated driver count")?,
            });
        }

        let error_count = reader.u32().ok_or("truncated errors count")? as usize;
        self.errors = Vec::with_capacity(error_count);
        for _ in 0..error_count {
            self.errors.push(ErrorRecord {
                timestamp: reader.str_u16().ok_or("truncated error ts")?,
                severity: reader.u8().ok_or("truncated error sev")?,
                id: reader.u32().ok_or("truncated error id")?,
                msg: reader.str_u16().ok_or("truncated error msg")?,
                count: reader.u32().ok_or("truncated error count")?,
            });
        }

        let checkpoint_count = reader.u32().ok_or("truncated checkpoints count")? as usize;
        self.checkpoints = Vec::with_capacity(checkpoint_count);
        for _ in 0..checkpoint_count {
            self.checkpoints.push(CheckpointRecord {
                timestamp: reader.str_u16().ok_or("truncated cp ts")?,
                msg: reader.str_u16().ok_or("truncated cp msg")?,
            });
        }
        self.dates = reader.str_vec().ok_or("truncated dates")?;
        Ok(())
    }

    /// The string arena, its side tables, and the rebuilt lookup maps.
    fn decode_arena(&mut self, reader: &mut ShardReader) -> Result<(), &'static str> {
        self.ns_strings = reader.str_vec().ok_or("truncated ns_strings")?;
        self.plan_strings = reader.str_vec().ok_or("truncated plan_strings")?;

        let fingerprint_count = reader.u16().ok_or("truncated fps count")? as usize;
        self.fingerprint_strings = Vec::with_capacity(fingerprint_count);
        self.index_suggestions = Vec::with_capacity(fingerprint_count);
        for _ in 0..fingerprint_count {
            self.fingerprint_strings
                .push(reader.str_u16().ok_or("truncated fp")?);
            self.index_suggestions
                .push(reader.str_u16().ok_or("truncated sug")?);
        }

        self.remote_strings = reader.str_vec().ok_or("truncated remote_strings")?;
        self.user_strings = reader.str_vec().ok_or("truncated user_strings")?;
        self.decode_user_meta(reader)?;
        self.ctx_strings = reader.str_vec().ok_or("truncated ctx_strings")?;

        let ctx_user_count = reader.u16().ok_or("truncated ctx_to_user count")? as usize;
        self.ctx_to_user = decode_column(reader, ctx_user_count, "truncated ctx_to_user entry", |source| source.u16())?;
        let ctx_fail_count = reader.u16().ok_or("truncated ctx_auth_fails count")? as usize;
        self.ctx_auth_fails =
            decode_column(reader, ctx_fail_count, "truncated ctx_auth_fails entry", |source| source.u32())?;
        self.ctx_app_names = reader.str_vec().ok_or("truncated ctx_app_names")?;

        self.ns_table = index_by_name(&self.ns_strings);
        self.plan_table = index_by_name(&self.plan_strings);
        self.fingerprint_table = index_by_name(&self.fingerprint_strings);
        self.remote_table = index_by_name(&self.remote_strings);
        self.user_table = index_by_name(&self.user_strings);
        self.ctx_table = index_by_name(&self.ctx_strings);
        Ok(())
    }

    /// Per-user authentication metadata.
    fn decode_user_meta(&mut self, reader: &mut ShardReader) -> Result<(), &'static str> {
        let count = reader.u16().ok_or("truncated user_meta count")? as usize;
        self.user_meta = Vec::with_capacity(count);
        for _ in 0..count {
            self.user_meta.push(UserMeta {
                auth_db: reader.str_u16().ok_or("truncated auth_db")?,
                app_name: reader.str_u16().ok_or("truncated app_name")?,
                client_ips: reader.str_vec().ok_or("truncated client_ips")?,
                first_seen_ms: reader.i64().ok_or("truncated first_seen_ms")?,
                last_seen_ms: reader.i64().ok_or("truncated last_seen_ms")?,
                auth_success_count: reader.u32().ok_or("truncated auth_success_count")?,
                auth_fail_count: reader.u32().ok_or("truncated auth_fail_count")?,
            });
        }
        Ok(())
    }

    /// The columnar rows.
    fn decode_columns(&mut self, reader: &mut ShardReader) -> Result<(), &'static str> {
        let count = reader.u32().ok_or("truncated columnar count")? as usize;
        self.timestamps_ms = decode_column(reader, count, "truncated timestamps_ms", |source| source.i64())?;
        self.durations_ms = decode_column(reader, count, "truncated durations_ms", |source| source.u32())?;
        self.ns_ids = decode_column(reader, count, "truncated ns_ids", |source| source.u16())?;
        self.op_ids = reader.take(count).ok_or("truncated op_ids")?.to_vec();
        self.plan_ids = decode_column(reader, count, "truncated plan_ids", |source| source.u16())?;
        self.fingerprint_ids = decode_column(reader, count, "truncated fingerprint_ids", |source| source.u16())?;
        self.docs_examined = decode_column(reader, count, "truncated docs_examined", |source| source.u32())?;
        self.keys_examined = decode_column(reader, count, "truncated keys_examined", |source| source.u32())?;
        self.nreturned = decode_column(reader, count, "truncated nreturned", |source| source.u32())?;
        self.num_yields = decode_column(reader, count, "truncated num_yields", |source| source.u32())?;
        self.reslens = decode_column(reader, count, "truncated reslens", |source| source.u32())?;
        let collscan = reader.take(count).ok_or("truncated is_collscan")?;
        self.is_collscan = collscan.iter().map(|&byte| byte != 0).collect();
        self.remote_ids = decode_column(reader, count, "truncated remote_ids", |source| source.u16())?;
        self.user_ids = decode_column(reader, count, "truncated user_ids", |source| source.u16())?;
        self.ctx_ids = decode_column(reader, count, "truncated ctx_ids", |source| source.u16())?;
        Ok(())
    }

}

#[inline]
fn write_str_u16(out: &mut Vec<u8>, text: &str) {
    let bytes = text.as_bytes();
    out.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(bytes);
}

#[inline]
fn write_str_vec(out: &mut Vec<u8>, vec: &[String]) {
    out.extend_from_slice(&(vec.len() as u16).to_le_bytes());
    for s in vec {
        write_str_u16(out, s);
    }
}

struct ShardReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> ShardReader<'a> {
    #[inline]
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    #[inline]
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.pos + n <= self.data.len() {
            let slice = &self.data[self.pos..self.pos + n];
            self.pos += n;
            Some(slice)
        } else {
            None
        }
    }

    #[inline]
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|bytes| bytes[0])
    }

    #[inline]
    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    #[inline]
    fn u32(&mut self) -> Option<u32> {
        self.take(4).map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    #[inline]
    fn u64(&mut self) -> Option<u64> {
        self.take(8).map(|bytes| {
            u64::from_le_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            ])
        })
    }

    #[inline]
    fn i64(&mut self) -> Option<i64> {
        self.take(8).map(|bytes| {
            i64::from_le_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            ])
        })
    }

    #[inline]
    fn str_u16(&mut self) -> Option<String> {
        let len = self.u16()? as usize;
        let bytes = self.take(len)?;
        Some(String::from_utf8_lossy(bytes).into_owned())
    }

    #[inline]
    fn str_vec(&mut self) -> Option<Vec<String>> {
        let count = self.u16()? as usize;
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            out.push(self.str_u16()?);
        }
        Some(out)
    }
}
