use std::borrow::Cow;
use std::io::{self, Cursor, Read, Write};

use crate::classifier::{self, LogCategory};

/// Owning the mmap lets RAR keep a seekable source without copying compressed bytes.
pub enum ArchiveSource {
    Mmap(memmap2::Mmap),
    Buffer(Vec<u8>),
}

impl AsRef<[u8]> for ArchiveSource {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Mmap(data) => data,
            Self::Buffer(data) => data,
        }
    }
}

pub fn is_archive_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        ".rar", ".7z", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz", ".tbz2", ".tar.xz", ".txz",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix))
}

pub fn is_archive_content(data: &[u8]) -> bool {
    data.starts_with(b"Rar!\x1a\x07")
        || data.starts_with(b"7z\xbc\xaf\x27\x1c")
        || data.starts_with(b"BZh")
        || data.starts_with(b"\xfd7zXZ\0")
        || is_tar_header(data)
}

fn is_tar_header(data: &[u8]) -> bool {
    let Some(header) = data.get(..512) else {
        return false;
    };
    let checksum = header[148..156]
        .iter()
        .copied()
        .filter(|byte| *byte != 0 && *byte != b' ')
        .try_fold(0u32, |value, byte| {
            (b'0'..=b'7')
                .contains(&byte)
                .then(|| value * 8 + u32::from(byte - b'0'))
        });
    let sum: u32 = header[..148]
        .iter()
        .chain(&header[156..])
        .map(|byte| u32::from(*byte))
        .sum::<u32>()
        + 8 * u32::from(b' ');
    checksum == Some(sum)
}

/// Entry streams stay on the decoder thread; RAR's `Read` adapter would spool the
/// whole entry, whereas `copy_to` sends decoded bytes directly to the consumer.
#[expect(
    clippy::large_enum_variant,
    reason = "entry handles are stack-local and immediately consumed; boxing every RAR entry adds an allocation"
)]
pub enum EntryData<'a> {
    Borrowed(&'a [u8]),
    Reader(&'a mut dyn Read),
    Rar(unrar_rs::Entry<'a>),
}

impl EntryData<'_> {
    pub fn copy_to(self, writer: &mut dyn Write) -> Result<u64, String> {
        match self {
            Self::Borrowed(bytes) => {
                writer.write_all(bytes).map_err(|error| error.to_string())?;
                Ok(bytes.len() as u64)
            }
            Self::Reader(reader) => {
                // Large decoder reads amortize codec dispatch/CRC work. The
                // generic std::io::copy path otherwise asks for only 8 KiB.
                let mut buffer = vec![0u8; 256 * 1024];
                let mut written = 0u64;
                loop {
                    let len = match reader.read(&mut buffer) {
                        Ok(0) => return Ok(written),
                        Ok(len) => len,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(error) => return Err(error.to_string()),
                    };
                    writer
                        .write_all(&buffer[..len])
                        .map_err(|error| error.to_string())?;
                    written += len as u64;
                }
            }
            Self::Rar(entry) => entry.copy_to(writer).map_err(|error| error.to_string()),
        }
    }
}

/// Visit files without materializing log entries. The consumer must drain each
/// stream before returning so solid dictionaries and checksums stay valid.
pub fn for_each_stream(
    name: &str,
    source: ArchiveSource,
    threads: usize,
    mut consume: impl FnMut(&str, Option<u64>, EntryData<'_>) -> Result<(), String>,
) -> Result<(), String> {
    let data = source.as_ref();
    if data.starts_with(b"Rar!\x1a\x07") {
        return visit_rar(source, consume);
    }
    if data.starts_with(b"7z\xbc\xaf\x27\x1c") {
        let mut archive = sevenz_rust2::ArchiveReader::new(Cursor::new(data), Default::default())
            .map_err(|error| error.to_string())?;
        archive.set_thread_count(threads as u32);
        return archive
            .for_each_entries(|entry, reader| {
                if entry.is_directory
                    || entry.is_anti_item
                    || !usable_entry(&entry.name, entry.size)
                {
                    std::io::copy(reader, &mut std::io::sink())?;
                    return Ok(true);
                }
                consume(&entry.name, Some(entry.size), EntryData::Reader(reader))
                    .map_err(std::io::Error::other)?;
                Ok(true)
            })
            .map_err(|error| error.to_string());
    }
    if data.starts_with(b"\x1f\x8b") {
        return visit_tar(flate2::read::MultiGzDecoder::new(data), consume);
    }
    if data.starts_with(b"BZh") {
        return visit_tar(
            pbz2::ParallelDecoder::with_threads(Cursor::new(source), threads),
            consume,
        );
    }
    if data.starts_with(b"\xfd7zXZ\0") {
        return visit_tar(
            MultiXzDecoder::new(data, threads).map_err(|error| error.to_string())?,
            consume,
        );
    }
    if is_tar_header(data) || name.to_ascii_lowercase().ends_with(".tar") {
        return visit_tar_slice(data, consume);
    }
    Err(format!("Invalid or unsupported archive: {name}"))
}

fn decoder_threads() -> usize {
    std::thread::available_parallelism().map_or(1, |count| count.get().min(8))
}

/// liblzma reduces concurrency when block buffers would exceed 64 MiB; large
/// dictionaries fall back to serial decoding within the separate hard limit.
struct MultiXzDecoder<'a> {
    reader: liblzma::bufread::XzDecoder<&'a [u8]>,
    threads: usize,
}

impl<'a> MultiXzDecoder<'a> {
    fn new(data: &'a [u8], threads: usize) -> io::Result<Self> {
        Ok(Self {
            reader: Self::stream(data, threads)?,
            threads,
        })
    }

    fn stream(data: &'a [u8], threads: usize) -> io::Result<liblzma::bufread::XzDecoder<&'a [u8]>> {
        let stream = liblzma::stream::MtStreamBuilder::new()
            .threads(threads as u32)
            .memlimit_threading(64 * 1024 * 1024)
            .memlimit_stop(1024 * 1024 * 1024)
            .decoder()?;
        Ok(liblzma::bufread::XzDecoder::new_stream(data, stream))
    }
}

impl Read for MultiXzDecoder<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        loop {
            let read = self.reader.read(output)?;
            if read != 0 {
                return Ok(read);
            }
            // BufRead consumes exactly liblzma's input, preserving the next
            // stream's header instead of losing it in an input read-ahead buffer.
            let remaining = *self.reader.get_ref();
            let padding = remaining.iter().take_while(|&&byte| byte == 0).count();
            if padding % 4 != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Invalid XZ stream padding",
                ));
            }
            let remaining = &remaining[padding..];
            if remaining.is_empty() {
                return Ok(0);
            }
            self.reader = Self::stream(remaining, self.threads)?;
        }
    }
}

/// Legacy expansion callers still need complete buffers. Native ingest instead
/// consumes `for_each_stream` through a bounded, recycled parser buffer pool.
pub fn for_each_entry(
    name: &str,
    source: ArchiveSource,
    mut consume: impl FnMut(&str, Cow<'_, [u8]>),
) -> Result<(), String> {
    for_each_stream(name, source, decoder_threads(), |entry_name, size, data| {
        if let EntryData::Borrowed(bytes) = data {
            consume(entry_name, Cow::Borrowed(bytes));
            return Ok(());
        }
        let mut output = entry_buffer(size.unwrap_or(0))?;
        let written = data.copy_to(&mut output)?;
        if size.is_some_and(|expected| expected != written) {
            return Err(format!("Incomplete archive entry: {entry_name}"));
        }
        consume(entry_name, Cow::Owned(output));
        Ok(())
    })
}

fn entry_buffer(size: u64) -> Result<Vec<u8>, String> {
    let capacity = usize::try_from(size).map_err(|error| error.to_string())?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(capacity)
        .map_err(|error| error.to_string())?;
    Ok(output)
}

fn usable_entry(name: &str, size: u64) -> bool {
    size > 0 && classifier::classify_name(name) != LogCategory::Skip
}

fn visit_tar_slice(
    data: &[u8],
    mut consume: impl FnMut(&str, Option<u64>, EntryData<'_>) -> Result<(), String>,
) -> Result<(), String> {
    let mut archive = tar::Archive::new(Cursor::new(data));
    for entry in archive
        .entries_with_seek()
        .map_err(|error| error.to_string())?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry
            .path()
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let start =
            usize::try_from(entry.raw_file_position()).map_err(|error| error.to_string())?;
        let size = usize::try_from(entry.size()).map_err(|error| error.to_string())?;
        let end = start.checked_add(size).ok_or("TAR entry size overflow")?;
        let bytes = data.get(start..end).ok_or("Truncated TAR entry")?;
        if !entry.header().entry_type().is_file() || !usable_entry(&name, entry.size()) {
            continue;
        }
        consume(&name, Some(entry.size()), EntryData::Borrowed(bytes))?;
    }
    Ok(())
}

fn visit_tar(
    reader: impl Read,
    mut consume: impl FnMut(&str, Option<u64>, EntryData<'_>) -> Result<(), String>,
) -> Result<(), String> {
    let mut archive = tar::Archive::new(reader);
    for entry in archive.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let name = entry
            .path()
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        if !entry.header().entry_type().is_file() || !usable_entry(&name, entry.size()) {
            continue;
        }
        consume(&name, Some(entry.size()), EntryData::Reader(&mut entry))?;
    }
    // Read the compression trailer too, so truncated streams and checksum errors surface.
    std::io::copy(&mut archive.into_inner(), &mut std::io::sink())
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn visit_rar(
    source: ArchiveSource,
    mut consume: impl FnMut(&str, Option<u64>, EntryData<'_>) -> Result<(), String>,
) -> Result<(), String> {
    let mut archive =
        unrar_rs::RarArchive::open(Cursor::new(source)).map_err(|error| error.to_string())?;
    let entries: Vec<_> = archive.entries().collect();
    if archive.more_volumes()
        || entries
            .iter()
            .any(|info| !archive.is_extractable(&info.raw_name))
    {
        return Err("Split RAR archives are not supported; use a single-volume archive".into());
    }
    for (index, info) in entries.into_iter().enumerate() {
        if info.is_encrypted {
            return Err("Password-protected RAR archives are not supported".into());
        }
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if info.is_directory
            || info.is_symlink
            || info.is_hardlink
            || !usable_entry(&info.name, info.unpacked_size.unwrap_or(1))
        {
            entry.skip().map_err(|error| error.to_string())?;
            continue;
        }
        consume(&info.name, info.unpacked_size, EntryData::Rar(entry))?;
    }
    Ok(())
}
