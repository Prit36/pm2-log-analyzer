use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::time::UNIX_EPOCH;
use unrar_rs::{DecodeMode, MemberInfo, RarArchive};
use wasm_bindgen::prelude::*;

struct BlobReader {
    read: js_sys::Function,
    position: u64,
    length: u64,
}

fn callback_error(value: JsValue) -> io::Error {
    io::Error::other(
        value
            .as_string()
            .unwrap_or_else(|| "RAR I/O callback failed".into()),
    )
}

impl Read for BlobReader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let count = self
            .length
            .saturating_sub(self.position)
            .min(output.len() as u64) as usize;
        if count == 0 {
            return Ok(0);
        }
        self.read
            .call3(
                &JsValue::NULL,
                &JsValue::from_f64(self.position as f64),
                &JsValue::from_f64(output.as_mut_ptr() as usize as f64),
                &JsValue::from_f64(count as f64),
            )
            .map_err(callback_error)?;
        self.position += count as u64;
        Ok(count)
    }
}

impl Seek for BlobReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let position = match from {
            SeekFrom::Start(value) => Some(value),
            SeekFrom::Current(value) => self.position.checked_add_signed(value),
            SeekFrom::End(value) => self.length.checked_add_signed(value),
        }
        .filter(|position| *position <= self.length)
        .ok_or(io::ErrorKind::InvalidInput)?;
        self.position = position;
        Ok(position)
    }
}

fn open(
    source: impl Read + Seek + Send + 'static,
) -> Result<(RarArchive, Vec<MemberInfo>), String> {
    let mut archive = RarArchive::open(source).map_err(|error| error.to_string())?;
    archive.set_decode_mode(DecodeMode::Serial);
    let entries: Vec<_> = archive.entries().collect();
    if archive.more_volumes()
        || entries
            .iter()
            .any(|entry| !archive.is_extractable(&entry.raw_name))
    {
        return Err("Split-volume RAR archives are not supported".into());
    }
    if entries.iter().any(|entry| entry.is_encrypted) {
        return Err("Password-protected archives are not supported".into());
    }
    if entries.iter().any(|entry| entry.unpacked_size.is_none()) {
        return Err("Incomplete RAR archive entry size".into());
    }
    Ok((archive, entries))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry<'a> {
    name: &'a str,
    size: u64,
    directory: bool,
    modified_ms: Option<f64>,
}

struct Output<'a> {
    callback: &'a js_sys::Function,
    written: u64,
    size: u64,
}

impl Write for Output<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.size - self.written {
            return Err(io::Error::other("RAR entry exceeds its declared size"));
        }
        self.callback
            .call2(
                &JsValue::NULL,
                &JsValue::from_f64(bytes.as_ptr() as usize as f64),
                &JsValue::from_f64(bytes.len() as f64),
            )
            .map_err(callback_error)?;
        self.written += bytes.len() as u64;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[wasm_bindgen]
pub struct RarExtractor {
    archive: RarArchive,
    entries: Vec<MemberInfo>,
}

#[wasm_bindgen]
impl RarExtractor {
    #[wasm_bindgen(constructor)]
    pub fn new(length: f64, read: js_sys::Function) -> Result<RarExtractor, JsValue> {
        let source = BufReader::with_capacity(
            8 * 1024 * 1024,
            BlobReader {
                read,
                position: 0,
                length: length as u64,
            },
        );
        let (archive, entries) = open(source).map_err(|error| JsValue::from_str(&error))?;
        Ok(Self { archive, entries })
    }

    pub fn manifest(&self) -> Result<String, JsValue> {
        let entries: Vec<_> = self
            .entries
            .iter()
            .map(|entry| ManifestEntry {
                name: &entry.name,
                size: entry.unpacked_size.unwrap(),
                directory: entry.is_directory
                    || entry.is_symlink
                    || entry.is_hardlink
                    || entry.is_file_copy,
                modified_ms: entry
                    .mtime
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as f64),
            })
            .collect();
        serde_json::to_string(&entries).map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn skip(&mut self, index: usize) -> Result<(), JsValue> {
        self.archive
            .by_index(index)
            .and_then(|entry| entry.skip())
            .map(|_| ())
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn extract(&mut self, index: usize, callback: &js_sys::Function) -> Result<f64, JsValue> {
        let info = self
            .entries
            .get(index)
            .ok_or_else(|| JsValue::from_str("Invalid RAR entry index"))?;
        let size = info.unpacked_size.unwrap();
        if size > 0x7fffffff {
            return Err(JsValue::from_str(
                "RAR entry exceeds the browser size limit",
            ));
        }
        let mut output = Output {
            callback,
            written: 0,
            size,
        };
        self.archive
            .by_index(index)
            .and_then(|entry| entry.copy_to(&mut output))
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        if output.written != size {
            return Err(JsValue::from_str("Incomplete RAR entry"));
        }
        Ok(size as f64)
    }
}
