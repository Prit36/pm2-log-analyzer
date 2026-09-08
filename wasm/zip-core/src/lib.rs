use wasm_bindgen::prelude::*;

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
        output.resize(target_size, 0);
        let (slice, rc) = zlib_rs::decompress_slice(output, gz_bytes, config);
        match rc {
            zlib_rs::ReturnCode::Ok | zlib_rs::ReturnCode::StreamEnd => {
                let actual_len = slice.len();
                output.truncate(actual_len);
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
        self.output.resize(uncompressed_size, 0);

        let config = zlib_rs::InflateConfig { window_bits: -15 };
        let (slice, rc) = zlib_rs::decompress_slice(&mut self.output, compressed, config);

        if (rc != zlib_rs::ReturnCode::Ok && rc != zlib_rs::ReturnCode::StreamEnd)
            || slice.len() != uncompressed_size
        {
            return Err(JsValue::from_str(&format!(
                "Deflate decompression failed: {rc:?}"
            )));
        }

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
        decompress_gzip_internal(gz_bytes, &mut self.output)
            .map_err(JsValue::from_str)?;
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
        self.nested_output = Vec::new();
    }
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
    fn test_deflate_decompression() {
        let raw_deflate = [
            0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0xe1, 0x02, 0x00,
        ];
        let mut out = Vec::new();
        out.resize(12, 0);
        let config = zlib_rs::InflateConfig { window_bits: -15 };
        let (slice, rc) = zlib_rs::decompress_slice(&mut out, &raw_deflate, config);
        assert!(rc == zlib_rs::ReturnCode::Ok || rc == zlib_rs::ReturnCode::StreamEnd);
        assert_eq!(slice, b"hello world\n");
    }

    #[test]
    fn test_gzip_decompression() {
        let gz_bytes = [
            0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0xcb, 0x48, 0xcd,
            0xc9, 0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0xe1, 0x02, 0x00, 0x2d, 0x3b,
            0x08, 0xaf, 0x0c, 0x00, 0x00, 0x00,
        ];
        let mut out = Vec::new();
        let res = decompress_gzip_internal(&gz_bytes, &mut out);
        assert!(res.is_ok());
        assert_eq!(&out, b"hello world\n");
    }
}
