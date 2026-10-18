use std::io::{self, BufReader, Read, Seek, SeekFrom};
use wasm_bindgen::prelude::*;

const WINDOW: usize = 1024 * 1024;

struct BlobReader {
    position: u64,
    length: u64,
    read: js_sys::Function,
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
            .map_err(js_error)?;
        self.position += count as u64;
        Ok(count)
    }
}

impl Seek for BlobReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let position = match from {
            SeekFrom::Start(value) => Some(value),
            SeekFrom::End(value) => self.length.checked_add_signed(value),
            SeekFrom::Current(value) => self.position.checked_add_signed(value),
        }
        .filter(|value| *value <= self.length)
        .ok_or(io::ErrorKind::InvalidInput)?;
        self.position = position;
        Ok(position)
    }
}

fn js_error(value: JsValue) -> io::Error {
    io::Error::other(
        value
            .as_string()
            .unwrap_or_else(|| "Archive I/O callback failed".into()),
    )
}

#[wasm_bindgen]
pub fn inspect_tar_blob(length: f64, read: js_sys::Function) -> Result<String, JsValue> {
    let source = BufReader::with_capacity(
        4096,
        BlobReader {
            position: 0,
            length: length as u64,
            read,
        },
    );
    let result = super::tar_archive::inspect_tar(source, length as u64)
        .and_then(|entries| serde_json::to_string(&entries).map_err(io::Error::other));
    result.map_err(|e| JsValue::from_str(&e.to_string()))
}

struct Output<'a> {
    begin: &'a js_sys::Function,
    chunk: &'a js_sys::Function,
    commit: &'a js_sys::Function,
    skipped: &'a js_sys::Function,
    scratch: Vec<u8>,
    written: u64,
    total: u64,
}

impl Output<'_> {
    fn start(&mut self, name: &str, size: u64) -> io::Result<()> {
        if size > 0x7fffffff {
            return Err(io::Error::other(format!(
                "Archive entry exceeds the browser size limit: {name}"
            )));
        }
        self.written = 0;
        self.begin
            .call2(
                &JsValue::NULL,
                &name.into(),
                &JsValue::from_f64(size as f64),
            )
            .map_err(js_error)?;
        Ok(())
    }

    fn finish(&mut self, size: u64) -> io::Result<()> {
        if self.written != size {
            return Err(io::Error::other("Incomplete archive entry"));
        }
        self.commit.call0(&JsValue::NULL).map_err(js_error)?;
        self.total += size;
        Ok(())
    }

    fn skip(&self, name: &str) -> io::Result<()> {
        self.skipped
            .call1(&JsValue::NULL, &name.into())
            .map_err(js_error)?;
        Ok(())
    }

    fn entry(
        &mut self,
        name: &str,
        size: u64,
        is_file: bool,
        reader: &mut dyn Read,
    ) -> io::Result<()> {
        if !is_file || size == 0 || should_skip(name) {
            self.skip(name)?;
            // Solid 7z entries must be consumed even when their output is skipped.
            loop {
                if reader.read(&mut self.scratch)? == 0 {
                    return Ok(());
                }
            }
        }
        self.start(name, size)?;
        loop {
            let count = reader.read(&mut self.scratch)?;
            if count == 0 {
                break;
            }
            self.chunk
                .call2(
                    &JsValue::NULL,
                    &JsValue::from_f64(self.scratch.as_ptr() as usize as f64),
                    &JsValue::from_f64(count as f64),
                )
                .map_err(js_error)?;
            self.written += count as u64;
        }
        self.finish(size)
    }
}

fn should_skip(name: &str) -> bool {
    name.starts_with("__MACOSX/") || super::classify_by_name(name) == Some("skip")
}

#[derive(serde::Serialize)]
struct ManifestEntry<'a> {
    name: &'a str,
    size: u64,
    directory: bool,
}

fn manifest(entries: &[ManifestEntry<'_>], callback: &js_sys::Function) -> io::Result<()> {
    let json = serde_json::to_string(entries)?;
    callback
        .call1(&JsValue::NULL, &json.into())
        .map_err(js_error)?;
    Ok(())
}

fn extract(
    length: u64,
    format: &str,
    read: js_sys::Function,
    output: &mut Output<'_>,
    on_manifest: &js_sys::Function,
) -> Result<(), String> {
    let source = BufReader::with_capacity(
        WINDOW,
        BlobReader {
            position: 0,
            length,
            read,
        },
    );
    if format == "7z" {
        let mut archive = sevenz_rust2::ArchiveReader::new(source, Default::default())
            .map_err(|e| e.to_string())?;
        manifest(
            &archive
                .archive()
                .files
                .iter()
                .map(|entry| ManifestEntry {
                    name: &entry.name,
                    size: entry.size,
                    directory: entry.is_directory || entry.is_anti_item,
                })
                .collect::<Vec<_>>(),
            on_manifest,
        )
        .map_err(|e| e.to_string())?;
        archive
            .for_each_entries(|entry, reader| {
                output.entry(
                    &entry.name,
                    entry.size,
                    !entry.is_directory && !entry.is_anti_item,
                    reader,
                )?;
                Ok(true)
            })
            .map_err(|e| e.to_string())?;
    } else {
        let reader: Box<dyn Read> = match format {
            "gz" => Box::new(flate2::read::MultiGzDecoder::new(source)),
            "bz2" => Box::new(super::bzip_reader::BzipReader::new(source)),
            "xz" => Box::new(lzma_rust2::XzReader::new(source, true)),
            _ => Box::new(source),
        };
        super::tar_archive::visit_tar(reader, |name, size, is_file, reader| {
            output.entry(name, size, is_file, reader)
        })
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[wasm_bindgen]
pub fn extract_archive_stream(
    length: f64,
    format: &str,
    read: js_sys::Function,
    begin: &js_sys::Function,
    chunk: &js_sys::Function,
    commit: &js_sys::Function,
    skipped: &js_sys::Function,
    on_manifest: &js_sys::Function,
) -> Result<f64, JsValue> {
    let mut output = Output {
        begin,
        chunk,
        commit,
        skipped,
        scratch: vec![0; WINDOW],
        written: 0,
        total: 0,
    };
    let result = extract(length as u64, format, read, &mut output, on_manifest);
    result
        .map(|()| output.total as f64)
        .map_err(|e| JsValue::from_str(&e))
}
