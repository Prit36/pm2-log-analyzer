use pbz2_core::{Level, MarkerKind, Scanner, decode_block_into, decode_scratch_words, native};
use wasm_bindgen::prelude::*;

#[derive(serde::Serialize)]
struct Marker {
    bit: u64,
    end: bool,
}

#[wasm_bindgen]
pub struct BzipScanner {
    scanner: Scanner,
    markers: Vec<Marker>,
}

#[wasm_bindgen]
impl BzipScanner {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            scanner: Scanner::new(),
            markers: Vec::new(),
        }
    }

    pub fn scan(&mut self, bytes: &[u8]) {
        self.scanner.scan(native(), bytes, |marker| {
            self.markers.push(Marker {
                bit: marker.bit,
                end: marker.kind == MarkerKind::End,
            })
        });
    }

    pub fn markers(&self) -> String {
        serde_json::to_string(&self.markers).unwrap()
    }
}

fn decode(
    input: &[u8],
    start: u64,
    scratch: &mut [u32],
    output: &mut Vec<u8>,
) -> Result<(u32, u64, u32), pbz2_core::Error> {
    let mut block = decode_block_into(
        native(),
        input,
        start,
        input.len() as u64 * 8,
        Level::BEST,
        scratch,
    )?;
    output.clear();
    loop {
        let start = output.len();
        output.resize(start + 1024 * 1024, 0);
        let count = block.read(scratch, &mut output[start..]);
        output.truncate(start + count);
        if block.is_finished() {
            break;
        }
    }
    Ok((block.finish()?, block.end_bit(), block.block_length()))
}

#[wasm_bindgen]
pub struct BzipBlockDecoder {
    scratch: Vec<u32>,
    output: Vec<u8>,
    crc: u32,
    end: u64,
    length: u32,
}

#[wasm_bindgen]
impl BzipBlockDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            scratch: vec![0; decode_scratch_words(Level::BEST)],
            output: Vec::new(),
            crc: 0,
            end: 0,
            length: 0,
        }
    }

    pub fn decode(&mut self, input: &[u8], start_bit: u32) -> Result<u32, JsValue> {
        let (crc, end, length) =
            decode(input, start_bit.into(), &mut self.scratch, &mut self.output)
                .map_err(|error| JsValue::from_str(&format!("Bzip2 block: {error:?}")))?;
        self.crc = crc;
        self.end = end;
        self.length = length;
        Ok(self.output.as_ptr() as u32)
    }
    pub fn output_len(&self) -> u32 {
        self.output.len() as u32
    }
    pub fn crc(&self) -> u32 {
        self.crc
    }
    pub fn end_bit(&self) -> f64 {
        self.end as f64
    }
    pub fn block_length(&self) -> u32 {
        self.length
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn independent_blocks_preserve_crc_and_run_expansion() {
        let expected = vec![b'x'; 2_000_000];
        let mut encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
        encoder.write_all(&expected).unwrap();
        let compressed = encoder.finish().unwrap();
        let mut markers = Vec::new();
        let mut scanner = Scanner::new();
        for part in compressed.chunks(7) {
            scanner.scan(native(), part, |marker| markers.push(marker));
        }
        let mut scratch = vec![0; decode_scratch_words(Level::BEST)];
        let mut output = Vec::new();
        let mut all = Vec::new();
        let mut checker = pbz2_core::StreamChecker::new();
        checker.start(&compressed, markers[0].bit).unwrap();
        for (index, marker) in markers.iter().enumerate() {
            let end = markers
                .get(index + 1)
                .map_or(compressed.len() as u64 * 8, |next| next.bit);
            if marker.kind == MarkerKind::End {
                checker.end(&compressed, marker.bit, end).unwrap();
            } else {
                let (crc, actual_end, length) =
                    decode(&compressed, marker.bit, &mut scratch, &mut output).unwrap();
                assert_eq!(actual_end, end);
                assert!(length <= 100_000);
                let mut block = decode_block_into(
                    native(),
                    &compressed,
                    marker.bit,
                    end,
                    Level::BEST,
                    &mut scratch,
                )
                .unwrap();
                let mut bytes = vec![0; output.len()];
                assert_eq!(block.read(&scratch, &mut bytes), bytes.len());
                assert_eq!(block.finish().unwrap(), crc);
                checker.block(&block, end).unwrap();
                all.extend_from_slice(&output);
            }
        }
        checker.finish().unwrap();
        assert_eq!(all, expected);
    }
}
