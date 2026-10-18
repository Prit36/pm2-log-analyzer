use std::io::{self, Read};

use pbz2_core::{Decoder, Level, MAX_COMPRESSED_BLOCK_BYTES, Pulled, decode_scratch_words};

const READ_BYTES: usize = 64 * 1024;

pub(crate) struct BzipReader<R> {
    input: R,
    decoder: Decoder<Vec<u8>, Vec<u32>>,
}

impl<R: Read> BzipReader<R> {
    pub(crate) fn new(input: R) -> Self {
        Self {
            input,
            decoder: Decoder::new(
                vec![0; MAX_COMPRESSED_BLOCK_BYTES],
                vec![0; decode_scratch_words(Level::BEST)],
            ),
        }
    }
}

impl<R: Read> Read for BzipReader<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        loop {
            match self.decoder.pull(output) {
                Ok(Pulled::Bytes(0)) => {}
                Ok(Pulled::Bytes(count)) => return Ok(count),
                Ok(Pulled::Finished) => return Ok(0),
                Ok(Pulled::NeedInput) => {
                    let spare = self.decoder.spare_input();
                    let length = spare.len().min(READ_BYTES);
                    let count = loop {
                        match self.input.read(&mut spare[..length]) {
                            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                            result => break result?,
                        }
                    };
                    if count == 0 {
                        self.decoder.end_input();
                    } else {
                        self.decoder.commit_input(count);
                    }
                }
                Err(error) => return Err(io::Error::new(io::ErrorKind::InvalidData, error)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    fn compress(input: &[u8]) -> Vec<u8> {
        let mut encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
        encoder.write_all(input).unwrap();
        encoder.finish().unwrap()
    }

    fn decode(input: &[u8]) -> io::Result<Vec<u8>> {
        let mut output = Vec::new();
        BzipReader::new(Cursor::new(input)).read_to_end(&mut output)?;
        Ok(output)
    }

    struct Fragmented<R> {
        input: R,
        interrupt: bool,
    }

    impl<R: Read> Read for Fragmented<R> {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            if self.interrupt {
                self.interrupt = false;
                return Err(io::ErrorKind::Interrupted.into());
            }
            let length = output.len().min(17);
            self.input.read(&mut output[..length])
        }
    }

    #[test]
    fn roundtrip_empty_and_multiple_blocks_with_fragmented_input() {
        for original in [
            Vec::new(),
            b"small log\n".to_vec(),
            b"GET /users 200 1ms\n".repeat(70_000),
        ] {
            let packed = compress(&original);
            let mut reader = BzipReader::new(Fragmented {
                input: Cursor::new(packed),
                interrupt: true,
            });
            assert_eq!(reader.read(&mut []).unwrap(), 0);
            let mut output = Vec::new();
            reader.read_to_end(&mut output).unwrap();
            assert_eq!(output, original);
            assert_eq!(reader.read(&mut [0]).unwrap(), 0);
        }
    }

    #[test]
    fn concatenated_streams_include_empty_members() {
        let mut packed = compress(b"first\n");
        packed.extend(compress(b""));
        packed.extend(compress(b"second\n"));
        assert_eq!(decode(&packed).unwrap(), b"first\nsecond\n");
    }

    #[test]
    fn reject_truncated_input_and_corrupt_block_or_stream_checksum() {
        let packed = compress(&b"GET /users 200 1ms\n".repeat(10_000));
        for length in [0, 3, packed.len() / 2, packed.len() - 1] {
            assert!(decode(&packed[..length]).is_err(), "truncated at {length}");
        }
        for offset in [10, packed.len() - 2] {
            let mut corrupt = packed.clone();
            corrupt[offset] ^= 1;
            let error = decode(&corrupt).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        }
        let mut truncated_second = compress(b"first\n");
        truncated_second.extend_from_slice(&packed[..packed.len() - 1]);
        assert!(decode(&truncated_second).is_err());
    }

    #[test]
    fn long_runs_stream_into_small_output_buffers() {
        let original = vec![b'a'; 2_000_000];
        let packed = compress(&original);
        let mut reader = BzipReader::new(Cursor::new(packed));
        let mut chunk = [0; 97];
        let mut bytes = 0;
        loop {
            let count = reader.read(&mut chunk).unwrap();
            if count == 0 {
                break;
            }
            assert!(chunk[..count].iter().all(|byte| *byte == b'a'));
            bytes += count;
        }
        assert_eq!(bytes, original.len());
    }
}
