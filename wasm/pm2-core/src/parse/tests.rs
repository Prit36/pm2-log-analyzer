use super::{parse_line_bytes, LineKind, Method};

#[test]
fn http_a() {
    let line = b"2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42";
    match parse_line_bytes(line, 0, line.len()) {
        LineKind::Http {
            method,
            path_start,
            path_end,
            status,
            duration_ms,
            hour,
            date,
        } => {
            assert_eq!(method, Method::Get);
            assert_eq!(&line[path_start..path_end], b"/api/health");
            assert_eq!(status, 200);
            assert!((duration_ms - 12.5).abs() < 0.01);
            assert_eq!(hour, Some(0));
            assert_eq!(date, Some(*b"2026-07-24"));
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn http_a_no_timestamp() {
    let line = b"\x1b[0mPOST /api/admin/dashboard/dashboarddata \x1b[32m200\x1b[0m 71.197 ms - 223\x1b[0m";
    match parse_line_bytes(line, 0, line.len()) {
        LineKind::Http {
            method,
            path_start,
            path_end,
            status,
            duration_ms,
            hour,
            date,
        } => {
            assert_eq!(method, Method::Post);
            assert_eq!(&line[path_start..path_end], b"/api/admin/dashboard/dashboarddata");
            assert_eq!(status, 200);
            assert!((duration_ms - 71.197).abs() < 0.01);
            assert_eq!(hour, None);
            assert_eq!(date, None);
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn http_b() {
    let line = b"68064.174ms\tPOST /api/admin/user/getuserbyrole";
    match parse_line_bytes(line, 0, line.len()) {
        LineKind::Http {
            method,
            status,
            duration_ms,
            ..
        } => {
            assert_eq!(method, Method::Post);
            assert_eq!(status, 0);
            assert!((duration_ms - 68064.174).abs() < 0.01);
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn http_b_leading_dot() {
    // Duration-first lines may start with '.' (e.g. `.5ms GET /x`).
    let line = b".5ms GET /api/dot";
    match parse_line_bytes(line, 0, line.len()) {
        LineKind::Http {
            method,
            path_start,
            path_end,
            duration_ms,
            ..
        } => {
            assert_eq!(method, Method::Get);
            assert_eq!(&line[path_start..path_end], b"/api/dot");
            assert!((duration_ms - 0.5).abs() < 0.01);
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn empty_and_unmatched() {
    assert!(matches!(parse_line_bytes(b"   ", 0, 3), LineKind::Empty));
    assert!(matches!(
        parse_line_bytes(b"socket connected", 0, 16),
        LineKind::Unmatched
    ));
}

#[test]
fn options_is_noise() {
    let line = b"2026-07-24T00:00:10: \x1b[0mOPTIONS /api/x \x1b[32m204\x1b[0m 0.115 ms - 0\x1b[0m";
    assert!(matches!(
        parse_line_bytes(line, 0, line.len()),
        LineKind::Empty | LineKind::Unmatched
    ));
}

#[test]
fn socket_noise_is_skipped() {
    let cases: &[&[u8]] = &[
        b"2026-07-24T00:00:05: New Connection { address: '::ffff:127.0.0.1', id: 'abc' }",
        b"2026-07-24T00:00:39: disconnected { id: 'abc', method: 'disconnect' }",
        b"2026-07-24T00:01:29: join {",
        b"  { 'abc': undefined }",
        b"}",
        b"] { CoNctv8nmitCu03iAAEW: undefined }",
        b"] Length: 5",
        b"2026-07-24T00:04:28: Token parts: [",
        b"  address: '::ffff:127.0.0.1',",
        b"  method: 'join'",
    ];
    for line in cases {
        assert!(
            matches!(parse_line_bytes(line, 0, line.len()), LineKind::Empty),
            "expected Empty for {:?}",
            String::from_utf8_lossy(line),
        );
    }
    // Legit non-HTTP lines stay unmatched, not silently dropped.
    let keep: &[&[u8]] = &[
        b"Generated new NCD declaration for proposal PR-MOT-20261397003",
        b"useOfVehicle 1 vehicleUsage 1",
        b"customerReferenceNumber: 'QN/02/4030/2026/0715183'",
    ];
    for line in keep {
        assert!(
            matches!(parse_line_bytes(line, 0, line.len()), LineKind::Unmatched),
            "expected Unmatched for {:?}",
            String::from_utf8_lossy(line),
        );
    }
}
