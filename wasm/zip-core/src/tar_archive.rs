use std::io::{self, Read, Seek};

#[derive(serde::Serialize)]
pub(crate) struct TarEntry {
    pub name: String,
    pub size: u64,
    pub offset: u64,
    pub directory: bool,
}

pub(crate) fn inspect_tar(reader: impl Read + Seek, length: u64) -> io::Result<Vec<TarEntry>> {
    let mut archive = tar::Archive::new(reader);
    let mut entries = Vec::new();
    for entry in archive.entries_with_seek()? {
        let entry = entry?;
        let kind = entry.header().entry_type();
        if kind.is_pax_global_extensions()
            || kind.is_pax_local_extensions()
            || kind.is_gnu_longname()
            || kind.is_gnu_longlink()
        {
            continue;
        }
        let size = entry.size();
        let offset = entry.raw_file_position();
        if kind.is_file() && offset.checked_add(size).is_none_or(|end| end > length) {
            return Err(io::Error::other("Truncated TAR archive entry"));
        }
        entries.push(TarEntry {
            name: entry.path()?.to_string_lossy().into_owned(),
            size,
            offset,
            directory: !kind.is_file(),
        });
    }
    if entries.is_empty() {
        return Err(io::Error::other("Invalid or empty TAR archive"));
    }
    Ok(entries)
}

pub(crate) fn visit_tar(
    reader: impl Read,
    mut consume: impl FnMut(&str, u64, bool, &mut dyn Read) -> io::Result<()>,
) -> io::Result<()> {
    let mut archive = tar::Archive::new(reader);
    let mut has_entries = false;
    for entry in archive.entries()? {
        let mut entry = entry?;
        has_entries = true;
        let path = entry.path()?.to_string_lossy().into_owned();
        let kind = entry.header().entry_type();
        if kind.is_pax_global_extensions()
            || kind.is_pax_local_extensions()
            || kind.is_gnu_longname()
            || kind.is_gnu_longlink()
        {
            continue;
        }
        consume(&path, entry.size(), kind.is_file(), &mut entry)?;
    }
    if !has_entries {
        return Err(io::Error::other("Invalid or empty TAR archive"));
    }
    // Reading past TAR's end markers verifies the compression trailer as well.
    io::copy(&mut archive.into_inner(), &mut io::sink())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tar_metadata_and_truncated_entries() {
        let mut entries = Vec::new();
        visit_tar(
            include_bytes!("../../../tests/fixtures/archives/metadata.tar").as_slice(),
            |name, size, is_file, reader| {
                let mut bytes = Vec::new();
                reader.read_to_end(&mut bytes)?;
                if is_file {
                    assert_eq!(bytes.len() as u64, size);
                    entries.push((name.to_owned(), bytes));
                }
                Ok(())
            },
        )
        .unwrap();
        assert!(
            entries
                .iter()
                .any(|(name, _)| name.ends_with("api-out.log"))
        );
        let bytes = include_bytes!("../../../tests/fixtures/archives/metadata.tar");
        let index = inspect_tar(io::Cursor::new(bytes), bytes.len() as u64).unwrap();
        for (name, content) in entries {
            let entry = index.iter().find(|entry| entry.name == name).unwrap();
            assert_eq!(
                &bytes[entry.offset as usize..][..entry.size as usize],
                content
            );
        }
        let truncated = &include_bytes!("../../../tests/fixtures/archives/logs.tar")[..512];
        assert!(inspect_tar(io::Cursor::new(truncated), truncated.len() as u64).is_err());
        assert!(
            visit_tar(truncated, |_, _, _, reader| {
                io::copy(reader, &mut io::sink()).map(|_| ())
            })
            .is_err()
        );
    }
}
