// The keyring is everything secret on this device, stored only passphrase-wrapped in IndexedDB.
import { RECIPIENT_RE, unwrapWithPassphrase, wrapWithPassphrase } from "./crypto";

export interface Keyring {
  identity: string;       // AGE-SECRET-KEY-1…  (never leaves the device unencrypted)
  recipients: string[];   // all age1… keys new data is encrypted to (incl. this device's)
  repo: string;           // owner/name of the private vault
  branch: string;
  token: string;          // fine-grained PAT, vault repo only
}

const DB = "gikkios";
const STORE = "kv";
const KEY = "keyring.age";

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const r = fn(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export function validateKeyring(k: Keyring): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(k.repo)) throw new Error("Vault repo must look like owner/name");
  if (!k.token.startsWith("github_pat_")) throw new Error("Use a fine-grained token (starts with github_pat_)");
  if (k.recipients.length === 0) throw new Error("At least one recipient is required");
  for (const r of k.recipients) if (!RECIPIENT_RE.test(r)) throw new Error(`Malformed recipient: ${r.slice(0, 12)}…`);
}

export async function hasKeyring(): Promise<boolean> {
  return (await tx("readonly", (s) => s.get(KEY))) !== undefined;
}

export async function saveKeyring(k: Keyring, passphrase: string, logN?: number): Promise<void> {
  validateKeyring(k);
  if (passphrase.length < 12) throw new Error("Passphrase must be at least 12 characters");
  const blob = await wrapWithPassphrase(k, passphrase, logN);
  await tx("readwrite", (s) => s.put(blob, KEY));
}

export async function unlockKeyring(passphrase: string): Promise<Keyring> {
  const blob = (await tx("readonly", (s) => s.get(KEY))) as Uint8Array | undefined;
  if (!blob) throw new Error("No keyring on this device");
  try {
    return await unwrapWithPassphrase<Keyring>(new Uint8Array(blob), passphrase);
  } catch {
    throw new Error("Wrong passphrase");
  }
}

export async function forgetDevice(): Promise<void> {
  await tx("readwrite", (s) => s.delete(KEY));
}
