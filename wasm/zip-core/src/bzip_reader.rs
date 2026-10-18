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
