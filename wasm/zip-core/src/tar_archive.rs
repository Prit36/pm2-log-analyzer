use std::io::{Cursor, Read};
use wasm_bindgen::prelude::*;

use super::classify_by_name;

fn is_tar_header_valid(header: &[u8]) -> bool {
    if header.len() < 512 {
        return false;
    }
    let checksum = header[148..156]
        .iter()
        .copied()
        .filter(|byte| *byte != 0 && *byte != b' ')
        .try_fold(0u32, |value, byte| {
            (b'0'..=b'7')
                .contains(&byte)
                .then(|| value * 8 + u32::from(byte - b'0'))
        });
    let Some(checksum) = checksum else {
        return false;
    };
    let unsigned_sum: u32 = header[..148]
        .iter()
        .chain(&header[156..512])
        .map(|byte| u32::from(*byte))
        .sum::<u32>()
        + 8 * u32::from(b' ');
    if checksum == unsigned_sum {
        return true;
    }
    let signed_sum: i32 = header[..148]
        .iter()
        .chain(&header[156..512])
        .map(|byte| i32::from(*byte as i8))
        .sum::<i32>()
        + 8 * i32::from(b' ');
    checksum == signed_sum as u32
}

fn extract_tar_reader(
    reader: impl Read,
    on_entry: &js_sys::Function,
    on_skipped: &js_sys::Function,
) -> Result<u64, JsValue> {
    let mut archive = tar::Archive::new(reader);
    let mut total_bytes = 0u64;
    let mut has_entries = false;

    let entries = archive.entries().map_err(|e| JsValue::from_str(&e.to_string()))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| JsValue::from_str(&e.to_string()))?;
        has_entries = true;
        let path = entry
            .path()
            .map_err(|e| JsValue::from_str(&e.to_string()))?
            .to_string_lossy()
            .into_owned();

        let raw_name = path.replace('\\', "/");
        let name = raw_name.rsplit('/').next().unwrap_or(&raw_name).to_string();

        let entry_type = entry.header().entry_type();
        if entry_type.is_pax_global_extensions()
            || entry_type.is_pax_local_extensions()
            || entry_type.is_gnu_longname()
            || entry_type.is_gnu_longlink()
        {
            continue;
        }

        if !entry_type.is_file() {
            on_skipped.call1(&JsValue::NULL, &JsValue::from_str(&path))?;
            continue;
        }

        let cat = classify_by_name(&name).unwrap_or("unknown");
        if cat == "skip" || path.starts_with("__MACOSX/") {
            on_skipped.call1(&JsValue::NULL, &JsValue::from_str(&path))?;
            continue;
        }

        let size = entry.size();
        if size > 0x7fffffff {
            return Err(JsValue::from_str(&format!(
                "Archive entry exceeds the browser size limit: {path}"
            )));
        }

        if size == 0 {
            on_skipped.call1(&JsValue::NULL, &JsValue::from_str(&path))?;
            continue;
        }

        let usize_len = size as usize;
        let mut data = Vec::new();
        data.try_reserve_exact(usize_len)
            .map_err(|e| JsValue::from_str(&format!("OOM allocating entry {path}: {e}")))?;
        unsafe { data.set_len(usize_len) };
        entry
            .read_exact(&mut data)
            .map_err(|e| JsValue::from_str(&format!("Incomplete TAR entry {path}: {e}")))?;

        let uint8 = js_sys::Uint8Array::from(data.as_slice());
        drop(data); // Free Rust linear memory immediately

        total_bytes += size;
        on_entry.call2(&JsValue::NULL, &JsValue::from_str(&path), &uint8)?;
    }

    if !has_entries {
        return Err(JsValue::from_str("Invalid or empty TAR archive"));
    }

    // Drain remainder of the compression stream to verify trailer and checksums
    let mut sink = std::io::sink();
    std::io::copy(&mut archive.into_inner(), &mut sink)
        .map_err(|e| JsValue::from_str(&format!("TAR trailer verification failed: {e}")))?;

    Ok(total_bytes)
}

#[wasm_bindgen]
pub fn extract_tar_wasm(
    data: &[u8],
    on_entry: &js_sys::Function,
    on_skipped: &js_sys::Function,
) -> Result<f64, JsValue> {
    if data.starts_with(b"\x1f\x8b") {
        let reader = flate2::read::MultiGzDecoder::new(data);
        return extract_tar_reader(reader, on_entry, on_skipped).map(|b| b as f64);
    }
    if data.starts_with(b"BZh") {
        let reader = bzip2::read::BzDecoder::new(data);
        return extract_tar_reader(reader, on_entry, on_skipped).map(|b| b as f64);
    }
    if data.starts_with(b"\xfd7zXZ\0") {
        let reader = lzma_rust2::XzReader::new(data, true);
        return extract_tar_reader(reader, on_entry, on_skipped).map(|b| b as f64);
    }
    if is_tar_header_valid(data) || data.len() >= 512 {
        let reader = Cursor::new(data);
        return extract_tar_reader(reader, on_entry, on_skipped).map(|b| b as f64);
    }
    Err(JsValue::from_str("Unsupported archive format for TAR decoder"))
}
