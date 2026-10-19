import { create } from "zustand";

/**
 * Client IP → country / network lookups through the free country.is API
 * (MaxMind GeoLite2 data, no key, commercial use allowed, 100 IPs per request).
 * Private and reserved addresses are classified locally and never sent.
 */
const ENDPOINT = "https://api.country.is/?fields=asn";
const BATCH = 100;

export type IpInfo =
  | { kind: "public"; country: string | null; asn: number | null; org: string | null }
  | { kind: "private" }
  | { kind: "invalid" };

type LookupResponse = {
  ip: string;
  country?: string | null;
  asn?: { number?: number | null; organization?: string | null } | null;
}[];

type IpInfoState = {
  infos: Record<string, IpInfo>;
  loading: number;
  error: string | null;
};

export const useIpInfoStore = create<IpInfoState>()(() => ({
  infos: {},
  loading: 0,
  error: null,
}));

const inFlight = new Set<string>();
let lastRequested: string[] = [];

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

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

/** Local classification: only "public" addresses are worth sending to the API. */
function classify(ip: string): "public" | "private" | "invalid" {
  if (!ip.includes(":")) {
    const value = ipv4Number(ip);
    if (value === null) return "invalid";
    return privateV4(value) ? "private" : "public";
  }
  const value = ipv6Number(ip);
  if (value === null) return "invalid";
  if (value >> 32n === 0xffffn)
    return privateV4(Number(value & 0xffffffffn)) ? "private" : "public";
  if (value <= 1n || value >> 121n === 0x7en || value >> 118n === 0x3fan || value >> 120n === 0xffn)
    return "private";
  return "public";
}

async function fetchBatch(ips: string[]): Promise<Record<string, IpInfo>> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ips),
  });
  if (response.status === 429) throw new Error("country.is rate limit reached — retry shortly");
  if (!response.ok) throw new Error(`country.is lookup failed (HTTP ${response.status})`);
  // SAFETY: country.is returns this documented array shape; fields are read defensively below.
  const rows = (await response.json()) as LookupResponse;
  const found = new Map(rows.map((row) => [String(row.ip).toLowerCase(), row]));
  const out: Record<string, IpInfo> = {};
  for (const ip of ips) {
    const row = found.get(ip.toLowerCase());
    out[ip] = {
      kind: "public",
      country: row?.country ? String(row.country) : null,
      asn: Number.isFinite(row?.asn?.number) ? Number(row?.asn?.number) : null,
      org: row?.asn?.organization ? String(row.asn.organization) : null,
    };
  }
  return out;
}

/** Resolves every address not yet known; cached for the session only. */
export async function resolveIps(values: string[]): Promise<void> {
  lastRequested = values;
  const { infos } = useIpInfoStore.getState();
  const local: Record<string, IpInfo> = {};
  const remote: string[] = [];
  for (const value of values) {
    if (infos[value] || inFlight.has(value)) continue;
    const kind = classify(value);
    if (kind === "public") remote.push(value);
    else local[value] = { kind };
  }
  if (Object.keys(local).length > 0)
    useIpInfoStore.setState((s) => ({ infos: { ...s.infos, ...local } }));
  if (remote.length === 0) return;
  for (const ip of remote) inFlight.add(ip);
  useIpInfoStore.setState((s) => ({ loading: s.loading + remote.length, error: null }));
  for (let start = 0; start < remote.length; start += BATCH) {
    const batch = remote.slice(start, start + BATCH);
    try {
      const resolved = await fetchBatch(batch);
      useIpInfoStore.setState((s) => ({
        infos: { ...s.infos, ...resolved },
        loading: s.loading - batch.length,
      }));
    } catch (error) {
      const rest = remote.slice(start);
      for (const ip of rest) inFlight.delete(ip);
      useIpInfoStore.setState((s) => ({
        loading: s.loading - rest.length,
        error:
          // fetch rejects with TypeError both offline and when an extension blocks the request.
          error instanceof TypeError
            ? navigator.onLine
              ? "Request to api.country.is was blocked — an ad or privacy blocker may be blocking it; allow that domain to see locations"
              : "Country lookup needs a network connection"
            : error instanceof Error
              ? error.message
              : String(error),
      }));
      return;
    } finally {
      for (const ip of batch) inFlight.delete(ip);
    }
  }
}

export function retryIpLookup(): void {
  void resolveIps(lastRequested);
}
