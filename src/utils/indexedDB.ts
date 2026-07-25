import { openDB, type DBSchema, type IDBPDatabase } from "idb";

interface SettingsDB extends DBSchema {
  settings: {
    key: string;
    value: { key: string; value: string; updatedAt: number };
  };
}

const DB_NAME = "pm2-log-analyzer-settings";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<SettingsDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<SettingsDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
      },
    });
  }
  return dbPromise;
}

/** Persist UI settings only — never store multi‑MB log text here. */
export async function getSetting(key: string, fallback: string): Promise<string> {
  try {
    const db = await getDB();
    const setting = await db.get("settings", key);
    return setting?.value ?? fallback;
  } catch {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  try {
    const db = await getDB();
    await db.put("settings", { key, value, updatedAt: Date.now() });
  } catch {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* quota — ignore */
    }
  }
}

export async function deleteSetting(key: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete("settings", key);
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

/** One-time migration: drop huge log blobs from localStorage. */
export function purgeLegacyLogStorage() {
  const keys = ["pm2_analyzer_logs_v1", "pm2_analyzer_source_v1"];
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}
