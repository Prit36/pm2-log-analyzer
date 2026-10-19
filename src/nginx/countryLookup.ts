// Loaded only when the Clients tab is opened. Both assets ship with the app.
const data = await Promise.all(
  [
    new URL("./data/country-ipv4.bin", import.meta.url),
    new URL("./data/country-ipv6.bin", import.meta.url),
  ].map(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Offline country database unavailable");
    return new DataView(await response.arrayBuffer());
  }),
).catch(() => null);

const names = new Intl.DisplayNames(["en"], { type: "region" });
export const countryDatabaseAvailable = data !== null;

function ipv4Number(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))
    return null;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}

function privateV4(value: number): boolean {
  const a = Math.floor(value / 0x1000000);
  const b = Math.floor(value / 0x10000) % 256;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function ipv6Number(ip: string): bigint | null {
  // URL's IPv6 parser validates and canonicalizes compression and IPv4 tails.
  try {
    const host = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left = "", right] = host.split("::");
    const start = left ? left.split(":") : [];
    const end = right ? right.split(":") : [];
    const groups =
      right === undefined
        ? start
        : [...start, ...Array<string>(8 - start.length - end.length).fill("0"), ...end];
    return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
  } catch {
    return null;
  }
}

function countryAt(view: DataView, offset: number): string {
  const code = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1));
  return names.of(code) ?? code;
}

function lookupV4(value: number): string {
  if (privateV4(value)) return "Private / reserved";
  const view = data?.[0];
  if (!view) return "Unavailable";
  let low = 0;
  let high = view.byteLength / 10 - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const offset = middle * 10;
    if (value < view.getUint32(offset)) high = middle - 1;
    else if (value > view.getUint32(offset + 4)) low = middle + 1;
    else return countryAt(view, offset + 8);
  }
  return "Unknown";
}

export function lookupCountry(ip: string): string {
  if (!ip.includes(":")) {
    const value = ipv4Number(ip);
    return value === null ? "Unknown" : lookupV4(value);
  }
  const value = ipv6Number(ip);
  if (value === null) return "Unknown";
  if (value >> 32n === 0xffffn) return lookupV4(Number(value & 0xffffffffn));
  if (value <= 1n || value >> 121n === 0x7en || value >> 118n === 0x3fan || value >> 120n === 0xffn)
    return "Private / reserved";
  const view = data?.[1];
  if (!view) return "Unavailable";
  let low = 0;
  let high = view.byteLength / 34 - 1;
  const address = (offset: number) =>
    (view.getBigUint64(offset) << 64n) | view.getBigUint64(offset + 8);
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const offset = middle * 34;
    if (value < address(offset)) high = middle - 1;
    else if (value > address(offset + 16)) low = middle + 1;
    else return countryAt(view, offset + 32);
  }
  return "Unknown";
}
