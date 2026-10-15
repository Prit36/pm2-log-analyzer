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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn independent_uncompressed_segments_and_checksums() {
        let mut output = Vec::new();
        decode_segment(&[1, 0, 2, b'a', b'b', b'c'], 4096, 3, &mut output).unwrap();
        assert_eq!(output, b"abc");
        let first = crc32fast::hash(&output);
        decode_segment(&[1, 0, 1, b'd', b'e'], 4096, 2, &mut output).unwrap();
        assert_eq!(
            sevenz_crc_combine(first, crc32fast::hash(&output), 2),
            crc32fast::hash(b"abcde")
        );
        assert_eq!(sevenz_crc_combine(0, first, 3), first);
    }

    #[test]
    fn reject_dependent_truncated_and_mismatched_segments() {
        let mut output = Vec::new();
        assert!(decode_segment(&[2, 0, 0, b'a'], 4096, 1, &mut output).is_err());
        assert!(decode_segment(&[1, 0, 2, b'a'], 4096, 3, &mut output).is_err());
        assert!(decode_segment(&[1, 0, 0, b'a'], 4096, 2, &mut output).is_err());
        assert!(decode_segment(&[1, 0, 1, b'a', b'b'], 4096, 1, &mut output).is_err());
    }

    #[test]
    fn compressed_reset_ranges_reuse_output_and_crc_across_file_boundaries() {
        let compressed = [
            224, 164, 15, 0, 93, 93, 0, 61, 136, 137, 167, 115, 176, 183, 70, 116, 198, 98, 139,
            110, 211, 214, 200, 203, 247, 141, 216, 233, 36, 85, 238, 175, 229, 202, 19, 48, 58,
            87, 116, 28, 170, 193, 154, 162, 83, 188, 168, 133, 111, 111, 196, 139, 236, 79, 140,
            47, 144, 82, 54, 8, 177, 237, 19, 226, 115, 214, 18, 141, 245, 247, 213, 115, 159, 17,
            137, 7, 196, 172, 68, 176, 165, 184, 201, 118, 102, 86, 103, 172, 82, 176, 181, 182,
            148, 251, 206, 99, 99, 40, 97, 0,
        ];
        let expected = b"{\"msg\":\"Slow query\"}\n".repeat(2000);
        let mut output = Vec::new();
        decode_segment(&compressed, 4096, expected.len(), &mut output).unwrap();
        assert_eq!(output, expected);
        let boundary = 12345;
        assert_eq!(
            sevenz_crc_combine(
                crc32fast::hash(&output[..boundary]),
                crc32fast::hash(&output[boundary..]),
                (output.len() - boundary) as u32
            ),
            crc32fast::hash(&expected)
        );
        decode_segment(&compressed, 4096, expected.len(), &mut output).unwrap();
        assert_eq!(output, expected);
        assert!(
            decode_segment(
                &compressed[..compressed.len() - 4],
                4096,
                expected.len(),
                &mut output
            )
            .is_err()
        );
    }

    fn metadata_fixture() -> ([u8; 32], [u8; 90]) {
        let signature = [
            55, 122, 188, 175, 39, 28, 0, 4, 125, 153, 155, 182, 202, 1, 0, 0, 0, 0, 0, 0, 90, 0,
            0, 0, 0, 0, 0, 0, 218, 149, 202, 44,
        ];
        let tail = [
            1, 4, 6, 0, 1, 9, 129, 202, 0, 7, 11, 1, 0, 1, 33, 33, 1, 0, 12, 130, 203, 0, 8, 10, 1,
            187, 26, 132, 120, 0, 0, 5, 1, 25, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 17, 19, 0, 108, 0,
            111, 0, 103, 0, 115, 0, 46, 0, 122, 0, 105, 0, 112, 0, 0, 0, 25, 0, 20, 10, 1, 0, 66,
            95, 5, 202, 249, 91, 221, 1, 21, 6, 1, 0, 32, 0, 0, 0, 0, 0,
        ];
        (signature, tail)
    }

    fn update_header_crc(signature: &mut [u8; 32], header: &[u8]) {
        signature[28..32].copy_from_slice(&crc32fast::hash(header).to_le_bytes());
        let start_crc = crc32fast::hash(&signature[12..32]);
        signature[8..12].copy_from_slice(&start_crc.to_le_bytes());
    }

    #[test]
    fn metadata_reader_uses_small_tail_and_rejects_missing_header() {
        let (signature, tail) = metadata_fixture();
        let index = read_index(&signature, &tail, 490, 580).unwrap();
        assert_eq!(index.files[0].name, "logs.zip");
        assert_eq!(index.blocks[0].start, 32);
        assert_eq!(index.blocks[0].dictionary, 4096);
        assert!(read_index(&signature, &[], 580, 580).is_none());
        let mut corrupt = signature;
        corrupt[12] ^= 1;
        assert!(read_index(&corrupt, &tail, 490, 580).is_none());
    }

    #[test]
    fn metadata_rejects_oversized_dictionaries_and_unsupported_coder_shapes() {
        let (signature, tail) = metadata_fixture();
        for dictionary in [31, 40, 255] {
            let mut signature = signature;
            let mut header = tail;
            header[17] = dictionary;
            update_header_crc(&mut signature, &header);
            assert!(read_index(&signature, &header, 490, 580).is_none());
        }
        let mut changed_method = tail;
        changed_method[15] = 3;
        let mut signature = signature;
        update_header_crc(&mut signature, &changed_method);
        assert!(read_index(&signature, &changed_method, 490, 580).is_none());

        let mut extra_property = tail.to_vec();
        extra_property[16] = 2;
        extra_property.insert(18, 0);
        signature[20..28].copy_from_slice(&(extra_property.len() as u64).to_le_bytes());
        update_header_crc(&mut signature, &extra_property);
        assert!(read_index(&signature, &extra_property, 490, 581).is_none());
    }

    #[test]
    fn metadata_preflight_rejects_large_missing_and_overflowing_header_ranges() {
        let (mut signature, tail) = metadata_fixture();
        assert!(read_index(&signature[..31], &tail, 490, 580).is_none());
        assert!(read_index(&signature, &tail[..89], 490, 580).is_none());
        signature[12..20].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(read_index(&signature, &tail, 490, 580).is_none());
        signature[12..20].copy_from_slice(&0u64.to_le_bytes());
        signature[20..28].copy_from_slice(&(256 * 1024 + 1u64).to_le_bytes());
        let oversized_tail = vec![0; 256 * 1024 + 1];
        assert!(
            read_index(
                &signature,
                &oversized_tail,
                32,
                32 + oversized_tail.len() as u64
            )
            .is_none()
        );
    }
}
