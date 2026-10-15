# Archive fixtures

logs.* contain the same synthetic API request, MongoDB slow query, and skipped error log. Created with 7-Zip 25.00. The 7z fixture uses solid compression. nested.zip contains logs.7z; nested.7z contains logs.zip. encrypted.7z uses password secret with encrypted headers. corrupt.7z has a truncated header.

solid-reset.7z contains 11,000,004 bytes across two solid files (LZMA2, 256 KiB dictionary, 32 MiB solid block, uncompressed headers). Its synthetic contents repeat bytes 512..700 from logs.tar; file sizes are 4,500,001 and 6,500,003 bytes. It exercises independent reset groups and a file boundary inside a decode window. logs-deflate.7z wraps logs.zip using Deflate to exercise the compatibility decoder.

metadata.tar exercises GNU long names, base256 sizes, UTF-8 PAX paths/size overrides, and a skipped symlink. logs-concat.tar.gz splits logs.tar across two concatenated gzip members to verify compatibility fallback.

rar3-solid.rar and rar5-solid.rar are upstream solid RAR4 and RAR5 fixtures from https://github.com/markokr/rarfile/tree/master/test/files. Both contain stest1.txt and stest2.txt, 2048 bytes each (000 through 511 followed by newlines). rar5-psw.rar (encrypted) and rar5-vols.part1.rar (incomplete split archive) come from the same upstream fixture directory. Upstream license:


Copyright (c) 2005-2026 Marko Kreen <markokr@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
