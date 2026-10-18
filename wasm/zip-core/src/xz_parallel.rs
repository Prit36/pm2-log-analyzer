use lzma_rust2::{Action, Status, XzStream};
use wasm_bindgen::prelude::*;

const MAX_BLOCK: u64 = 16 * 1024 * 1024;
const MAX_INDEX: u64 = 1024 * 1024;
const MAGIC: [u8; 6] = [253, 55, 122, 88, 90, 0];

#[derive(Debug, serde::Serialize)]
struct Block {
    start: u64,
    size: u64,
    unpadded: u64,
    uncompressed: u64,
}

#[derive(Debug, serde::Serialize)]
struct Plan {
    check: u8,
    blocks: Vec<Block>,
}

fn crc(bytes: &[u8]) -> Result<(), String> {
    let end = bytes.len() - 4;
    let expected = u32::from_le_bytes(bytes[end..].try_into().unwrap());
    if crc32fast::hash(&bytes[..end]) != expected {
        return Err("XZ CRC32 mismatch".into());
    }
    Ok(())
}

fn vli(bytes: &[u8], cursor: &mut usize) -> Result<u64, String> {
    let mut value = 0;
    for index in 0..9 {
        let byte = *bytes.get(*cursor).ok_or("Truncated XZ integer")?;
        *cursor += 1;
        value |= u64::from(byte & 127) << (index * 7);
        if byte & 128 == 0 {
            if index != 0 && byte == 0 {
                return Err("Non-canonical XZ integer".into());
            }
            return Ok(value);
        }
    }
    Err("XZ integer exceeds 63 bits".into())
}

fn check_size(check: u8) -> Option<u64> {
    match check {
        0 => Some(0),
        1 => Some(4),
        4 => Some(8),
        10 => Some(32),
        _ => None,
    }
}

// Only plain LZMA2 is accelerated. Other filter chains retain the streaming path.
fn block_header(bytes: &[u8], block: &Block, check: u8) -> Result<bool, String> {
    let length = (usize::from(bytes[0]) + 1) * 4;
    if bytes[0] == 0 || length > bytes.len() {
        return Err("Truncated XZ block header".into());
    }
    crc(&bytes[..length])?;
    let flags = bytes[1];
    if flags & 60 != 0 {
        return Err("Reserved XZ block flags".into());
    }
    let data = &bytes[..length - 4];
    let compressed = block
        .unpadded
        .checked_sub(length as u64 + check_size(check).unwrap())
        .filter(|value| *value != 0)
        .ok_or("Invalid XZ block size")?;
    let mut cursor = 2;
    if flags & 64 != 0 && vli(data, &mut cursor)? != compressed {
        return Err("XZ compressed size mismatch".into());
    }
    if flags & 128 != 0 && vli(data, &mut cursor)? != block.uncompressed {
        return Err("XZ uncompressed size mismatch".into());
    }
    if flags & 3 != 0 {
        return Ok(false);
    }
    if vli(data, &mut cursor)? != 33 {
        return Ok(false);
    }
    if vli(data, &mut cursor)? != 1 {
        return Err("Invalid XZ LZMA2 properties".into());
    }
    let property = *data.get(cursor).ok_or("Truncated XZ dictionary property")?;
    cursor += 1;
    if property > 40 {
        return Err("Invalid XZ dictionary size".into());
    }
    if data[cursor..].iter().any(|byte| *byte != 0) {
        return Err("Invalid XZ block header padding".into());
    }
    let dictionary = if property == 40 {
        u32::MAX
    } else {
        (2 | u32::from(property & 1)) << (property / 2 + 11)
    };
    Ok(u64::from(dictionary) <= MAX_BLOCK)
}

fn inspect(
    length: u64,
    mut read: impl FnMut(u64, &mut [u8]) -> Result<(), String>,
) -> Result<Option<Plan>, String> {
    if length < 32 || length % 4 != 0 {
        return Err("Truncated XZ stream".into());
    }
    let mut header = [0; 12];
    read(0, &mut header)?;
    if header[..6] != MAGIC {
        return Err("Invalid XZ stream header".into());
    }
    crc(&header[6..])?;
    if header[6] != 0 || header[7] & 240 != 0 {
        return Err("Reserved XZ stream flags".into());
    }
    let check = header[7];
    if check_size(check).is_none() {
        return Ok(None);
    }
    let mut footer = [0; 12];
    read(length - 12, &mut footer)?;
    // Stream padding and concatenated streams stay on the sequential decoder.
    if footer[10..] != *b"YZ" {
        return Ok(None);
    }
    if crc32fast::hash(&footer[4..10]) != u32::from_le_bytes(footer[..4].try_into().unwrap()) {
        return Err("XZ footer CRC32 mismatch".into());
    }
    if footer[8..10] != header[6..8] {
        return Ok(None);
    }
    let index_length = (u64::from(u32::from_le_bytes(footer[4..8].try_into().unwrap())) + 1) * 4;
    if index_length > length - 24 {
        return Err("XZ index outside stream".into());
    }
    if index_length > MAX_INDEX {
        return Ok(None);
    }
    let index_start = length - 12 - index_length;
    let mut index = vec![0; index_length as usize];
    read(index_start, &mut index)?;
    crc(&index)?;
    let data = &index[..index.len() - 4];
    if data.first() != Some(&0) {
        return Err("Invalid XZ index indicator".into());
    }
    let mut cursor = 1;
    let count = vli(data, &mut cursor)?;
    if count > 65_536 {
        return Ok(None);
    }
    let mut blocks = Vec::with_capacity(count as usize);
    let mut start = 12u64;
    let mut total = 0u64;
    for _ in 0..count {
        let unpadded = vli(data, &mut cursor)?;
        let uncompressed = vli(data, &mut cursor)?;
        if unpadded < 9 + check_size(check).unwrap() {
            return Err("Invalid XZ index block size".into());
        }
        let size = unpadded.checked_add(3).ok_or("XZ block size overflow")? & !3;
        let end = start.checked_add(size).ok_or("XZ block offset overflow")?;
        if end > index_start {
            return Err("XZ block outside stream".into());
        }
        total = total
            .checked_add(uncompressed)
            .filter(|value| *value < (1 << 63))
            .ok_or("XZ output size overflow")?;
        blocks.push(Block {
            start,
            size,
            unpadded,
            uncompressed,
        });
        start = end;
    }
    if data.len() - cursor > 3 || data[cursor..].iter().any(|byte| *byte != 0) {
        return Err("Invalid XZ index padding".into());
    }
    if start != index_start {
        return Ok(None);
    }
    if blocks
        .iter()
        .any(|block| block.size > MAX_BLOCK || block.uncompressed > MAX_BLOCK)
    {
        return Ok(None);
    }
    let mut bytes = [0; 1024];
    for block in &blocks {
        let count = bytes.len().min(block.size as usize);
        read(block.start, &mut bytes[..count])?;
        if !block_header(&bytes[..count], block, check)? {
            return Ok(None);
        }
    }
    Ok(Some(Plan { check, blocks }))
}

#[wasm_bindgen]
pub fn inspect_xz_blob(length: f64, read: js_sys::Function) -> Result<Option<String>, JsValue> {
    if !length.is_finite()
        || length < 0.0
        || length.fract() != 0.0
        || length > 9_007_199_254_740_991.0
    {
        return Err(JsValue::from_str("Invalid XZ input length"));
    }
    inspect(length as u64, |offset, bytes| {
        read.call3(
            &JsValue::NULL,
            &JsValue::from_f64(offset as f64),
            &JsValue::from_f64(bytes.as_mut_ptr() as usize as f64),
            &JsValue::from_f64(bytes.len() as f64),
        )
        .map(|_| ())
        .map_err(|error| {
            error
                .as_string()
                .unwrap_or_else(|| "XZ input read failed".into())
        })
    })
    .and_then(|plan| {
        plan.map(|value| serde_json::to_string(&value))
            .transpose()
            .map_err(|error| error.to_string())
    })
    .map_err(|error| JsValue::from_str(&error))
}

fn put_vli(mut value: u64, bytes: &mut Vec<u8>) {
    while value >= 128 {
        bytes.push(value as u8 | 128);
        value >>= 7;
    }
    bytes.push(value as u8);
}

fn append_index_footer(bytes: &mut Vec<u8>, check: u8, records: &[(u64, u64)]) {
    let index_start = bytes.len();
    bytes.push(0);
    put_vli(records.len() as u64, bytes);
    for &(unpadded, uncompressed) in records {
        put_vli(unpadded, bytes);
        put_vli(uncompressed, bytes);
    }
    while (bytes.len() - index_start) % 4 != 0 {
        bytes.push(0);
    }
    let checksum = crc32fast::hash(&bytes[index_start..]);
    bytes.extend_from_slice(&checksum.to_le_bytes());
    let backward = ((bytes.len() - index_start) / 4 - 1) as u32;
    let mut footer = [0; 12];
    footer[4..8].copy_from_slice(&backward.to_le_bytes());
    footer[9] = check;
    footer[10..].copy_from_slice(b"YZ");
    let checksum = crc32fast::hash(&footer[4..10]);
    footer[..4].copy_from_slice(&checksum.to_le_bytes());
    bytes.extend_from_slice(&footer);
}

#[wasm_bindgen]
pub struct XzBlockDecoder {
    stream: Vec<u8>,
    output: Vec<u8>,
}

impl XzBlockDecoder {
    fn run(&mut self, input: &[u8], check: u8, unpadded: u32, size: u32) -> Result<(), String> {
        let block = Block {
            start: 12,
            size: input.len() as u64,
            unpadded: unpadded.into(),
            uncompressed: size.into(),
        };
        if check_size(check).is_none()
            || block.size > MAX_BLOCK
            || block.uncompressed > MAX_BLOCK
            || (block.unpadded + 3) & !3 != block.size
            || input.len() < 8
        {
            return Err("Invalid XZ decode block size".into());
        }
        if !block_header(input, &block, check)? {
            return Err("Unsupported XZ block".into());
        }
        self.stream.clear();
        self.stream.extend_from_slice(&MAGIC);
        self.stream.extend_from_slice(&[0, check]);
        let checksum = crc32fast::hash(&self.stream[6..8]);
        self.stream.extend_from_slice(&checksum.to_le_bytes());
        self.stream.extend_from_slice(input);
        append_index_footer(&mut self.stream, check, &[(unpadded.into(), size.into())]);
        self.output.resize(size as usize + 1, 0);
        let mut decoder = XzStream::new_mem_limit(false, 18 * 1024);
        let mut consumed = 0;
        let mut written = 0;
        loop {
            let result = decoder
                .process(
                    &self.stream[consumed..],
                    &mut self.output[written..],
                    Action::Finish,
                )
                .map_err(|error| format!("XZ block: {error}"))?;
            consumed += result.bytes_consumed;
            written += result.bytes_produced;
            if written > size as usize {
                return Err("XZ block exceeds its indexed size".into());
            }
            if result.status == Status::StreamEnd {
                break;
            }
            if result.bytes_consumed == 0 && result.bytes_produced == 0 {
                return Err("Truncated XZ block".into());
            }
        }
        if written != size as usize || consumed != self.stream.len() {
            return Err("XZ block index size mismatch".into());
        }
        self.output.truncate(written);
        Ok(())
    }
}

#[wasm_bindgen]
impl XzBlockDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            stream: Vec::new(),
            output: Vec::new(),
        }
    }

    pub fn decode(
        &mut self,
        input: &[u8],
        check: u8,
        unpadded: u32,
        size: u32,
    ) -> Result<u32, JsValue> {
        self.run(input, check, unpadded, size)
            .map_err(|error| JsValue::from_str(&error))?;
        Ok(self.output.as_ptr() as u32)
    }
    pub fn output_len(&self) -> u32 {
        self.output.len() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIXTURE: &[u8] = &[
        253, 55, 122, 88, 90, 0, 0, 1, 105, 34, 222, 54, 2, 0, 33, 1, 22, 0, 0, 0, 116, 47, 229,
        163, 224, 4, 127, 0, 32, 93, 0, 56, 24, 74, 170, 156, 1, 195, 227, 2, 202, 160, 97, 218,
        153, 64, 84, 102, 212, 229, 250, 160, 143, 45, 102, 11, 137, 224, 169, 122, 228, 127, 0, 0,
        244, 40, 21, 146, 0, 1, 56, 128, 9, 0, 0, 0, 5, 174, 146, 231, 62, 48, 13, 139, 2, 0, 0, 0,
        0, 1, 89, 90,
    ];

    fn plan(bytes: &[u8]) -> Result<Option<Plan>, String> {
        inspect(bytes.len() as u64, |start, output| {
            let part = bytes
                .get(start as usize..start as usize + output.len())
                .ok_or("Truncated fixture")?;
            output.copy_from_slice(part);
            Ok(())
        })
    }

    #[test]
    fn independent_blocks_decode_in_order() {
        let first = plan(FIXTURE).unwrap().unwrap();
        let block = &first.blocks[0];
        let mut stream = FIXTURE[..12].to_vec();
        for _ in 0..2 {
            stream.extend_from_slice(&FIXTURE[12..12 + block.size as usize]);
        }
        append_index_footer(
            &mut stream,
            first.check,
            &[(block.unpadded, block.uncompressed); 2],
        );
        let indexed = plan(&stream).unwrap().unwrap();
        assert_eq!(indexed.blocks.len(), 2);
        let mut decoder = XzBlockDecoder::new();
        for block in indexed.blocks {
            decoder
                .run(
                    &stream[block.start as usize..(block.start + block.size) as usize],
                    indexed.check,
                    block.unpadded as u32,
                    block.uncompressed as u32,
                )
                .unwrap();
            assert_eq!(decoder.output, b"parallel xz block\n".repeat(64));
        }
    }

    #[test]
    fn rejects_header_index_footer_corruption_and_truncation() {
        for offset in [8, 20, 76, 80] {
            let mut damaged = FIXTURE.to_vec();
            damaged[offset] ^= 1;
            assert!(plan(&damaged).is_err(), "accepted damaged byte {offset}");
        }
        assert!(plan(&FIXTURE[..FIXTURE.len() - 1]).is_err());
        let mut cursor = 0;
        assert!(vli(&[128, 0], &mut cursor).is_err());
    }

    #[test]
    fn rejects_block_checksum_and_incorrect_index_sizes() {
        let indexed = plan(FIXTURE).unwrap().unwrap();
        let block = &indexed.blocks[0];
        let mut input = FIXTURE[12..12 + block.size as usize].to_vec();
        let last = input.len() - 1;
        input[last] ^= 1;
        let mut decoder = XzBlockDecoder::new();
        assert!(
            decoder
                .run(
                    &input,
                    indexed.check,
                    block.unpadded as u32,
                    block.uncompressed as u32
                )
                .is_err()
        );
        let input = &FIXTURE[12..12 + block.size as usize];
        assert!(
            decoder
                .run(
                    input,
                    indexed.check,
                    block.unpadded as u32,
                    block.uncompressed as u32 - 1
                )
                .is_err()
        );
        assert!(
            decoder
                .run(
                    input,
                    indexed.check,
                    block.unpadded as u32 - 1,
                    block.uncompressed as u32
                )
                .is_err()
        );
    }

    #[test]
    fn concatenated_streams_and_large_dictionaries_fall_back() {
        assert!(plan(&FIXTURE.repeat(2)).unwrap().is_none());
        let mut large = FIXTURE.to_vec();
        large[16] = 40;
        let checksum = crc32fast::hash(&large[12..20]);
        large[20..24].copy_from_slice(&checksum.to_le_bytes());
        assert!(plan(&large).unwrap().is_none());
    }
}
