#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogCategory {
    Pm2,
    Mongo,
    Zip,
    Gzip,
    Skip,
    Unknown,
}

pub fn classify_name(name: &str) -> LogCategory {
    let lower = name.to_ascii_lowercase().replace('\\', "/");
    let file_name = lower.rsplit('/').next().unwrap_or(&lower);

    // Skip hidden files, system files, directories, OSX metadata
    if file_name.starts_with('.')
        || file_name.starts_with("__macosx")
        || file_name.is_empty()
        || lower.ends_with('/')
    {
        return LogCategory::Skip;
    }

    // Skip error logs — they do not contain API timing metrics
    if file_name.contains("error") {
        return LogCategory::Skip;
    }

    // Archive extensions
    if file_name.ends_with(".zip") {
        return LogCategory::Zip;
    }

    // Gzip extension check: if name before .gz classifies, note it
    let clean_name = file_name.strip_suffix(".gz").unwrap_or(file_name);

    // Mongo patterns: mongod.log*, mongodb.log*, mongo*.log*
    if clean_name.starts_with("mongod")
        || clean_name.starts_with("mongodb")
        || clean_name.starts_with("mongo.")
        || clean_name.starts_with("mongo-")
        || clean_name.starts_with("mongo_")
        || clean_name.contains("mongod.log")
        || clean_name.contains("mongodb.log")
    {
        return LogCategory::Mongo;
    }

    // API / PM2 patterns: api-out.log*, pm2*, out.log, etc.
    if clean_name.contains("api-out")
        || clean_name.contains("api_out")
        || clean_name.starts_with("api.")
        || clean_name.starts_with("api-")
        || clean_name.contains("pm2")
        || clean_name.starts_with("out.log")
    {
        return LogCategory::Pm2;
    }

    if file_name.ends_with(".gz") {
        return LogCategory::Gzip;
    }

    LogCategory::Unknown
}

pub fn classify_content(data: &[u8]) -> LogCategory {
    if data.len() >= 4 && &data[..4] == b"PK\x03\x04" {
        return LogCategory::Zip;
    }
    if data.len() >= 2 && &data[..2] == b"\x1f\x8b" {
        return LogCategory::Gzip;
    }

    let sample_len = data.len().min(4096);
    let sample = &data[..sample_len];

    // Check for Mongo JSON or legacy formats
    if sample.windows(8).any(|window| window == b"\"$date\"")
        || sample.windows(5).any(|window| window == b"\"msg\"")
        || sample.windows(5).any(|window| window == b"\"ctx\"")
        || sample.windows(15).any(|window| window == b"[initandlisten]")
        || sample.windows(6).any(|window| window == b"[conn")
    {
        return LogCategory::Mongo;
    }

    // Check for HTTP / PM2 log lines
    if sample.windows(4).any(|window| window == b"GET " || window == b"POST")
        || sample.windows(4).any(|window| window == b"PUT " || window == b"HEAD")
        || sample
            .windows(7)
            .any(|window| window == b"DELETE " || window == b"OPTIONS")
        || sample.windows(6).any(|window| window == b"[cron]")
        || sample.windows(5).any(|window| window == b"[PM2]")
    {
        return LogCategory::Pm2;
    }

    LogCategory::Unknown
}

pub fn classify_file_or_entry(name: &str, sample: &[u8]) -> LogCategory {
    let name_cat = classify_name(name);
    if name_cat != LogCategory::Unknown {
        return name_cat;
    }
    classify_content(sample)
}

#[cfg(test)]
mod tests {
    use super::{classify_content, classify_name, LogCategory};

    #[test]
    fn test_classify_by_name() {
        assert_eq!(classify_name("mongod.log.1"), LogCategory::Mongo);
        assert_eq!(classify_name("mongod.log.10.gz"), LogCategory::Mongo);
        assert_eq!(classify_name("mongodb.log"), LogCategory::Mongo);
        assert_eq!(classify_name("api-out.log.1"), LogCategory::Pm2);
        assert_eq!(classify_name("api-out.log.5.gz"), LogCategory::Pm2);
        assert_eq!(classify_name("api-error.log.5.gz"), LogCategory::Skip);
        assert_eq!(classify_name("error.log"), LogCategory::Skip);
        assert_eq!(classify_name(".DS_Store"), LogCategory::Skip);
        assert_eq!(classify_name("__MACOSX/._log.txt"), LogCategory::Skip);
        assert_eq!(classify_name("archive.zip"), LogCategory::Zip);
        assert_eq!(classify_name("custom.log.gz"), LogCategory::Gzip);
        assert_eq!(classify_name("custom.log"), LogCategory::Unknown);
    }

    #[test]
    fn test_classify_by_content() {
        let mongo_sample = b"{\"t\":{\"$date\":\"2026-09-12T10:00:00.000Z\"},\"s\":\"I\",\"c\":\"COMMAND\",\"ctx\":\"conn123\",\"msg\":\"Slow query\"}";
        assert_eq!(classify_content(mongo_sample), LogCategory::Mongo);

        let pm2_sample = b"2026-09-12 10:00:00: GET /api/v1/orders 200 45.2 ms - 1024";
        assert_eq!(classify_content(pm2_sample), LogCategory::Pm2);

        let zip_sample = b"PK\x03\x04\x14\x00\x00\x00";
        assert_eq!(classify_content(zip_sample), LogCategory::Zip);

        let gz_sample = b"\x1f\x8b\x08\x00\x00\x00";
        assert_eq!(classify_content(gz_sample), LogCategory::Gzip);
    }
}
