import { test } from "node:test";
import assert from "node:assert/strict";
import { Decrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { sealJSON, parseRecipients, AGE_HEADER } from "./envelope.mjs";
import { validateHealthPayload } from "./ingest-dispatch.mjs";

test("seal round-trips and pads to 512-byte buckets", async () => {
  const id = await generateX25519Identity();
  const rec = await identityToRecipient(id);
  const sealed = await sealJSON({ a: 1 }, [rec]);
  assert.equal(Buffer.from(sealed.subarray(0, AGE_HEADER.length)).toString(), AGE_HEADER);
  const d = new Decrypter(); d.addIdentity(id);
  const text = await d.decrypt(sealed, "text");
  assert.equal(Buffer.byteLength(text) % 512, 0);
  assert.equal(JSON.parse(text).a, 1);
});

test("encrypts to every recipient", async () => {
  const ids = [await generateX25519Identity(), await generateX25519Identity()];
  const recs = await Promise.all(ids.map(identityToRecipient));
  const sealed = await sealJSON({ x: "y" }, recs);
  for (const id of ids) {
    const d = new Decrypter(); d.addIdentity(id);
    assert.equal(JSON.parse(await d.decrypt(sealed, "text")).x, "y");
  }
});

test("parseRecipients rejects junk", () => {
  assert.throws(() => parseRecipients(""));
  assert.throws(() => parseRecipients("AGE-SECRET-KEY-1ABC"));
  assert.deepEqual(parseRecipients("# laptop\nage1abc\n\nage1def # paper"), ["age1abc", "age1def"]);
});

test("health payload validation", () => {
  const pts = validateHealthPayload({ d: "2026-11-13", m: { rhr: "57", steps: 9001, hrv: "" } });
  assert.deepEqual(pts.map((p) => p.metric), ["health.rhr", "health.steps"]);
  assert.throws(() => validateHealthPayload({ d: "2026-11-13", m: { ssn: 1 } }), /unknown metric/);
  assert.throws(() => validateHealthPayload({ d: "2026-11-13", m: { rhr: 999 } }), /out of range/);
  assert.throws(() => validateHealthPayload({ d: "13/11/2026", m: { rhr: 60 } }), /YYYY-MM-DD/);
});
