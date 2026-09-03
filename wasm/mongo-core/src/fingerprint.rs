//! Fast zero-allocation / minimal-allocation MongoDB query fingerprinting and index suggestion.

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

    pub fn from_u8(v: u8) -> Self {
        match v {
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
    pub op: MongoOp,
    pub fingerprint: String,
    pub filter_keys: Vec<String>,
    pub sort_keys: Vec<String>,
    pub index_suggestion: String,
}

/// Detect the operation from the command object bytes.
pub fn detect_op(cmd: &[u8]) -> MongoOp {
    // Find first quote after opening brace
    let mut i = 0;
    while i < cmd.len() && (cmd[i] == b'{' || cmd[i].is_ascii_whitespace()) {
        i += 1;
    }
    if i >= cmd.len() || cmd[i] != b'"' {
        return MongoOp::Other;
    }
    i += 1;
    let start = i;
    while i < cmd.len() && cmd[i] != b'"' {
        i += 1;
    }
    let key = &cmd[start..i];
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
        b"q" => {
            if memmem::find(cmd, b"\"u\":").is_some() || memmem::find(cmd, b"\"update\":").is_some() {
                MongoOp::Update
            } else if memmem::find(cmd, b"\"remove\":true").is_some() || memmem::find(cmd, b"\"delete\":").is_some() {
                MongoOp::Delete
            } else {
                MongoOp::Other
            }
        }
        _ => {
            if memmem::find(cmd, b"\"update\":").is_some() {
                MongoOp::Update
            } else if memmem::find(cmd, b"\"delete\":").is_some() {
                MongoOp::Delete
            } else {
                MongoOp::Other
            }
        }
    }
}

/// Extract keys from an object slice `{ "key1": ..., "key2": ... }`
pub fn extract_top_keys(obj_slice: &[u8]) -> Vec<String> {
    let mut keys = Vec::new();
    let mut i = 0;
    let n = obj_slice.len();

    while i < n {
        if obj_slice[i] == b'"' {
            let start = i + 1;
            i += 1;
            while i < n && obj_slice[i] != b'"' {
                if obj_slice[i] == b'\\' {
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if i < n {
                let key_bytes = &obj_slice[start..i];
                // Check if followed by ':'
                let mut j = i + 1;
                while j < n && obj_slice[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < n && obj_slice[j] == b':' {
                    if let Ok(k) = std::str::from_utf8(key_bytes) {
                        if !k.starts_with("lsid") && k != "$db" && k != "$readPreference" {
                            keys.push(k.to_string());
                        }
                    }
                    i = j + 1;
                    // Skip value
                    let mut depth = 0;
                    let mut in_str = false;
                    while i < n {
                        let c = obj_slice[i];
                        if in_str {
                            if c == b'\\' {
                                i += 2;
                                continue;
                            } else if c == b'"' {
                                in_str = false;
                            }
                        } else if c == b'"' {
                            in_str = true;
                        } else if c == b'{' || c == b'[' {
                            depth += 1;
                        } else if c == b'}' || c == b']' {
                            if depth == 0 {
                                break;
                            }
                            depth -= 1;
                        } else if c == b',' && depth == 0 {
                            i += 1;
                            break;
                        }
                        i += 1;
                    }
                    continue;
                }
            }
        }
        i += 1;
    }
    keys
}

/// Find a sub-object by key name in JSON bytes.
pub fn find_sub_object<'a>(haystack: &'a [u8], key: &[u8]) -> Option<&'a [u8]> {
    let mut search = Vec::with_capacity(key.len() + 2);
    search.push(b'"');
    search.extend_from_slice(key);
    search.push(b'"');

    let key_pos = memmem::find(haystack, &search)?;
    let mut i = key_pos + search.len();
    while i < haystack.len() && haystack[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= haystack.len() || haystack[i] != b':' {
        return None;
    }
    i += 1;
    while i < haystack.len() && haystack[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= haystack.len() {
        return None;
    }
    if haystack[i] == b'{' {
        let start = i;
        let mut depth = 1;
        let mut in_str = false;
        i += 1;
        while i < haystack.len() && depth > 0 {
            let c = haystack[i];
            if in_str {
                if c == b'\\' {
                    i += 2;
                    continue;
                } else if c == b'"' {
                    in_str = false;
                }
            } else if c == b'"' {
                in_str = true;
            } else if c == b'{' {
                depth += 1;
            } else if c == b'}' {
                depth -= 1;
            }
            i += 1;
        }
        return Some(&haystack[start..i]);
    } else if haystack[i] == b'[' {
        let start = i;
        let mut depth = 1;
        let mut in_str = false;
        i += 1;
        while i < haystack.len() && depth > 0 {
            let c = haystack[i];
            if in_str {
                if c == b'\\' {
                    i += 2;
                    continue;
                } else if c == b'"' {
                    in_str = false;
                }
            } else if c == b'"' {
                in_str = true;
            } else if c == b'[' {
                depth += 1;
            } else if c == b']' {
                depth -= 1;
            }
            i += 1;
        }
        return Some(&haystack[start..i]);
    }
    None
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
        MongoOp::Find => {
            let mut filter_str = String::from("{}");
            if let Some(filter_obj) = find_sub_object(cmd, b"filter") {
                filter_keys = extract_top_keys(filter_obj);
                if !filter_keys.is_empty() {
                    let mut parts = Vec::new();
                    for k in &filter_keys {
                        parts.push(format!("\"{}\":\"?\"", k));
                    }
                    filter_str = format!("{{{}}}", parts.join(", "));
                }
            }

            let mut sort_str = String::new();
            if let Some(sort_obj) = find_sub_object(cmd, b"sort") {
                sort_keys = extract_top_keys(sort_obj);
                if !sort_keys.is_empty() {
                    sort_str = format!(" sort: {{{}}}", sort_keys.join(", "));
                }
            }
            format!("find({}){}", filter_str, sort_str)
        }
        MongoOp::Aggregate => {
            let mut stage_parts = Vec::new();
            if let Some(pipe_arr) = find_sub_object(cmd, b"pipeline") {
                // Find $match stages
                if let Some(match_obj) = find_sub_object(pipe_arr, b"$match") {
                    let m_keys = extract_top_keys(match_obj);
                    if !m_keys.is_empty() {
                        stage_parts.push(format!("$match({})", m_keys.join(", ")));
                        filter_keys.extend(m_keys);
                    }
                }
                if let Some(sort_obj) = find_sub_object(pipe_arr, b"$sort") {
                    let s_keys = extract_top_keys(sort_obj);
                    if !s_keys.is_empty() {
                        stage_parts.push(format!("$sort({})", s_keys.join(", ")));
                        sort_keys.extend(s_keys);
                    }
                }
            }
            if stage_parts.is_empty() {
                format!("aggregate({})", collection)
            } else {
                format!("aggregate([{}])", stage_parts.join(" ➔ "))
            }
        }
        MongoOp::Distinct => {
            let key = if let Some(key_sub) = find_sub_object(cmd, b"key") {
                std::str::from_utf8(key_sub).unwrap_or("?")
            } else {
                "?"
            };
            if let Some(query_obj) = find_sub_object(cmd, b"query") {
                filter_keys = extract_top_keys(query_obj);
            }
            format!("distinct(\"{}\")", key)
        }
        MongoOp::GetMore => {
            let batch = if let Some(b) = memmem::find(cmd, b"\"batchSize\":") {
                let start = b + 12;
                let mut end = start;
                while end < cmd.len() && cmd[end].is_ascii_digit() {
                    end += 1;
                }
                std::str::from_utf8(&cmd[start..end]).unwrap_or("1000")
            } else {
                "default"
            };
            format!("getMore(batchSize={})", batch)
        }
        MongoOp::Update => {
            if let Some(q_obj) = find_sub_object(cmd, b"q") {
                filter_keys = extract_top_keys(q_obj);
            }
            if filter_keys.is_empty() {
                format!("update({})", collection)
            } else {
                let parts: Vec<String> = filter_keys.iter().map(|k| format!("\"{}\":\"?\"", k)).collect();
                format!("update({} {{{}}})", collection, parts.join(", "))
            }
        }
        MongoOp::Delete => {
            if let Some(q_obj) = find_sub_object(cmd, b"q") {
                filter_keys = extract_top_keys(q_obj);
            }
            if filter_keys.is_empty() {
                format!("delete({})", collection)
            } else {
                let parts: Vec<String> = filter_keys.iter().map(|k| format!("\"{}\":\"?\"", k)).collect();
                format!("delete({} {{{}}})", collection, parts.join(", "))
            }
        }
        MongoOp::FindAndModify => {
            if let Some(query_obj) = find_sub_object(cmd, b"query") {
                filter_keys = extract_top_keys(query_obj);
            }
            format!("findAndModify({})", collection)
        }
        _ => format!("{}({})", op.as_str(), collection),
    };

    // Generate Index Suggestion
    let mut combined = Vec::new();
    for k in &filter_keys {
        if !k.starts_with('$') && !combined.contains(k) {
            combined.push(k.clone());
        }
    }
    for k in &sort_keys {
        if !k.starts_with('$') && !combined.contains(k) {
            combined.push(k.clone());
        }
    }

    let index_suggestion = if !collection.is_empty() && collection != "unknown" && collection != "$cmd" {
        if !combined.is_empty() {
            let parts: Vec<String> = combined.iter().take(4).map(|k| format!("{}: 1", k)).collect();
            format!("db.{}.createIndex({{ {} }})", collection, parts.join(", "))
        } else if is_collscan {
            format!("db.{}.createIndex({{ /* specify filter field */: 1 }})", collection)
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    FingerprintResult {
        op,
        fingerprint,
        filter_keys,
        sort_keys,
        index_suggestion,
    }
}
