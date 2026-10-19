use wasm_bindgen::prelude::*;
#[cfg(target_arch = "wasm32")]
mod browser_archive;
mod bzip_parallel;
#[cfg(target_arch = "wasm32")]
mod bzip_reader;
pub use bzip_parallel::{BzipBlockDecoder, BzipScanner};
mod tar_stream;
pub use tar_stream::TarStream;
mod xz_parallel;
pub use xz_parallel::{XzBlockDecoder, inspect_xz_blob};
mod sevenzip;
#[cfg(target_arch = "wasm32")]
mod tar_archive;
#[cfg(target_arch = "wasm32")]
pub use browser_archive::{extract_archive_stream, inspect_tar_blob};
pub use sevenzip::{inspect_sevenz, sevenz_crc_combine};

fn classify_by_name(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase().replace('\\', "/");
    let file_name = lower.rsplit('/').next().unwrap_or(&lower);

    // Skip hidden files, system files, OSX metadata
    if file_name.starts_with('.') || file_name.starts_with("__macosx") {
        return Some("skip");
    }

    // Skip error logs — they do not contain API timing metrics
    if file_name.contains("error") {
        return Some("skip");
    }

    if file_name.contains("nginx")
        || file_name == "access"
        || file_name.starts_with("access.")
        || file_name.starts_with("access-")
        || file_name.starts_with("access_")
        || file_name.ends_with("-access.log")
        || file_name.ends_with("_access.log")
    {
        return Some("nginx");
    }

    // Mongo patterns: mongod.log*, mongodb.log*, mongo*.log*
    if file_name.starts_with("mongod")
        || file_name.starts_with("mongodb")
        || file_name.starts_with("mongo.")
        || file_name.starts_with("mongo-")
        || file_name.starts_with("mongo_")
        || file_name.contains("mongod.log")
        || file_name.contains("mongodb.log")
    {
        return Some("mongo");
    }

    // API / PM2 patterns: api-out.log*, pm2*, out.log, etc.
    if file_name.contains("api-out")
        || file_name.contains("api_out")
        || file_name.starts_with("api.")
        || file_name.starts_with("api-")
        || file_name.contains("pm2")
        || file_name.starts_with("out.log")
    {
        return Some("pm2");
    }

    None
}

fn classify_by_content(data: &[u8]) -> &'static str {
    let sample_len = data.len().min(4096);
    let sample = &data[..sample_len];

    // Combined access logs quote the request immediately after a CLF timestamp.
    // This check precedes generic HTTP detection because both contain GET/POST.
    for line in sample.split(|byte| *byte == b'\n') {
        if let Some(open) = line.iter().position(|byte| *byte == b'[') {
            let stamp = &line[open + 1..];
            if stamp.len() >= 30
                && stamp[2] == b'/'
                && stamp[6] == b'/'
                && stamp[11] == b':'
                && stamp[14] == b':'
                && stamp[17] == b':'
                && stamp[20] == b' '
                && matches!(stamp[21], b'+' | b'-')
                && stamp[26..29] == *b"] \""
            {
                return "nginx";
            }
        }
    }

    // Check for Mongo JSON or legacy formats
    if sample.windows(8).any(|window| window == b"\"$date\"")
        || sample.windows(5).any(|window| window == b"\"msg\"")
        || sample.windows(5).any(|window| window == b"\"ctx\"")
        || sample
            .windows(15)
            .any(|window| window == b"[initandlisten]")
        || sample.windows(6).any(|window| window == b"[conn")
    {
        return "mongo";
    }

    // Check for HTTP / PM2 log lines
    if sample
        .windows(4)
        .any(|window| window == b"GET " || window == b"POST")
        || sample
            .windows(4)
            .any(|window| window == b"PUT " || window == b"HEAD")
        || sample
            .windows(7)
            .any(|window| window == b"DELETE " || window == b"OPTIONS")
        || sample.windows(6).any(|window| window == b"[cron]")
        || sample.windows(5).any(|window| window == b"[PM2]")
    {
        return "pm2";
    }

    "unknown"
}

fn decompress_gzip_internal(gz_bytes: &[u8], output: &mut Vec<u8>) -> Result<(), &'static str> {
    if gz_bytes.len() < 10 {
        return Err("Gzip buffer too small");
    }

    let n = gz_bytes.len();
    let isize = u32::from_le_bytes([
        gz_bytes[n - 4],
        gz_bytes[n - 3],
        gz_bytes[n - 2],
        gz_bytes[n - 1],
    ]) as usize;

    let mut target_size = if isize > 0 && isize < 2 * 1024 * 1024 * 1024 {
        isize
    } else {
        gz_bytes.len().saturating_mul(4).max(64 * 1024)
    };

    let config = zlib_rs::InflateConfig { window_bits: 31 };

    for _ in 0..10 {
        output.clear();
        output.reserve_exact(target_size);
        let dest = unsafe {
            core::slice::from_raw_parts_mut(
                output.as_mut_ptr() as *mut core::mem::MaybeUninit<u8>,
                target_size,
            )
        };
        let (slice, rc) = zlib_rs::inflate::uncompress(dest, gz_bytes, config);
        match rc {
            zlib_rs::ReturnCode::Ok | zlib_rs::ReturnCode::StreamEnd => {
                let actual_len = slice.len();
                unsafe { output.set_len(actual_len) };
                return Ok(());
            }
            zlib_rs::ReturnCode::BufError => {
                target_size = target_size.saturating_mul(2);
                if target_size > 2 * 1024 * 1024 * 1024 {
                    return Err("Decompressed size exceeds 2GB limit");
                }
            }
            _ => {
                return Err("Gzip decompression failed");
            }
        }
    }
    Err("Gzip decompression buffer exceeded retry limit")
}

/// Zero-copy fast streaming decompressor for worker threads
#[wasm_bindgen]
pub struct FastDecompressor {
    output: Vec<u8>,
    nested_output: Vec<u8>,
}

impl Default for FastDecompressor {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl FastDecompressor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> FastDecompressor {
        FastDecompressor {
            output: Vec::new(),
            nested_output: Vec::new(),
        }
    }

    /// Decompress raw deflate bytes directly into linear memory.
    /// Returns raw pointer in Wasm memory to avoid intermediate copies.
    pub fn decompress_deflate(
        &mut self,
        compressed: &[u8],
        uncompressed_size: usize,
    ) -> Result<usize, JsValue> {
        self.output.clear();
        self.output.reserve_exact(uncompressed_size);

        let config = zlib_rs::InflateConfig { window_bits: -15 };
        let dest = unsafe {
            core::slice::from_raw_parts_mut(
                self.output.as_mut_ptr() as *mut core::mem::MaybeUninit<u8>,
                uncompressed_size,
            )
        };
        let (slice, rc) = zlib_rs::inflate::uncompress(dest, compressed, config);

        if (rc != zlib_rs::ReturnCode::Ok && rc != zlib_rs::ReturnCode::StreamEnd)
            || slice.len() != uncompressed_size
        {
            return Err(JsValue::from_str(&format!(
                "Deflate decompression failed: {rc:?}",
            )));
        }

        unsafe { self.output.set_len(uncompressed_size) };

        // If decompressed data has gzip magic bytes (nested gzip), decompress it
        if self.output.len() >= 2 && self.output[0] == 0x1f && self.output[1] == 0x8b {
            decompress_gzip_internal(&self.output, &mut self.nested_output)
                .map_err(JsValue::from_str)?;
            std::mem::swap(&mut self.output, &mut self.nested_output);
        }

        Ok(self.output.as_ptr() as usize)
    }

    /// Decompress Gzip bytes directly into linear memory.
    pub fn decompress_gzip(&mut self, gz_bytes: &[u8]) -> Result<usize, JsValue> {
        decompress_gzip_internal(gz_bytes, &mut self.output).map_err(JsValue::from_str)?;
        Ok(self.output.as_ptr() as usize)
    }

    pub fn output_ptr(&self) -> usize {
        self.output.as_ptr() as usize
    }

    pub fn output_len(&self) -> usize {
        self.output.len()
    }

    /// Decode a dictionary-reset LZMA2 range into a reusable worker output window.
    pub fn decompress_lzma2(
        &mut self,
        compressed: &[u8],
        dict_size: u32,
        output_size: usize,
    ) -> Result<usize, JsValue> {
        sevenzip::decode_segment(compressed, dict_size, output_size, &mut self.output)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        Ok(self.output.as_ptr() as usize)
    }

    pub fn output_crc(&self, offset: usize, length: usize) -> Result<u32, JsValue> {
        let bytes = offset
            .checked_add(length)
            .and_then(|end| self.output.get(offset..end))
            .ok_or_else(|| JsValue::from_str("Invalid checksum range"))?;
        Ok(crc32fast::hash(bytes))
    }

    /// Release linear memory allocated for output buffer immediately.
    pub fn clear(&mut self) {
        self.output = Vec::new();
        self.nested_output = Vec::new();
    }
}

/// Fast classifier for standalone files or buffers
#[wasm_bindgen]
pub fn classify_log_name_or_content(name: &str, sample: &[u8]) -> String {
    let named = classify_by_name(name);
    if named == Some("skip") {
        return "skip".to_string();
    }
    let content = classify_by_content(sample);
    if content == "nginx" {
        return content.to_string();
    }
    if let Some(cat) = named {
        if cat != "unknown" {
            return cat.to_string();
        }
    }
    content.to_string()
}
