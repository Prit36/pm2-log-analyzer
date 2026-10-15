export const ARCHIVE_EXTENSIONS = ["zip", "gz", "rar", "7z", "tar", "tgz", "tbz", "tbz2", "txz"];

export const ARCHIVE_ACCEPT =
  ".zip,.gz,.rar,.7z,.tar,.tgz,.tar.gz,.tar.bz2,.tbz,.tbz2,.tar.xz,.txz,application/zip,application/x-zip-compressed,application/gzip,application/x-rar-compressed,application/vnd.rar,application/x-7z-compressed,application/x-tar";

export function isArchiveName(name: string): boolean {
  return /\.(?:zip|gz|rar|7z|tar|tgz|tbz2?|txz|tar\.bz2|tar\.xz)$/i.test(name);
}

export function isMultiFormatArchive(name: string): boolean {
  return /\.(?:rar|7z|tar|tgz|tbz2?|txz|tar\.(?:gz|bz2|xz))$/i.test(name);
}

export function archiveSuffix(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) return ".zip";
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return ".gz";
  if (bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21)
    return ".rar";
  if (
    bytes[0] === 0x37 &&
    bytes[1] === 0x7a &&
    bytes[2] === 0xbc &&
    bytes[3] === 0xaf &&
    bytes[4] === 0x27 &&
    bytes[5] === 0x1c
  )
    return ".7z";
  if (bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) return ".bz2";
  if (
    bytes[0] === 0xfd &&
    bytes[1] === 0x37 &&
    bytes[2] === 0x7a &&
    bytes[3] === 0x58 &&
    bytes[4] === 0x5a &&
    bytes[5] === 0x00
  )
    return ".xz";
  if (
    bytes[257] === 0x75 &&
    bytes[258] === 0x73 &&
    bytes[259] === 0x74 &&
    bytes[260] === 0x61 &&
    bytes[261] === 0x72
  )
    return ".tar";
  return null;
}
