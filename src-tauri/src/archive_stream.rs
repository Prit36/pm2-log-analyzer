use std::io::{self, Write};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};

use super::*;

const CHUNK_SIZE: usize = 16 * 1024 * 1024;
const BUFFER_COUNT: usize = 3;
const SNIFF_SIZE: usize = 4096;

enum Job {
    Pm2(Vec<u8>),
    Nginx(Vec<u8>),
    Mongo(Receiver<Vec<u8>>, Option<u64>),
    Nested(String, String, Vec<u8>),
}

/// Decode independently of Rayon: a candidate may already occupy a pool worker,
/// and nested/batch imports must never wait for another Rayon decoder to start.
pub(super) fn pipeline(
    name: &str,
    path: &str,
    source: extended_archive::ArchiveSource,
    depth: usize,
    options: &Pm2ShardOptions,
    progress: &SharedProgress<'_>,
    cpus: usize,
) -> IngestPipelineOutcome {
    std::thread::scope(|scope| {
        let (jobs_tx, jobs_rx) = sync_channel(BUFFER_COUNT);
        let (free_tx, free_rx) = sync_channel(BUFFER_COUNT);
        for _ in 0..BUFFER_COUNT {
            free_tx.send(Vec::with_capacity(CHUNK_SIZE)).unwrap();
        }
        let producer = std::thread::Builder::new()
            .name("archive-decode".into())
            .stack_size(16 * 1024 * 1024)
            .spawn_scoped(scope, move || {
                let mut files = Vec::new();
                extended_archive::for_each_stream(
                    name,
                    source,
                    cpus.min(8).div_ceil(progress.archive_count).max(1),
                    |entry_name, size, data| {
                        let entry_path = format!("{path}/{entry_name}");
                        let mut sink = EntrySink::new(
                            entry_name,
                            &entry_path,
                            size,
                            &jobs_tx,
                            &free_rx,
                            progress,
                        );
                        let written = data.copy_to(&mut sink)?;
                        if size.is_some_and(|expected| expected != written) {
                            return Err(format!("Incomplete archive entry: {entry_name}"));
                        }
                        if let Some(file) = sink.finish()? {
                            files.push(file);
                        }
                        Ok(())
                    },
                )?;
                Ok::<_, String>(files)
            });
        let producer = match producer {
            Ok(producer) => producer,
            Err(error) => return failed(path, error.to_string()),
        };

        let outcomes: Vec<_> = jobs_rx
            .into_iter()
            .par_bridge()
            .map(|job| match job {
                Job::Nginx(mut bytes) => {
                    let mut outcome = IngestPipelineOutcome::default();
                    if !bytes.is_empty() && !progress.nginx.is_some_and(|context| !context.current()) {
                        let mut engine = nginx_core::Engine::new();
                        engine.feed_slice(&bytes);
                        engine.end_source();
                        outcome.nginx_shards.push(engine);
                    }
                    bytes.clear();
                    if bytes.capacity() > CHUNK_SIZE {
                        bytes = Vec::with_capacity(CHUNK_SIZE);
                    }
                    let _ = free_tx.send(bytes);
                    outcome
                }
                Job::Pm2(mut bytes) => {
                    let mut outcome = IngestPipelineOutcome::default();
                    if bytes.is_empty() {
                        // An exact chunk boundary can leave the producer holding
                        // an empty recycled buffer at the end of an entry.
                    } else {
                        let mut engine = pm2_core::Pm2Engine::new();
                        let len = bytes.len() as f64;
                        engine.parse_shard(&bytes, 0.0, len, len);
                        outcome.pm2_partials.push(engine.reaggregate_decoded(
                            options.mode,
                            options.status,
                            options.min_ms,
                            options.date_filter.as_bytes(),
                            true,
                        ));
                        outcome.pm2_shards.push(engine);
                    }
                    bytes.clear();
                    if bytes.capacity() > CHUNK_SIZE {
                        bytes = Vec::with_capacity(CHUNK_SIZE);
                    }
                    // There are exactly BUFFER_COUNT buffers, so returning one
                    // cannot fill the pool while another is still outstanding.
                    let _ = free_tx.send(bytes);
                    outcome
                }
                Job::Nested(name, path, bytes) => pipeline_archive_bytes(
                    &name,
                    &path,
                    Cow::Owned(bytes),
                    depth + 1,
                    options,
                    progress,
                    cpus,
                ),
                Job::Mongo(chunks, size) => IngestPipelineOutcome {
                    mongo_shards: parse_mongo_stream(chunks, size, cpus, &free_tx),
                    ..IngestPipelineOutcome::default()
                },
            })
            .collect();
        let files = match producer.join() {
            Ok(Ok(files)) => files,
            Ok(Err(error)) => return failed(path, error),
            Err(_) => return failed(path, "Archive decoder thread failed".into()),
        };
        let mut outcome = IngestPipelineOutcome::default();
        for parsed in outcomes {
            outcome.merge(parsed);
        }
        outcome.files.extend(files);
        outcome
    })
}

/// Keep the original logical shard boundaries: a Mongo query-hash fingerprint
/// and connection metadata depend on earlier lines in that same shard. Physical
/// decoder buffers may be smaller, but must never reset those parser caches.
fn parse_mongo_stream(
    chunks: Receiver<Vec<u8>>,
    size: Option<u64>,
    cpus: usize,
    free: &SyncSender<Vec<u8>>,
) -> Vec<mongo_core::MongoEngine> {
    let plan = size
        .and_then(|size| usize::try_from(size).ok())
        .map(|size| mongo_shard_plan(size, cpus))
        .unwrap_or_else(|| vec![(0, usize::MAX)]);
    let mut shards = Vec::with_capacity(plan.len());
    let mut engine = mongo_core::MongoEngine::new();
    let mut shard_index = 0;
    let mut absolute = 0usize;
    let mut skip_partial = false;
    for mut bytes in chunks {
        let mut cursor = 0;
        while cursor < bytes.len() && shard_index < plan.len() {
            if skip_partial {
                let Some(newline) = bytes[cursor..].iter().position(|byte| *byte == b'\n') else {
                    break;
                };
                cursor += newline + 1;
                skip_partial = false;
                continue;
            }
            let boundary = plan[shard_index].1.saturating_sub(absolute);
            if boundary < cursor {
                engine.end_shard();
                shards.push(engine);
                engine = mongo_core::MongoEngine::new();
                shard_index += 1;
                continue;
            }
            if boundary > bytes.len() {
                engine.feed_slice(&bytes[cursor..]);
                break;
            }
            // The old slice parser assigns a straddling line to the preceding
            // shard and skips the first partial line of the following shard.
            let starts_line = boundary == cursor || boundary > 0 && bytes[boundary - 1] == b'\n';
            let end = if starts_line {
                boundary
            } else {
                bytes[boundary..]
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .map_or(bytes.len(), |newline| boundary + newline + 1)
            };
            engine.feed_slice(&bytes[cursor..end]);
            engine.end_shard();
            shards.push(engine);
            engine = mongo_core::MongoEngine::new();
            shard_index += 1;
            cursor = end;
            skip_partial = starts_line && shard_index < plan.len();
        }
        absolute += bytes.len();
        bytes.clear();
        if bytes.capacity() > CHUNK_SIZE {
            bytes = Vec::with_capacity(CHUNK_SIZE);
        }
        let _ = free.send(bytes);
    }
    engine.end_shard();
    if engine.total_lines() > 0 {
        shards.push(engine);
    }
    shards
}

fn failed(path: &str, error: String) -> IngestPipelineOutcome {
    IngestPipelineOutcome {
        archive_errors: vec![format!("Failed to read archive '{path}': {error}")],
        ..IngestPipelineOutcome::default()
    }
}

struct EntrySink<'a, 'p> {
    name: &'a str,
    path: &'a str,
    size: Option<u64>,
    jobs: &'a SyncSender<Job>,
    free: &'a Receiver<Vec<u8>>,
    progress: &'a SharedProgress<'p>,
    category: Option<LogCategory>,
    bytes: Vec<u8>,
    target: usize,
    written: u64,
    progress_bytes: u64,
    mongo_chunks: Option<SyncSender<Vec<u8>>>,
}

impl<'a, 'p> EntrySink<'a, 'p> {
    fn new(
        name: &'a str,
        path: &'a str,
        size: Option<u64>,
        jobs: &'a SyncSender<Job>,
        free: &'a Receiver<Vec<u8>>,
        progress: &'a SharedProgress<'p>,
    ) -> Self {
        Self {
            name,
            path,
            size,
            jobs,
            free,
            progress,
            category: None,
            bytes: Vec::with_capacity(SNIFF_SIZE),
            target: CHUNK_SIZE,
            written: 0,
            progress_bytes: 0,
            mongo_chunks: None,
        }
    }

    fn classify(&mut self) -> io::Result<()> {
        let category = classifier::classify_file_or_entry(self.name, &self.bytes);
        self.category = Some(category);
        if matches!(category, LogCategory::Pm2 | LogCategory::Mongo | LogCategory::Nginx) {
            if category == LogCategory::Nginx && self.progress.nginx.is_some_and(|context| !context.prepare()) {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "Nginx import cancelled"));
            }
            if category == LogCategory::Mongo {
                let (sender, receiver) = sync_channel(BUFFER_COUNT);
                self.jobs
                    .send(Job::Mongo(receiver, self.size))
                    .map_err(|error| io::Error::other(error.to_string()))?;
                self.mongo_chunks = Some(sender);
            }
            let mut buffer = self.free.recv().map_err(io::Error::other)?;
            buffer.extend_from_slice(&self.bytes);
            self.bytes = buffer;
        } else if matches!(
            category,
            LogCategory::Zip | LogCategory::Gzip | LogCategory::Archive
        ) {
            if let Some(size) = self.size.and_then(|size| usize::try_from(size).ok()) {
                self.bytes
                    .try_reserve_exact(size.saturating_sub(self.bytes.len()))
                    .map_err(io::Error::other)?;
            }
        } else {
            self.bytes.clear();
        }
        Ok(())
    }

    fn send_chunk(&mut self, end: usize) -> io::Result<()> {
        let tail = self.bytes[end..].to_vec();
        self.bytes.truncate(end);
        let bytes = std::mem::take(&mut self.bytes);
        self.send_buffer(bytes)?;
        self.bytes = self.free.recv().map_err(io::Error::other)?;
        self.bytes.extend_from_slice(&tail);
        self.target = CHUNK_SIZE.max(self.bytes.len().saturating_add(1));
        Ok(())
    }

    fn send_buffer(&self, bytes: Vec<u8>) -> io::Result<()> {
        if let Some(mongo) = &self.mongo_chunks {
            mongo.send(bytes).map_err(io::Error::other)
        } else {
            self.jobs
                .send(if self.category == Some(LogCategory::Nginx) { Job::Nginx(bytes) } else { Job::Pm2(bytes) })
                .map_err(|error| io::Error::other(error.to_string()))
        }
    }

    fn finish(mut self) -> Result<Option<NativeFileInfo>, String> {
        self.progress.add(self.progress_bytes);
        if self.category.is_none() {
            self.classify().map_err(|error| error.to_string())?;
        }
        match self.category.unwrap() {
            category @ (LogCategory::Pm2 | LogCategory::Mongo | LogCategory::Nginx) => {
                let bytes = std::mem::take(&mut self.bytes);
                self.send_buffer(bytes).map_err(|error| error.to_string())?;
                Ok(Some(NativeFileInfo {
                    name: self
                        .name
                        .rsplit('/')
                        .next()
                        .unwrap_or(self.name)
                        .to_string(),
                    path: self.path.to_string(),
                    size: self.written,
                    category: if category == LogCategory::Pm2 {
                        "pm2"
                    } else if category == LogCategory::Mongo {
                        "mongo"
                    } else {
                        "nginx"
                    }
                    .into(),
                }))
            }
            LogCategory::Zip | LogCategory::Gzip | LogCategory::Archive => {
                self.jobs
                    .send(Job::Nested(self.name.into(), self.path.into(), self.bytes))
                    .map_err(|error| error.to_string())?;
                Ok(None)
            }
            _ => Ok(None),
        }
    }
}

impl Write for EntrySink<'_, '_> {
    fn write(&mut self, mut data: &[u8]) -> io::Result<usize> {
        let len = data.len();
        self.written += len as u64;
        self.progress_bytes += len as u64;
        if self.progress_bytes >= 8 * 1024 * 1024 {
            self.progress.add(self.progress_bytes);
            self.progress_bytes = 0;
        }
        if self.category.is_none() {
            let take = (SNIFF_SIZE - self.bytes.len()).min(data.len());
            self.bytes.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.bytes.len() < SNIFF_SIZE {
                return Ok(len);
            }
            self.classify()?;
        }
        match self.category.unwrap() {
            LogCategory::Pm2 | LogCategory::Mongo | LogCategory::Nginx => {
                while !data.is_empty() {
                    let take = (self.target - self.bytes.len()).min(data.len());
                    self.bytes.extend_from_slice(&data[..take]);
                    data = &data[take..];
                    if self.bytes.len() == self.target {
                        if let Some(last) = self.bytes.iter().rposition(|byte| *byte == b'\n') {
                            self.send_chunk(last + 1)?;
                        } else {
                            // A log line may exceed the chunk size. Keep exactly
                            // that line together rather than dropping its tail.
                            self.target = self
                                .target
                                .checked_add(CHUNK_SIZE)
                                .ok_or_else(|| io::Error::other("Log line size overflow"))?;
                            self.bytes
                                .try_reserve_exact(CHUNK_SIZE)
                                .map_err(io::Error::other)?;
                        }
                    }
                }
            }
            LogCategory::Zip | LogCategory::Gzip | LogCategory::Archive => {
                self.bytes.extend_from_slice(data)
            }
            _ => {}
        }
        Ok(len)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
