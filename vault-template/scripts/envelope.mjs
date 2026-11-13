// Shared encryption envelope for the vault. Plaintext exists only in memory.
import { Encrypter } from "age-encryption";

export const AGE_HEADER = "age-encryption.org/v1\n";
const PAD_BUCKET = 512; // bytes: hides exact payload size

/** Parse newline-separated age recipients (comments and blanks allowed). */
export function parseRecipients(text) {
  const list = (text ?? "")
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);
  if (list.length === 0) throw new Error("AGE_RECIPIENTS is empty");
  for (const r of list) {
    if (!/^age1[0-9a-z]+$/.test(r)) throw new Error("AGE_RECIPIENTS contains a malformed recipient");
  }
  return list;
}

/** JSON-encode `obj`, pad to a bucket boundary, encrypt to every recipient. */
export async function sealJSON(obj, recipients) {
  const base = JSON.stringify({ ...obj, _pad: "" });
  const padLen = (PAD_BUCKET - (Buffer.byteLength(base) % PAD_BUCKET)) % PAD_BUCKET;
  const json = JSON.stringify({ ...obj, _pad: " ".repeat(padLen) });
  const e = new Encrypter();
  for (const r of recipients) e.addRecipient(r);
  return e.encrypt(json);
}
