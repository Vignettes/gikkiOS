// age envelope helpers. Must stay byte-compatible with vault-template/scripts/envelope.mjs.
import {
  Decrypter,
  Encrypter,
  generateX25519Identity,
  identityToRecipient,
} from "age-encryption";

export const AGE_HEADER = "age-encryption.org/v1\n";
const PAD_BUCKET = 512;
const enc = new TextEncoder();

export const RECIPIENT_RE = /^age1[0-9a-z]+$/;
export const IDENTITY_RE = /^AGE-SECRET-KEY-1[0-9A-Z]+$/;

export async function newIdentity(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

export async function recipientOf(identity: string): Promise<string> {
  if (!IDENTITY_RE.test(identity)) throw new Error("Not an age secret key (AGE-SECRET-KEY-1…)");
  return identityToRecipient(identity);
}

/** JSON-encode, pad to a 512-byte bucket, encrypt to all recipients. */
export async function sealJSON(obj: object, recipients: string[]): Promise<Uint8Array> {
  if (recipients.length === 0) throw new Error("No recipients");
  const base = JSON.stringify({ ...obj, _pad: "" });
  const padLen = (PAD_BUCKET - (enc.encode(base).length % PAD_BUCKET)) % PAD_BUCKET;
  const json = JSON.stringify({ ...obj, _pad: " ".repeat(padLen) });
  const e = new Encrypter();
  for (const r of recipients) e.addRecipient(r);
  return e.encrypt(json);
}

export async function openJSON<T>(ciphertext: Uint8Array, identity: string): Promise<T> {
  const d = new Decrypter();
  d.addIdentity(identity);
  const { _pad, ...rest } = JSON.parse(await d.decrypt(ciphertext, "text"));
  void _pad;
  return rest as T;
}

/** Passphrase-wrap (age scrypt). logN 18 ≈ 1 s on a laptop; lower only in tests. */
export async function wrapWithPassphrase(obj: object, passphrase: string, logN = 18): Promise<Uint8Array> {
  const e = new Encrypter();
  e.setPassphrase(passphrase);
  e.setScryptWorkFactor(logN);
  return e.encrypt(JSON.stringify(obj));
}

export async function unwrapWithPassphrase<T>(blob: Uint8Array, passphrase: string): Promise<T> {
  const d = new Decrypter();
  d.addPassphrase(passphrase);
  return JSON.parse(await d.decrypt(blob, "text")) as T;
}
