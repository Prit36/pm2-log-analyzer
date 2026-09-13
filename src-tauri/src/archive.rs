use std::borrow::Cow;

#[derive(Debug, Clone)]
pub struct ZipEntryMeta {
    pub name: String,
    pub compression_method: u16,
    pub compressed_size: usize,
    pub uncompressed_size: usize,
    pub data_start: usize,
}

/// Parse Central Directory entries from a ZIP archive byte slice (e.g. mmap).
pub fn parse_zip_entries(zip_bytes: &[u8]) -> Result<Vec<ZipEntryMeta>, String> {
    let n = zip_bytes.len();
    if n < 22 {
        return Err("File too small to be a valid ZIP archive".into());
    }

    // EOCD is within the last 65557 bytes (22 min + 65535 max comment)
    let search_start = n.saturating_sub(65557);
    let tail = &zip_bytes[search_start..];

    let mut eocd_rel_offset = None;
    for i in (0..=tail.len().saturating_sub(22)).rev() {
        if tail[i] == 0x50 && tail[i + 1] == 0x4b && tail[i + 2] == 0x05 && tail[i + 3] == 0x06 {
            eocd_rel_offset = Some(i);
            break;
        }
    }

    let eocd_offset =
        search_start + eocd_rel_offset.ok_or("End of Central Directory record not found")?;
    let eocd = &zip_bytes[eocd_offset..];

    let total_entries = u16::from_le_bytes([eocd[10], eocd[11]]) as usize;
    let cd_size = u32::from_le_bytes([eocd[12], eocd[13], eocd[14], eocd[15]]) as usize;
    let cd_offset = u32::from_le_bytes([eocd[16], eocd[17], eocd[18], eocd[19]]) as usize;

    if cd_offset + cd_size > zip_bytes.len() {
        return Err("Invalid Central Directory offset in ZIP archive".into());
    }

    let mut entries = Vec::with_capacity(total_entries.min(1024));
    let mut cursor = cd_offset;

    for _ in 0..total_entries {
        if cursor + 46 > zip_bytes.len() {
            break;
        }
        if &zip_bytes[cursor..cursor + 4] != b"PK\x01\x02" {
            break;
        }

        let method = u16::from_le_bytes([zip_bytes[cursor + 10], zip_bytes[cursor + 11]]);
        let comp_size = u32::from_le_bytes([
            zip_bytes[cursor + 20],
            zip_bytes[cursor + 21],
            zip_bytes[cursor + 22],
            zip_bytes[cursor + 23],
        ]) as usize;
        let uncomp_size = u32::from_le_bytes([
            zip_bytes[cursor + 24],
            zip_bytes[cursor + 25],
            zip_bytes[cursor + 26],
            zip_bytes[cursor + 27],
        ]) as usize;
        let name_len =
            u16::from_le_bytes([zip_bytes[cursor + 28], zip_bytes[cursor + 29]]) as usize;
        let extra_len =
            u16::from_le_bytes([zip_bytes[cursor + 30], zip_bytes[cursor + 31]]) as usize;
        let comment_len =
            u16::from_le_bytes([zip_bytes[cursor + 32], zip_bytes[cursor + 33]]) as usize;
        let lh_offset = u32::from_le_bytes([
            zip_bytes[cursor + 42],
            zip_bytes[cursor + 43],
            zip_bytes[cursor + 44],
            zip_bytes[cursor + 45],
        ]) as usize;

        let name_start = cursor + 46;
        let name_end = name_start + name_len;
        if name_end > zip_bytes.len() {
            break;
        }
        let name = String::from_utf8_lossy(&zip_bytes[name_start..name_end]).to_string();

        // Calculate actual data start from Local Header
        if lh_offset + 30 <= zip_bytes.len()
            && &zip_bytes[lh_offset..lh_offset + 4] == b"PK\x03\x04"
        {
            let lh_name_len =
                u16::from_le_bytes([zip_bytes[lh_offset + 26], zip_bytes[lh_offset + 27]]) as usize;
            let lh_extra_len =
                u16::from_le_bytes([zip_bytes[lh_offset + 28], zip_bytes[lh_offset + 29]]) as usize;
            let data_start = lh_offset + 30 + lh_name_len + lh_extra_len;

            if data_start + comp_size <= zip_bytes.len() {
                entries.push(ZipEntryMeta {
                    name,
                    compression_method: method,
                    compressed_size: comp_size,
                    uncompressed_size: uncomp_size,
                    data_start,
                });
            }
        }

        cursor = cursor + 46 + name_len + extra_len + comment_len;
    }

    Ok(entries)
}

/// Decompress or slice a single ZIP entry.
/// Handles Method 0 (Stored), Method 8 (Deflated), and nested GZIP.
pub fn extract_zip_entry<'a>(
    zip_bytes: &'a [u8],
    entry: &ZipEntryMeta,
) -> Result<Cow<'a, [u8]>, String> {
    let raw_slice = &zip_bytes[entry.data_start..entry.data_start + entry.compressed_size];

    let decompressed = match entry.compression_method {
        0 => {
            // Stored: uncompressed
            if raw_slice.len() >= 2 && raw_slice[0] == 0x1f && raw_slice[1] == 0x8b {
                // Nested GZIP
                let mut out = Vec::new();
                decompress_gzip(raw_slice, &mut out)?;
                Cow::Owned(out)
            } else {
                Cow::Borrowed(raw_slice)
            }
        }
        8 => {
            // Raw Deflate (RFC 1951). libdeflate is measurably faster than the
            // pure-Rust decoder on log data (~1.3x: 268MB pm2 237->172ms, 458MB
            // mongo 265->203ms). Its buffer has to be initialized, but a zeroed
            // Vec of this size costs ~0ms: Windows hands out lazily-zeroed pages
            // that the decoder faults in as it writes, like the previous
            // MaybeUninit path did.
            let mut out = vec![0u8; entry.uncompressed_size];
            let mut decompressor = libdeflater::Decompressor::new();
            match decompressor.deflate_decompress(raw_slice, &mut out) {
                Ok(len) if len == entry.uncompressed_size => {}
                Ok(len) => {
                    return Err(format!(
                        "Deflate decompression size mismatch for '{}': {len} != {}",
                        entry.name, entry.uncompressed_size
                    ));
                }
                Err(err) => {
                    return Err(format!(
                        "Deflate decompression failed for '{}': {err:?}",
                        entry.name
                    ));
                }
            }

            // Check if decompressed bytes have nested GZIP header
            if out.len() >= 2 && out[0] == 0x1f && out[1] == 0x8b {
                let mut nested_out = Vec::new();
                decompress_gzip(&out, &mut nested_out)?;
                Cow::Owned(nested_out)
            } else {
                Cow::Owned(out)
            }
        }
        other => {
            return Err(format!(
                "Unsupported ZIP compression method {} for '{}'",
                other, entry.name
            ));
        }
    };

    Ok(decompressed)
}

/// Decompress GZIP byte stream into output buffer.
pub fn decompress_gzip(gz_bytes: &[u8], output: &mut Vec<u8>) -> Result<(), String> {
    if gz_bytes.len() < 10 {
        return Err("GZIP buffer too small".into());
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
                    return Err("Decompressed GZIP size exceeds 2GB limit".into());
                }
            }
            err => {
                return Err(format!("GZIP decompression failed: {:?}", err));
            }
        }
    }

    Err("GZIP decompression buffer exceeded retry limit".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gzip_roundtrip() {
        let gz_bytes = [
            0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0xcb, 0x48, 0xcd, 0xc9,
            0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0xe1, 0x02, 0x00, 0x2d, 0x3b, 0x08, 0xaf,
            0x0c, 0x00, 0x00, 0x00,
        ];
        let mut out = Vec::new();
        decompress_gzip(&gz_bytes, &mut out).expect("gzip decompression");
        assert_eq!(&out, b"hello world\n");
    }

    #[test]
    fn test_deflate_entry() {
        let raw_deflate = [
            0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0xe1, 0x02, 0x00,
        ];
        let mut out = vec![0; 12];
        let config = zlib_rs::InflateConfig { window_bits: -15 };
        let (slice, _rc) = zlib_rs::decompress_slice(&mut out, &raw_deflate, config);
        assert_eq!(slice, b"hello world\n");
    }
}
