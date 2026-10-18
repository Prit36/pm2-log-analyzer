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
