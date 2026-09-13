//! Fast zero-allocation / minimal-allocation MongoDB query fingerprinting and index suggestion.

use crate::json::scan_balanced;
use memchr::memmem;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MongoOp {
    Find = 1,
    Aggregate = 2,
    Distinct = 3,
    GetMore = 4,
    Insert = 5,
    Update = 6,
    Delete = 7,
    FindAndModify = 8,
    CreateIndexes = 9,
    DropIndexes = 10,
    Count = 11,
    Other = 0,
}

impl MongoOp {
    pub fn as_str(self) -> &'static str {
        match self {
            MongoOp::Find => "find",
            MongoOp::Aggregate => "aggregate",
            MongoOp::Distinct => "distinct",
            MongoOp::GetMore => "getMore",
            MongoOp::Insert => "insert",
            MongoOp::Update => "update",
            MongoOp::Delete => "delete",
            MongoOp::FindAndModify => "findAndModify",
            MongoOp::CreateIndexes => "createIndexes",
            MongoOp::DropIndexes => "dropIndexes",
            MongoOp::Count => "count",
            MongoOp::Other => "other",
        }
    }

    pub fn from_u8(value: u8) -> Self {
        match value {
            1 => MongoOp::Find,
            2 => MongoOp::Aggregate,
            3 => MongoOp::Distinct,
            4 => MongoOp::GetMore,
            5 => MongoOp::Insert,
            6 => MongoOp::Update,
            7 => MongoOp::Delete,
            8 => MongoOp::FindAndModify,
            9 => MongoOp::CreateIndexes,
            10 => MongoOp::DropIndexes,
            11 => MongoOp::Count,
            _ => MongoOp::Other,
        }
    }
}

pub struct FingerprintResult {
    pub fingerprint: String,
    pub index_suggestion: String,
}

/// Detect the operation from the command object bytes.
pub fn detect_op(cmd: &[u8]) -> MongoOp {
    let Some(key) = first_quoted_key(cmd) else {
        return MongoOp::Other;
    };
    match key {
        b"find" => MongoOp::Find,
        b"aggregate" => MongoOp::Aggregate,
        b"distinct" => MongoOp::Distinct,
        b"getMore" => MongoOp::GetMore,
        b"insert" => MongoOp::Insert,
        b"update" => MongoOp::Update,
        b"delete" => MongoOp::Delete,
        b"findAndModify" => MongoOp::FindAndModify,
        b"createIndexes" => MongoOp::CreateIndexes,
        b"dropIndexes" => MongoOp::DropIndexes,
        b"count" => MongoOp::Count,
        b"q" => legacy_query_op(cmd),
        _ => nested_write_op(cmd),
    }
}

/// The first quoted key of a JSON object slice.
fn first_quoted_key(cmd: &[u8]) -> Option<&[u8]> {
    let mut index = 0;
    while index < cmd.len() && (cmd[index] == b'{' || cmd[index].is_ascii_whitespace()) {
        index += 1;
    }
    if index >= cmd.len() || cmd[index] != b'"' {
        return None;
    }
    index += 1;
    let start = index;
    while index < cmd.len() && cmd[index] != b'"' {
        index += 1;
    }
    Some(&cmd[start..index])
}

/// A legacy `q`-wrapped command: sniff the write verb out of its bytes.
fn legacy_query_op(cmd: &[u8]) -> MongoOp {
    if memmem::find(cmd, b"\"u\":").is_some() || memmem::find(cmd, b"\"update\":").is_some() {
        MongoOp::Update
    } else if memmem::find(cmd, b"\"remove\":true").is_some()
        || memmem::find(cmd, b"\"delete\":").is_some()
    {
        MongoOp::Delete
    } else {
        MongoOp::Other
    }
}

/// An unrecognised command whose payload still names a write verb.
fn nested_write_op(cmd: &[u8]) -> MongoOp {
    if memmem::find(cmd, b"\"update\":").is_some() {
        MongoOp::Update
    } else if memmem::find(cmd, b"\"delete\":").is_some() {
        MongoOp::Delete
    } else {
        MongoOp::Other
    }
}

/// Extract keys from an object slice `{ "key1": ..., "key2": ... }`.
pub fn extract_top_keys(obj_slice: &[u8]) -> Vec<String> {
    let mut keys = Vec::new();
    let mut index = 0;
    while index < obj_slice.len() {
        if obj_slice[index] != b'"' {
            index += 1;
            continue;
        }
        let key_start = index + 1;
        let Some(key_end) = scan_string_end(obj_slice, key_start) else {
            index += 1;
            continue;
        };
        let Some(colon) = colon_after(obj_slice, key_end + 1) else {
            index += 1;
            continue;
        };
        if let Some(key) = top_key_str(&obj_slice[key_start..key_end]) {
            keys.push(key.to_string());
        }
        index = skip_value(obj_slice, colon + 1);
    }
    keys
}

/// Index of the closing quote of the string that starts at `start`.
fn scan_string_end(bytes: &[u8], mut index: usize) -> Option<usize> {
    while index < bytes.len() && bytes[index] != b'"' {
        index += if bytes[index] == b'\\' { 2 } else { 1 };
    }
    (index < bytes.len()).then_some(index)
}

/// Index of the `:` after `from`, skipping whitespace.
fn colon_after(bytes: &[u8], from: usize) -> Option<usize> {
    let mut index = from;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    (index < bytes.len() && bytes[index] == b':').then_some(index)
}

/// Index just past the value that follows the colon at `index`.
fn skip_value(bytes: &[u8], mut index: usize) -> usize {
    let mut depth = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'"' {
            let Some(end) = scan_string_end(bytes, index + 1) else {
                return bytes.len();
            };
            index = end + 1;
            continue;
        }
        match byte {
            b'{' | b'[' => depth += 1,
            b'}' | b']' if depth == 0 => break,
            b'}' | b']' => depth -= 1,
            b',' if depth == 0 => return index + 1,
            _ => {}
        }
        index += 1;
    }
    index
}

/// The key as a string, unless it is driver bookkeeping.
fn top_key_str(key_bytes: &[u8]) -> Option<&str> {
    let key = std::str::from_utf8(key_bytes).ok()?;
    (!key.starts_with("lsid") && key != "$db" && key != "$readPreference").then_some(key)
}

/// Find a sub-object or sub-array by key name in JSON bytes.
pub fn find_sub_object<'a>(haystack: &'a [u8], key: &[u8]) -> Option<&'a [u8]> {
    let mut search = Vec::with_capacity(key.len() + 2);
    search.push(b'"');
    search.extend_from_slice(key);
    search.push(b'"');

    let key_pos = memmem::find(haystack, &search)?;
    let value_start = skip_to_value(haystack, key_pos + search.len())?;
    match haystack[value_start] {
        b'{' => Some(scan_balanced(haystack, value_start, b'{', b'}')),
        b'[' => Some(scan_balanced(haystack, value_start, b'[', b']')),
        _ => None,
    }
}

/// Index of the value after `key":"`, skipping whitespace and the colon.
fn skip_to_value(bytes: &[u8], from: usize) -> Option<usize> {
    let mut index = from;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if index >= bytes.len() || bytes[index] != b':' {
        return None;
    }
    index += 1;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    (index < bytes.len()).then_some(index)
}

/// Generate MongoDB query fingerprint and index suggestion.
pub fn generate_fingerprint(
    op: MongoOp,
    collection: &str,
    cmd: &[u8],
    is_collscan: bool,
) -> FingerprintResult {
    let mut filter_keys = Vec::new();
    let mut sort_keys = Vec::new();
    let fingerprint = match op {
        MongoOp::Find => find_fingerprint(cmd, &mut filter_keys, &mut sort_keys),
        MongoOp::Aggregate => {
            aggregate_fingerprint(cmd, collection, &mut filter_keys, &mut sort_keys)
        }
        MongoOp::Distinct => distinct_fingerprint(cmd, &mut filter_keys),
        MongoOp::GetMore => get_more_fingerprint(cmd),
        MongoOp::Update => write_fingerprint("update", collection, cmd, &mut filter_keys),
        MongoOp::Delete => write_fingerprint("delete", collection, cmd, &mut filter_keys),
        MongoOp::FindAndModify => find_and_modify_fingerprint(cmd, collection, &mut filter_keys),
        _ => format!("{}({})", op.as_str(), collection),
    };
    let index_suggestion = index_suggestion(collection, is_collscan, &filter_keys, &sort_keys);
    FingerprintResult {
        fingerprint,
        index_suggestion,
    }
}

/// `find({filter}) sort: {keys}` from the command's `filter` and `sort` objects.
fn find_fingerprint(
    cmd: &[u8],
    filter_keys: &mut Vec<String>,
    sort_keys: &mut Vec<String>,
) -> String {
    let filter_str = match find_sub_object(cmd, b"filter") {
        Some(filter_obj) => {
            *filter_keys = extract_top_keys(filter_obj);
            filter_expression(filter_keys)
        }
        None => String::from("{}"),
    };
    let sort_str = match find_sub_object(cmd, b"sort") {
        Some(sort_obj) => {
            *sort_keys = extract_top_keys(sort_obj);
            if sort_keys.is_empty() {
                String::new()
            } else {
                format!(" sort: {{{}}}", sort_keys.join(", "))
            }
        }
        None => String::new(),
    };
    format!("find({}){}", filter_str, sort_str)
}

/// `{"key":"?", ...}` for the collected filter keys.
fn filter_expression(filter_keys: &[String]) -> String {
    if filter_keys.is_empty() {
        return String::from("{}");
    }
    let parts: Vec<String> = filter_keys
        .iter()
        .map(|key| format!(r#""{}":"?""#, key))
        .collect();
    format!("{{{}}}", parts.join(", "))
}

/// `aggregate([$match(...) ➔ $sort(...)])` from the pipeline's stages.
fn aggregate_fingerprint(
    cmd: &[u8],
    collection: &str,
    filter_keys: &mut Vec<String>,
    sort_keys: &mut Vec<String>,
) -> String {
    let mut stage_parts = Vec::new();
    if let Some(pipeline) = find_sub_object(cmd, b"pipeline") {
        push_stage(&mut stage_parts, filter_keys, pipeline, b"$match", "$match");
        push_stage(&mut stage_parts, sort_keys, pipeline, b"$sort", "$sort");
    }
    if stage_parts.is_empty() {
        format!("aggregate({})", collection)
    } else {
        format!("aggregate([{}])", stage_parts.join(" ➔ "))
    }
}

/// Push one `$match` / `$sort` pipeline stage and collect its keys.
fn push_stage(
    stage_parts: &mut Vec<String>,
    keys: &mut Vec<String>,
    pipeline: &[u8],
    stage_key: &[u8],
    stage_name: &str,
) {
    let Some(stage_obj) = find_sub_object(pipeline, stage_key) else {
        return;
    };
    let stage_keys = extract_top_keys(stage_obj);
    if stage_keys.is_empty() {
        return;
    }
    stage_parts.push(format!("{}({})", stage_name, stage_keys.join(", ")));
    keys.extend(stage_keys);
}

/// `distinct("key")` from the command's `key` and `query` objects.
fn distinct_fingerprint(cmd: &[u8], filter_keys: &mut Vec<String>) -> String {
    let key = find_sub_object(cmd, b"key")
        .map_or("?", |key_sub| std::str::from_utf8(key_sub).unwrap_or("?"));
    if let Some(query_obj) = find_sub_object(cmd, b"query") {
        *filter_keys = extract_top_keys(query_obj);
    }
    format!(r#"distinct("{}")"#, key)
}

/// `getMore(batchSize=N)` from the command's `batchSize`.
fn get_more_fingerprint(cmd: &[u8]) -> String {
    let batch = find_batch_size(cmd).unwrap_or("default");
    format!("getMore(batchSize={})", batch)
}

/// The digits after `"batchSize":`, when present.
fn find_batch_size(cmd: &[u8]) -> Option<&str> {
    let key_pos = memmem::find(cmd, b"\"batchSize\":")?;
    let start = key_pos + 12;
    let mut end = start;
    while end < cmd.len() && cmd[end].is_ascii_digit() {
        end += 1;
    }
    std::str::from_utf8(&cmd[start..end]).ok()
}

/// `update(collection {keys})` / `delete(collection {keys})` from the `q` object.
fn write_fingerprint(
    verb: &str,
    collection: &str,
    cmd: &[u8],
    filter_keys: &mut Vec<String>,
) -> String {
    if let Some(query_obj) = find_sub_object(cmd, b"q") {
        *filter_keys = extract_top_keys(query_obj);
    }
    if filter_keys.is_empty() {
        return format!("{}({})", verb, collection);
    }
    let parts: Vec<String> = filter_keys
        .iter()
        .map(|key| format!(r#""{}":"?""#, key))
        .collect();
    format!("{}({} {{{}}})", verb, collection, parts.join(", "))
}

/// `findAndModify(collection)` from the command's `query` object.
fn find_and_modify_fingerprint(
    cmd: &[u8],
    collection: &str,
    filter_keys: &mut Vec<String>,
) -> String {
    if let Some(query_obj) = find_sub_object(cmd, b"query") {
        *filter_keys = extract_top_keys(query_obj);
    }
    format!("findAndModify({})", collection)
}

/// The index suggestion for the collected filter and sort keys.
fn index_suggestion(
    collection: &str,
    is_collscan: bool,
    filter_keys: &[String],
    sort_keys: &[String],
) -> String {
    if collection.is_empty() || collection == "unknown" || collection == "$cmd" {
        return String::new();
    }
    let mut combined = Vec::new();
    for key in filter_keys.iter().chain(sort_keys) {
        if !key.starts_with('$') && !combined.contains(key) {
            combined.push(key.clone());
        }
    }
    if combined.is_empty() {
        return if is_collscan {
            format!(
                "db.{}.createIndex({{ /* specify filter field */: 1 }})",
                collection,
            )
        } else {
            String::new()
        };
    }
    let parts: Vec<String> = combined
        .iter()
        .take(4)
        .map(|key| format!("{}: 1", key))
        .collect();
    format!("db.{}.createIndex({{ {} }})", collection, parts.join(", "))
}
