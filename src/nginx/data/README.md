# Offline IP country snapshot

The bundled ranges come from [sapics/ip-location-db user-country](https://github.com/sapics/ip-location-db#country), published under the [Open Data Commons Public Domain Dedication and License 1.0 (PDDL)](https://opendatacommons.org/licenses/pddl/1-0/). See the [publisher's licensing statement](https://github.com/sapics/ip-location-db#original-databases-update-daily).

`manifest.json` records the source snapshot date, exact download URLs, official checksum URLs, source and binary SHA-256 checksums, record counts, and sizes. The source date is its HTTP Last-Modified date in UTC. Country is an approximate network location; it does not establish a person's location.

Both files are sorted, inclusive, non-overlapping ranges without headers:

- `country-ipv4.bin`: 10 bytes per record: 4-byte start, 4-byte end, 2 ASCII country bytes.
- `country-ipv6.bin`: 34 bytes per record: 16-byte start, 16-byte end, 2 ASCII country bytes.

All integers use network (big-endian) byte order. Unassigned gaps stay unassigned. Empty country codes and unknown markers (`ZZ`, `XX`, or non-letter codes) are omitted. All other upstream two-letter region codes are preserved, including the `AC`, `TA`, `AN`, and `XK` extensions or historical codes; the application displays the region name where available.

Run `node scripts/build-nginx-country-data.mjs` from the repository root to reproduce the binaries while the published release matches the recorded source checksums. Upstream replaces its daily release assets; use `node scripts/build-nginx-country-data.mjs --update` to accept a new snapshot. Both commands verify the publisher's SHA-256 files and validate range ordering, bounds, and overlap before writing output. Historical source assets may no longer be available from upstream; the checked-in binaries and manifest preserve this snapshot.

Only the build script downloads public database files. Country lookups in the application use these bundled assets locally; log contents and client IPs are never sent to a lookup service.
