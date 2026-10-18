# Browser portability patch

Vendored from the published `unrar-rs` 0.11.0 package from crates.io.
Upstream repository: https://github.com/scryer-media/rarpar

Published package SHA-256:
`374d56427700534ae07ae77280b6d95071ab11b02d1737493e02e425d20b00bf`

The local Cargo registry source does not contain `.cargo-checksum.json`; the
package checksum above is recorded in this project's `src-tauri/Cargo.lock`.
All 67 source files, `LICENSE`, and `README.md` were copied from that package.

Three upstream files are changed:

- `Cargo.toml`: retain the published package metadata, library features, and
  normal/target dependencies in a standalone manifest. Omit example, bench,
  integration-test and development dependency declarations because those
  upstream harnesses and fixtures are not vendored. Add `js-sys = "=0.3.103"`
  only for `wasm32-unknown-unknown`.
- `src/rar4/mod.rs`: exclude the browser target from the Unix `libc::tm` /
  `libc::mktime` implementation, which cannot compile for that target. Convert
  DOS local timestamps using JavaScript `Date` on browsers, preserving local
  timezone and DST interpretation. Native and WASI conversion paths are
  unchanged.
- `src/rar4/header.rs`: distinguish an empty header boundary from a partial
  seven-byte header, returning an error for truncated headers.

The complete upstream license is preserved in `LICENSE`: Apache-2.0 plus the
UnRAR decompression restriction. Binary redistributions must retain its related
license information.
