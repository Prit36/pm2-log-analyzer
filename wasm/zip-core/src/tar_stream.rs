use std::io::{self, Cursor, Read};
use wasm_bindgen::prelude::*;

const BLOCK: usize = 512;
const METADATA_LIMIT: usize = 1024 * 1024;

pub(crate) trait TarOutput {
    fn begin(&mut self, path: &str, size: u64) -> io::Result<()>;
    fn chunk(&mut self, bytes: &[u8]) -> io::Result<()>;
    fn commit(&mut self) -> io::Result<()>;
    fn skipped(&mut self, path: &str) -> io::Result<()>;
}

#[derive(Clone, Copy)]
enum State {
    Header,
    Metadata {
        remaining: usize,
        start: usize,
        size: usize,
        pax: bool,
        retain: bool,
    },
    Data {
        remaining: u64,
        padding: usize,
        emit: bool,
    },
    SparseExtensions {
        size: u64,
        padding: usize,
    },
    Padding(usize),
    End,
}

pub(crate) struct TarConsumer {
    state: State,
    header: [u8; BLOCK],
    header_len: usize,
    metadata: Vec<u8>,
    has_entries: bool,
    total: u64,
}

impl TarConsumer {
    pub(crate) fn new() -> Self {
        Self {
            state: State::Header,
            header: [0; BLOCK],
            header_len: 0,
            metadata: Vec::new(),
            has_entries: false,
            total: 0,
        }
    }

    fn header(&mut self, output: &mut impl TarOutput) -> io::Result<State> {
        if self.header.iter().all(|byte| *byte == 0) {
            if !self.metadata.is_empty() {
                return Err(invalid("TAR metadata has no following entry"));
            }
            return Ok(State::End);
        }
        let header = tar::Header::from_byte_slice(&self.header);
        let checksum = self.header[..148]
            .iter()
            .chain(&self.header[156..])
            .map(|byte| u32::from(*byte))
            .sum::<u32>()
            + 8 * 32;
        if header.cksum()? != checksum {
            return Err(invalid("TAR header checksum mismatch"));
        }
        let kind = header.entry_type();
        let sparse = if kind.is_gnu_sparse() {
            Some((
                header.entry_size()?,
                header
                    .as_gnu()
                    .ok_or_else(|| invalid("Sparse TAR entry has no GNU header"))?
                    .is_extended(),
            ))
        } else {
            None
        };
        if kind.is_gnu_longname()
            || kind.is_gnu_longlink()
            || kind.is_pax_local_extensions()
            || kind.is_pax_global_extensions()
        {
            let size = usize::try_from(header.entry_size()?)
                .map_err(|_| invalid("TAR metadata exceeds the size limit"))?;
            let padded = size
                .checked_add(BLOCK - 1)
                .map(|size| size & !(BLOCK - 1))
                .ok_or_else(|| invalid("TAR metadata size overflow"))?;
            if self.metadata.len() + BLOCK > METADATA_LIMIT
                || padded > METADATA_LIMIT - self.metadata.len() - BLOCK
            {
                return Err(invalid("TAR metadata exceeds the size limit"));
            }
            let retain = !kind.is_pax_global_extensions()
                && (header.as_gnu().is_some() || header.as_ustar().is_some());
            self.metadata.extend_from_slice(&self.header);
            let start = self.metadata.len();
            return Ok(State::Metadata {
                remaining: padded,
                start,
                size,
                pax: kind.is_pax_local_extensions() || kind.is_pax_global_extensions(),
                retain,
            });
        }

        // Let tar resolve GNU long names, USTAR prefixes, base256 and PAX overrides.
        // The current file payload is not read or retained in this temporary archive.
        let (path, size, is_file) = {
            // Sparse entries are skipped. Resolve their metadata without asking tar to
            // read the extension map or reconstruct their much larger logical content.
            let mut ordinary = tar::Header::new_old();
            ordinary.as_mut_bytes().copy_from_slice(&self.header);
            if sparse.is_some() {
                ordinary.set_entry_type(tar::EntryType::Regular);
                ordinary.set_cksum();
            }
            let source =
                Cursor::new(self.metadata.as_slice()).chain(Cursor::new(&ordinary.as_bytes()[..]));
            let mut archive = tar::Archive::new(source);
            let mut entries = archive.entries()?;
            let entry = entries
                .next()
                .ok_or_else(|| invalid("TAR metadata has no following entry"))??;
            (
                entry.path()?.to_string_lossy().into_owned(),
                entry.size(),
                entry.header().entry_type().is_file() && sparse.is_none(),
            )
        };
        self.metadata.clear();
        if sparse.is_none() && size > 0x7fffffff {
            return Err(invalid(&format!(
                "Archive entry exceeds the browser size limit: {path}"
            )));
        }
        self.has_entries = true;
        let emit = is_file
            && size != 0
            && !path.starts_with("__MACOSX/")
            && super::classify_by_name(&path) != Some("skip");
        if emit {
            output.begin(&path, size)?;
            self.total += size;
        } else {
            output.skipped(&path)?;
        }
        let size = sparse.map_or(size, |(physical, _)| physical);
        let padding = ((BLOCK as u64 - size % BLOCK as u64) % BLOCK as u64) as usize;
        if sparse.is_some_and(|(_, extended)| extended) {
            return Ok(State::SparseExtensions { size, padding });
        }
        Ok(State::Data {
            remaining: size,
            padding,
            emit,
        })
    }

    pub(crate) fn feed(&mut self, mut input: &[u8], output: &mut impl TarOutput) -> io::Result<()> {
        loop {
            match self.state {
                State::Header => {
                    if input.is_empty() {
                        return Ok(());
                    }
                    let count = input.len().min(BLOCK - self.header_len);
                    self.header[self.header_len..self.header_len + count]
                        .copy_from_slice(&input[..count]);
                    self.header_len += count;
                    input = &input[count..];
                    if self.header_len == BLOCK {
                        self.header_len = 0;
                        self.state = self.header(output)?;
                    }
                }
                State::Metadata {
                    remaining,
                    start,
                    size,
                    pax,
                    retain,
                } => {
                    let count = input.len().min(remaining);
                    self.metadata.extend_from_slice(&input[..count]);
                    input = &input[count..];
                    if count == remaining {
                        if pax {
                            validate_pax(&self.metadata[start..start + size])?;
                        }
                        if !retain {
                            self.metadata.clear();
                        }
                        self.state = State::Header;
                    } else {
                        self.state = State::Metadata {
                            remaining: remaining - count,
                            start,
                            size,
                            pax,
                            retain,
                        };
                        return Ok(());
                    }
                }
                State::Data {
                    remaining,
                    padding,
                    emit,
                } => {
                    let count = (input.len() as u64).min(remaining) as usize;
                    if emit && count != 0 {
                        output.chunk(&input[..count])?;
                    }
                    input = &input[count..];
                    if count as u64 == remaining {
                        if emit {
                            output.commit()?;
                        }
                        self.state = State::Padding(padding);
                    } else {
                        self.state = State::Data {
                            remaining: remaining - count as u64,
                            padding,
                            emit,
                        };
                        return Ok(());
                    }
                }
                State::SparseExtensions { size, padding } => {
                    if input.is_empty() {
                        return Ok(());
                    }
                    let count = input.len().min(BLOCK - self.header_len);
                    self.header[self.header_len..self.header_len + count]
                        .copy_from_slice(&input[..count]);
                    self.header_len += count;
                    input = &input[count..];
                    if self.header_len == BLOCK {
                        self.header_len = 0;
                        if self.header[504] == 0 {
                            self.state = State::Data {
                                remaining: size,
                                padding,
                                emit: false,
                            };
                        }
                    }
                }
                State::Padding(remaining) => {
                    let count = input.len().min(remaining);
                    input = &input[count..];
                    if count == remaining {
                        self.state = State::Header;
                    } else {
                        self.state = State::Padding(remaining - count);
                        return Ok(());
                    }
                }
                // The caller continues decoding to validate the compression trailer.
                State::End => return Ok(()),
            }
        }
    }

    pub(crate) fn finish(&self) -> io::Result<u64> {
        if !self.has_entries {
            return Err(invalid("Invalid or empty TAR archive"));
        }
        match self.state {
            State::End => Ok(self.total),
            State::Header if self.header_len == 0 && self.metadata.is_empty() => Ok(self.total),
            _ => Err(invalid("Truncated TAR archive entry, header or metadata")),
        }
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

fn validate_pax(bytes: &[u8]) -> io::Result<()> {
    if !bytes.is_empty() && bytes.last() != Some(&b'\n') {
        return Err(invalid("Malformed TAR PAX metadata"));
    }
    for extension in tar::PaxExtensions::new(bytes) {
        let extension = extension?;
        if extension.key_bytes() == b"size" {
            extension
                .value()
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| invalid("Invalid TAR PAX size"))?;
        }
    }
    Ok(())
}

struct JsOutput {
    begin: js_sys::Function,
    chunk: js_sys::Function,
    commit: js_sys::Function,
    skipped: js_sys::Function,
}

fn callback_error(value: JsValue) -> io::Error {
    io::Error::other(
        value
            .as_string()
            .unwrap_or_else(|| "Archive output callback failed".into()),
    )
}

impl TarOutput for JsOutput {
    fn begin(&mut self, path: &str, size: u64) -> io::Result<()> {
        self.begin
            .call2(
                &JsValue::NULL,
                &path.into(),
                &JsValue::from_f64(size as f64),
            )
            .map_err(callback_error)?;
        Ok(())
    }

    fn chunk(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.chunk
            .call2(
                &JsValue::NULL,
                &JsValue::from_f64(bytes.as_ptr() as usize as f64),
                &JsValue::from_f64(bytes.len() as f64),
            )
            .map_err(callback_error)?;
        Ok(())
    }

    fn commit(&mut self) -> io::Result<()> {
        self.commit.call0(&JsValue::NULL).map_err(callback_error)?;
        Ok(())
    }

    fn skipped(&mut self, path: &str) -> io::Result<()> {
        self.skipped
            .call1(&JsValue::NULL, &path.into())
            .map_err(callback_error)?;
        Ok(())
    }
}

#[wasm_bindgen]
pub struct TarStream {
    consumer: TarConsumer,
    output: JsOutput,
}

#[wasm_bindgen]
impl TarStream {
    #[wasm_bindgen(constructor)]
    pub fn new(
        begin: js_sys::Function,
        chunk: js_sys::Function,
        commit: js_sys::Function,
        skipped: js_sys::Function,
    ) -> Self {
        Self {
            consumer: TarConsumer::new(),
            output: JsOutput {
                begin,
                chunk,
                commit,
                skipped,
            },
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        self.consumer
            .feed(bytes, &mut self.output)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn finish(&self) -> Result<f64, JsValue> {
        self.consumer
            .finish()
            .map(|total| total as f64)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default, Debug, PartialEq)]
    struct Collected {
        entries: Vec<(String, Vec<u8>)>,
        skipped: Vec<String>,
        pending: Option<(String, u64, Vec<u8>)>,
    }

    impl TarOutput for Collected {
        fn begin(&mut self, path: &str, size: u64) -> io::Result<()> {
            assert!(self.pending.is_none());
            self.pending = Some((path.to_owned(), size, Vec::new()));
            Ok(())
        }

        fn chunk(&mut self, bytes: &[u8]) -> io::Result<()> {
            self.pending.as_mut().unwrap().2.extend_from_slice(bytes);
            Ok(())
        }

        fn commit(&mut self) -> io::Result<()> {
            let (path, size, bytes) = self.pending.take().unwrap();
            assert_eq!(size, bytes.len() as u64);
            self.entries.push((path, bytes));
            Ok(())
        }

        fn skipped(&mut self, path: &str) -> io::Result<()> {
            self.skipped.push(path.to_owned());
            Ok(())
        }
    }

    fn reference(bytes: &[u8]) -> Collected {
        let mut output = Collected::default();
        super::super::tar_archive::visit_tar(bytes, |path, size, is_file, reader| {
            if !is_file
                || size == 0
                || path.starts_with("__MACOSX/")
                || super::super::classify_by_name(path) == Some("skip")
            {
                output.skipped(path)?;
            } else {
                output.begin(path, size)?;
                let mut bytes = Vec::new();
                reader.read_to_end(&mut bytes)?;
                output.chunk(&bytes)?;
                output.commit()?;
            }
            Ok(())
        })
        .unwrap();
        output
    }

    fn consume(bytes: &[u8], chunk_size: usize) -> io::Result<Collected> {
        let mut consumer = TarConsumer::new();
        let mut output = Collected::default();
        for chunk in bytes.chunks(chunk_size) {
            consumer.feed(chunk, &mut output)?;
            assert!(consumer.metadata.len() <= METADATA_LIMIT);
        }
        let total = consumer.finish()?;
        assert_eq!(
            total,
            output
                .entries
                .iter()
                .map(|(_, bytes)| bytes.len() as u64)
                .sum::<u64>()
        );
        Ok(output)
    }

    #[test]
    fn fixtures_match_tar_reader_at_fragmented_boundaries() {
        for bytes in [
            include_bytes!("../../../tests/fixtures/archives/logs.tar").as_slice(),
            include_bytes!("../../../tests/fixtures/archives/metadata.tar").as_slice(),
        ] {
            let expected = reference(bytes);
            for chunk_size in [1, 3, 17, 511, 512, 513, 1023, 1024, 1025, 4096] {
                assert_eq!(consume(bytes, chunk_size).unwrap(), expected);
            }
            for split in 0..=bytes.len() {
                let mut consumer = TarConsumer::new();
                let mut output = Collected::default();
                consumer.feed(&bytes[..split], &mut output).unwrap();
                consumer.feed(&bytes[split..], &mut output).unwrap();
                consumer.finish().unwrap();
                assert_eq!(output, expected, "split at {split}");
            }
        }
    }

    #[test]
    fn reject_truncated_payload_header_and_metadata() {
        let bytes = include_bytes!("../../../tests/fixtures/archives/logs.tar");
        for length in [1, 511, 512, 513, 512 + 63, 1024 + 1] {
            assert!(consume(&bytes[..length], 7).is_err(), "length {length}");
        }
        let metadata = include_bytes!("../../../tests/fixtures/archives/metadata.tar");
        for length in [512, 513, 1023, 1024] {
            assert!(consume(&metadata[..length], 7).is_err(), "length {length}");
        }
    }

    fn single_entry(path: &str, size: u64, kind: tar::EntryType) -> [u8; BLOCK] {
        let mut header = tar::Header::new_gnu();
        header.set_path(path).unwrap();
        header.set_size(size);
        header.set_mode(0o644);
        header.set_entry_type(kind);
        header.set_cksum();
        *header.as_bytes()
    }

    #[test]
    fn reject_bad_checksum_oversized_entry_and_metadata() {
        let mut bad = single_entry("api-out.log", 3, tar::EntryType::Regular);
        bad[0] ^= 1;
        assert!(consume(&bad, 1).is_err());
        let oversized = single_entry("api-out.log", 0x80000000, tar::EntryType::Regular);
        assert!(consume(&oversized, BLOCK).is_err());
        let metadata = single_entry(
            "././@LongLink",
            METADATA_LIMIT as u64,
            tar::EntryType::GNULongName,
        );
        assert!(consume(&metadata, BLOCK).is_err());
    }

    #[test]
    fn malformed_pax_and_missing_following_entry_are_rejected() {
        for payload in [b"99 path=a\n".as_slice(), b"13 size=nope\n", b"10 path=a"] {
            let mut bytes = single_entry(
                "PaxHeaders/log",
                payload.len() as u64,
                tar::EntryType::XHeader,
            )
            .to_vec();
            bytes.extend_from_slice(payload);
            bytes.resize(2 * BLOCK, 0);
            bytes.extend(single_entry("api-out.log", 3, tar::EntryType::Regular));
            bytes.extend_from_slice(b"abc");
            bytes.resize(5 * BLOCK, 0);
            assert!(consume(&bytes, 3).is_err());
        }
        let mut metadata = single_entry("././@LongLink", 4, tar::EntryType::GNULongName).to_vec();
        metadata.extend_from_slice(b"log\0");
        metadata.resize(3 * BLOCK, 0);
        assert!(consume(&metadata, 13).is_err());
    }

    #[test]
    fn payload_streams_before_entry_finishes_and_skipped_payload_is_checked() {
        let mut consumer = TarConsumer::new();
        let mut output = Collected::default();
        consumer
            .feed(
                &single_entry("api-out.log", 1000, tar::EntryType::Regular),
                &mut output,
            )
            .unwrap();
        consumer.feed(b"abc", &mut output).unwrap();
        assert_eq!(output.pending.as_ref().unwrap().2, b"abc");
        assert!(consumer.metadata.is_empty());
        assert!(consumer.finish().is_err());
        for path in ["api-error.log", ".hidden.log", "__MACOSX/log"] {
            let mut consumer = TarConsumer::new();
            let mut output = Collected::default();
            consumer
                .feed(
                    &single_entry(path, 1000, tar::EntryType::Regular),
                    &mut output,
                )
                .unwrap();
            consumer.feed(b"abc", &mut output).unwrap();
            assert_eq!(output.skipped, [path]);
            assert!(output.pending.is_none());
            assert!(consumer.finish().is_err());
        }
    }

    #[test]
    fn sparse_entries_skip_physical_bytes_and_extension_headers() {
        for extensions in [0, 1, 2] {
            let name = b"long/path/to/sparse-api-out.log\0";
            let mut bytes = single_entry(
                "././@LongLink",
                name.len() as u64,
                tar::EntryType::GNULongName,
            )
            .to_vec();
            bytes.extend_from_slice(name);
            bytes.resize(2 * BLOCK, 0);
            let mut header = tar::Header::new_gnu();
            header.set_path("sparse.log").unwrap();
            header.set_size(3);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::GNUSparse);
            let gnu = header.as_gnu_mut().unwrap();
            gnu.set_real_size(4099);
            gnu.set_is_extended(extensions != 0);
            if extensions == 0 {
                gnu.sparse[0].set_offset(4096);
                gnu.sparse[0].set_length(3);
            }
            header.set_cksum();
            bytes.extend_from_slice(header.as_bytes());
            for index in 0..extensions {
                let mut extension = tar::GnuExtSparseHeader::new();
                extension.set_is_extended(index + 1 < extensions);
                if index + 1 == extensions {
                    extension.sparse_mut()[0].set_offset(4096);
                    extension.sparse_mut()[0].set_length(3);
                }
                bytes.extend_from_slice(extension.as_bytes());
            }
            bytes.extend_from_slice(b"abc");
            bytes.resize(bytes.len() + BLOCK - 3, 0);
            bytes.extend(single_entry("api-out.log", 3, tar::EntryType::Regular));
            bytes.extend_from_slice(b"GET");
            bytes.resize(bytes.len() + 3 * BLOCK - 3, 0);
            let expected = reference(&bytes);
            assert_eq!(expected.skipped, ["long/path/to/sparse-api-out.log"]);
            assert_eq!(expected.entries, [("api-out.log".into(), b"GET".to_vec())]);
            for chunk_size in [1, 17, 511, 512, 513, 1024] {
                assert_eq!(consume(&bytes, chunk_size).unwrap(), expected);
            }
            if extensions != 0 {
                assert!(consume(&bytes[..3 * BLOCK + 511], 7).is_err());
            }
        }
    }
}
