use serde::Serialize;
use sevenz_rust2::{Archive, Password};
use std::io::{self, Cursor, Read, Seek, SeekFrom};
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
struct SevenBlock {
    start: u64,
    size: u64,
    unpacked: u64,
    dictionary: u32,
    crc: Option<u32>,
}

#[derive(Serialize)]
struct SevenFile {
    name: String,
    size: u64,
    block: Option<usize>,
    crc: Option<u32>,
    directory: bool,
}

#[derive(Serialize)]
struct SevenIndex {
    blocks: Vec<SevenBlock>,
    files: Vec<SevenFile>,
}

// Header parsing only needs the signature and the small header at the archive tail.
// Reads outside those ranges cause the caller to use the general archive decoder.
struct HeaderReader<'a> {
    signature: &'a [u8],
    tail: &'a [u8],
    tail_offset: u64,
    length: u64,
    position: u64,
}

impl Read for HeaderReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let bytes = if self.position < self.signature.len() as u64 {
            &self.signature[self.position as usize..]
        } else if self.position >= self.tail_offset && self.position <= self.length {
            self.tail
                .get((self.position - self.tail_offset) as usize..)
                .ok_or(io::ErrorKind::UnexpectedEof)?
        } else {
            return Err(io::ErrorKind::UnexpectedEof.into());
        };
        let count = bytes.len().min(output.len());
        output[..count].copy_from_slice(&bytes[..count]);
        self.position += count as u64;
        Ok(count)
    }
}

impl Seek for HeaderReader<'_> {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let position = match from {
            SeekFrom::Start(value) => Some(value),
            SeekFrom::End(value) => self.length.checked_add_signed(value),
            SeekFrom::Current(value) => self.position.checked_add_signed(value),
        }
        .filter(|position| *position <= self.length)
        .ok_or(io::ErrorKind::InvalidInput)?;
        self.position = position;
        Ok(position)
    }
}

fn read_index(signature: &[u8], tail: &[u8], tail_offset: u64, length: u64) -> Option<SevenIndex> {
    let signature: &[u8; 32] = signature.try_into().ok()?;
    let header_offset = u64::from_le_bytes(signature[12..20].try_into().ok()?);
    let header_size = u64::from_le_bytes(signature[20..28].try_into().ok()?);
    let header_start = 32u64.checked_add(header_offset)?;
    // The upstream parser allocates the declared header before reading it. Bound that
    // allocation to the small tail actually supplied, even for a malformed archive.
    if header_size > 256 * 1024
        || header_start < tail_offset
        || header_start.checked_add(header_size)? > length
        || tail_offset.checked_add(tail.len() as u64)? != length
    {
        return None;
    }
    let mut reader = HeaderReader {
        signature,
        tail,
        tail_offset,
        length,
        position: 0,
    };
    let archive = Archive::read(&mut reader, &Password::empty()).ok()?;
    let first = archive.stream_map.block_first_pack_stream_index();
    let offsets = archive.stream_map.pack_stream_offsets();
    let sizes = archive.pack_sizes();
    let mut blocks = Vec::with_capacity(archive.blocks.len());
    for (index, block) in archive.blocks.iter().enumerate() {
        let [coder] = block.coders.as_slice() else {
            return None;
        };
        let [property] = coder.properties() else {
            return None;
        };
        // Only plain LZMA2, one packed stream and at most a 64 MiB dictionary.
        if coder.encoder_method_id() != [0x21] || *property > 30 {
            return None;
        }
        let pack_index = *first.get(index)?;
        if first.get(index + 1).copied().unwrap_or(sizes.len()) != pack_index + 1 {
            return None;
        }
        let start = 32u64
            .checked_add(archive.pack_pos())?
            .checked_add(*offsets.get(pack_index)?)?;
        let size = *sizes.get(pack_index)?;
        if start.checked_add(size)? > length {
            return None;
        }
        blocks.push(SevenBlock {
            start,
            size,
            unpacked: block.get_unpack_size(),
            dictionary: (2 | (u32::from(*property) & 1)) << (u32::from(*property) / 2 + 11),
            crc: block.has_crc.then_some(block.crc as u32),
        });
    }
    let files = archive
        .files
        .iter()
        .enumerate()
        .map(|(index, file)| SevenFile {
            name: file.name.clone(),
            size: file.size,
            block: archive.stream_map.file_block_index[index],
            crc: file.has_crc.then_some(file.crc as u32),
            directory: file.is_directory || file.is_anti_item || !file.has_stream,
        })
        .collect();
    Some(SevenIndex { blocks, files })
}

/// Returns a metadata-only LZMA2 plan, or undefined when the general decoder is required.
#[wasm_bindgen]
pub fn inspect_sevenz(
    signature: &[u8],
    tail: &[u8],
    tail_offset: f64,
    length: f64,
) -> Option<String> {
    let index = read_index(signature, tail, tail_offset as u64, length as u64)?;
    serde_json::to_string(&index).ok()
}

pub(crate) fn decode_segment(
    input: &[u8],
    dictionary: u32,
    length: usize,
    output: &mut Vec<u8>,
) -> io::Result<()> {
    if dictionary > 64 * 1024 * 1024 || length > 32 * 1024 * 1024 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let input = Cursor::new(input).chain(Cursor::new([0]));
    let mut decoder = lzma_rust2::Lzma2Reader::new(input, dictionary, None);
    output.clear();
    output.reserve_exact(length);
    unsafe { output.set_len(length) };
    decoder.read_exact(output)?;
    if decoder.read(&mut [0])? != 0 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(())
}

#[wasm_bindgen]
pub fn sevenz_crc_combine(left: u32, right: u32, right_length: u32) -> u32 {
    let mut hasher = crc32fast::Hasher::new_with_initial(left);
    hasher.combine(&crc32fast::Hasher::new_with_initial_len(
        right,
        u64::from(right_length),
    ));
    hasher.finalize()
}
