use flate2::read::GzDecoder;
use std::io::{Cursor, Read};
use wasm_bindgen::prelude::*;
use zip::ZipArchive;

#[derive(serde::Serialize)]
pub struct ZipEntryInfo {
    pub index: usize,
    pub name: String,
    pub clean_name: String,
    pub uncompressed_size: u64,
    pub compressed_size: u64,
    pub data_start: u64,
    pub is_deflated: bool,
    pub is_dir: bool,
    pub category: String, // "pm2" | "mongo" | "unknown" | "skip"
}

#[derive(serde::Serialize)]
pub struct ExtractResult {
    pub clean_name: String,
    pub category: String,
}

fn strip_path_and_gz(name: &str) -> String {
    let lower = name.replace('\\', "/");
    let file_name = lower.rsplit('/').next().unwrap_or(&lower);
    if let Some(stripped) = file_name.strip_suffix(".gz") {
        stripped.to_string()
    } else {
        file_name.to_string()
    }
}

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

    // Check for Mongo JSON or legacy formats
    if sample.windows(8).any(|w| w == b"\"$date\"")
        || sample.windows(5).any(|w| w == b"\"msg\"")
        || sample.windows(5).any(|w| w == b"\"ctx\"")
        || sample.windows(15).any(|w| w == b"[initandlisten]")
        || sample.windows(6).any(|w| w == b"[conn")
    {
        return "mongo";
    }

    // Check for HTTP / PM2 log lines
    if sample.windows(4).any(|w| w == b"GET " || w == b"POST")
        || sample.windows(4).any(|w| w == b"PUT " || w == b"HEAD")
        || sample.windows(7).any(|w| w == b"DELETE " || w == b"OPTIONS")
        || sample.windows(6).any(|w| w == b"[cron]")
        || sample.windows(5).any(|w| w == b"[PM2]")
    {
        return "pm2";
    }

    "unknown"
}

#[wasm_bindgen]
pub struct ZipExtractor {
    archive_bytes: Vec<u8>,
}

#[wasm_bindgen]
impl ZipExtractor {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: Vec<u8>) -> Result<ZipExtractor, JsValue> {
        Ok(ZipExtractor {
            archive_bytes: bytes,
        })
    }

    pub fn inspect(&self) -> Result<JsValue, JsValue> {
        let cursor = Cursor::new(&self.archive_bytes);
        let mut archive = ZipArchive::new(cursor).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let mut entries = Vec::with_capacity(archive.len());

        for i in 0..archive.len() {
            let entry = archive.by_index(i).map_err(|e| JsValue::from_str(&e.to_string()))?;
            let name = entry.name().to_string();
            let is_dir = entry.is_dir();
            let clean_name = strip_path_and_gz(&name);
            let category = classify_by_name(&name).unwrap_or("unknown").to_string();
            let data_start = entry.data_start();
            let is_deflated = entry.compression() == zip::CompressionMethod::Deflated;

            entries.push(ZipEntryInfo {
                index: i,
                name,
                clean_name,
                uncompressed_size: entry.size(),
                compressed_size: entry.compressed_size(),
                data_start,
                is_deflated,
                is_dir,
                category,
            });
        }

        serde_wasm_bindgen::to_value(&entries).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn extract_entry(&self, index: usize) -> Result<js_sys::Uint8Array, JsValue> {
        let cursor = Cursor::new(&self.archive_bytes);
        let mut archive = ZipArchive::new(cursor).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let mut entry = archive.by_index(index).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let entry_name = entry.name().to_string();
        let data_start = entry.data_start() as usize;
        let comp_size = entry.compressed_size() as usize;
        let uncomp_size = entry.size() as usize;
        let is_deflated = entry.compression() == zip::CompressionMethod::Deflated;

        let data = if is_deflated && uncomp_size > 0 && data_start + comp_size <= self.archive_bytes.len() {
            let comp_slice = &self.archive_bytes[data_start..data_start + comp_size];
            let mut out = vec![0u8; uncomp_size];
            let mut decomp = Box::<miniz_oxide::inflate::core::DecompressorOxide>::default();
            let (status, _in_c, out_c) = miniz_oxide::inflate::core::decompress(
                &mut decomp,
                comp_slice,
                &mut out,
                0,
                miniz_oxide::inflate::core::inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF,
            );
            if status == miniz_oxide::inflate::TINFLStatus::Done && out_c == uncomp_size {
                out
            } else {
                miniz_oxide::inflate::decompress_to_vec(comp_slice)
                    .map_err(|e| JsValue::from_str(&format!("Deflate decompression failed: {e:?}")))?
            }
        } else if data_start + comp_size <= self.archive_bytes.len() {
            self.archive_bytes[data_start..data_start + comp_size].to_vec()
        } else {
            let mut fallback = Vec::with_capacity(uncomp_size);
            entry.read_to_end(&mut fallback).map_err(|e| JsValue::from_str(&e.to_string()))?;
            fallback
        };

        // If it's a .gz file or has gzip magic bytes (0x1f, 0x8b), decompress gzip
        let final_data = if entry_name.ends_with(".gz") || (data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b) {
            let mut gz = GzDecoder::new(&data[..]);
            let mut decompressed = Vec::new();
            gz.read_to_end(&mut decompressed)
                .map_err(|e| JsValue::from_str(&format!("Gzip error in {}: {e}", entry_name)))?;
            decompressed
        } else {
            data
        };

        // SAFETY: Typed array created from decompressed buffer copy
        Ok(js_sys::Uint8Array::from(&final_data[..]))
    }

    pub fn classify_entry_content(&self, data: &[u8]) -> String {
        classify_by_content(data).to_string()
    }
}

/// Zero-copy fast streaming decompressor for worker threads
#[wasm_bindgen]
pub struct FastDecompressor {
    output: Vec<u8>,
    decomp: Box<miniz_oxide::inflate::core::DecompressorOxide>,
}

#[wasm_bindgen]
impl FastDecompressor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> FastDecompressor {
        let mut decomp = Box::<miniz_oxide::inflate::core::DecompressorOxide>::default();
        decomp.init();
        FastDecompressor {
            output: Vec::new(),
            decomp,
        }
    }

    /// Decompress raw deflate bytes directly into linear memory.
    /// Returns raw pointer in Wasm memory to avoid intermediate copies.
    pub fn decompress_deflate(&mut self, compressed: &[u8], uncompressed_size: usize) -> Result<usize, JsValue> {
        self.output.clear();
        self.output.resize(uncompressed_size, 0);

        let config = zlib_rs::InflateConfig { window_bits: -15 };
        let (slice, rc) = zlib_rs::decompress_slice(&mut self.output, compressed, config);

        if rc != zlib_rs::ReturnCode::Ok || slice.len() != uncompressed_size {
            // Fallback to miniz_oxide
            self.decomp.init();
            let (status, _in_c, out_c) = miniz_oxide::inflate::core::decompress(
                &mut self.decomp,
                compressed,
                &mut self.output,
                0,
                miniz_oxide::inflate::core::inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF,
            );
            if status != miniz_oxide::inflate::TINFLStatus::Done || out_c != uncompressed_size {
                return Err(JsValue::from_str(&format!("Deflate decompression failed: {rc:?}")));
            }
        }

        // If decompressed data has gzip magic bytes (nested gzip), decompress it
        if self.output.len() >= 2 && self.output[0] == 0x1f && self.output[1] == 0x8b {
            let mut gz = GzDecoder::new(&self.output[..]);
            let mut nested = Vec::new();
            gz.read_to_end(&mut nested)
                .map_err(|e| JsValue::from_str(&format!("Nested gzip decompression failed: {e}")))?;
            self.output = nested;
        }

        Ok(self.output.as_ptr() as usize)
    }

    /// Decompress Gzip bytes directly into linear memory.
    pub fn decompress_gzip(&mut self, gz_bytes: &[u8]) -> Result<usize, JsValue> {
        let est_uncomp = if gz_bytes.len() >= 4 {
            let n = gz_bytes.len();
            u32::from_le_bytes([gz_bytes[n - 4], gz_bytes[n - 3], gz_bytes[n - 2], gz_bytes[n - 1]]) as usize
        } else {
            0
        };

        if est_uncomp > 0 && est_uncomp < 2 * 1024 * 1024 * 1024 {
            self.output.clear();
            self.output.resize(est_uncomp, 0);
            let config = zlib_rs::InflateConfig { window_bits: 31 };
            let (slice, rc) = zlib_rs::decompress_slice(&mut self.output, gz_bytes, config);
            if rc == zlib_rs::ReturnCode::Ok && slice.len() == est_uncomp {
                return Ok(self.output.as_ptr() as usize);
            }
        }

        self.output.clear();
        let mut gz = GzDecoder::new(gz_bytes);
        gz.read_to_end(&mut self.output)
            .map_err(|e| JsValue::from_str(&format!("Gzip decompression failed: {e}")))?;
        Ok(self.output.as_ptr() as usize)
    }

    pub fn output_ptr(&self) -> usize {
        self.output.as_ptr() as usize
    }

    pub fn output_len(&self) -> usize {
        self.output.len()
    }

    /// Release linear memory allocated for output buffer immediately.
    pub fn clear(&mut self) {
        self.output = Vec::new();
    }
}

/// Standalone Gzip decompressor for dropped .gz files
#[wasm_bindgen]
pub fn decompress_gz_bytes(data: &[u8]) -> Result<js_sys::Uint8Array, JsValue> {
    let mut gz = GzDecoder::new(data);
    let mut decompressed = Vec::new();
    gz.read_to_end(&mut decompressed)
        .map_err(|e| JsValue::from_str(&format!("Gzip decompression failed: {e}")))?;
    Ok(js_sys::Uint8Array::from(&decompressed[..]))
}

/// Fast classifier for standalone files or buffers
#[wasm_bindgen]
pub fn classify_log_name_or_content(name: &str, sample: &[u8]) -> String {
    if let Some(cat) = classify_by_name(name) {
        if cat != "unknown" {
            return cat.to_string();
        }
    }
    classify_by_content(sample).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classification_by_name() {
        assert_eq!(classify_by_name("mongod.log.1"), Some("mongo"));
        assert_eq!(classify_by_name("mongod.log.10.gz"), Some("mongo"));
        assert_eq!(classify_by_name("mongodb.log"), Some("mongo"));
        assert_eq!(classify_by_name("api-out.log.1"), Some("pm2"));
        assert_eq!(classify_by_name("api-error.log.5.gz"), Some("skip"));
        assert_eq!(classify_by_name("error.log"), Some("skip"));
        assert_eq!(classify_by_name(".DS_Store"), Some("skip"));
    }

    #[test]
    fn test_strip_path_and_gz() {
        assert_eq!(strip_path_and_gz("var/log/mongod.log.10.gz"), "mongod.log.10");
        assert_eq!(strip_path_and_gz("api-out.log.1"), "api-out.log.1");
    }

    #[test]
    fn test_all_entries_extraction() {
        let zip_path = "C:/Users/My_Home/Downloads/methaq-api&mongodb-07-09.zip";
        let Ok(bytes) = std::fs::read(zip_path) else { return; };
        let cursor = Cursor::new(&bytes);
        let mut archive = ZipArchive::new(cursor).unwrap();
        println!("Archive len: {}", archive.len());

        for i in 0..archive.len() {
            let entry = archive.by_index(i).unwrap();
            let name = entry.name().to_string();
            let data_start = entry.data_start() as usize;
            let comp_size = entry.compressed_size() as usize;
            let uncomp_size = entry.size() as usize;
            let is_deflated = entry.compression() == zip::CompressionMethod::Deflated;
            println!("Entry {i}: {name}, comp: {comp_size}, uncomp: {uncomp_size}, deflated: {is_deflated}");

            if is_deflated && uncomp_size > 0 {
                let comp_slice = &bytes[data_start..data_start + comp_size];
                let mut out = vec![0u8; uncomp_size];
                let mut decomp = Box::<miniz_oxide::inflate::core::DecompressorOxide>::default();
                let t0 = std::time::Instant::now();
                let (_status, _in_c, _out_c) = miniz_oxide::inflate::core::decompress(
                    &mut decomp,
                    comp_slice,
                    &mut out,
                    0,
                    miniz_oxide::inflate::core::inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF
                );
                let dur_miniz = t0.elapsed();

                let t1 = std::time::Instant::now();
                let mut out_zlib = vec![0u8; uncomp_size];
                let config = zlib_rs::InflateConfig { window_bits: -15 };
                let (slice, rc) = zlib_rs::decompress_slice(&mut out_zlib, comp_slice, config);
                let dur_zlib = t1.elapsed();
                assert_eq!(rc, zlib_rs::ReturnCode::Ok);
                assert_eq!(slice.len(), uncomp_size);
                println!("  -> miniz_oxide: {dur_miniz:?}, zlib-rs: {dur_zlib:?} (rc: {rc:?}, len: {})", slice.len());
            }
        }
    }
}

