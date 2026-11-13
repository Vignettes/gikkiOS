import { describe, expect, it } from "vitest";
import { Decrypter } from "age-encryption";
import { AGE_HEADER, newIdentity, openJSON, recipientOf, sealJSON, unwrapWithPassphrase, wrapWithPassphrase } from "../src/crypto";
// @ts-expect-error: plain JS module from the vault template
import { sealJSON as vaultSeal } from "../../vault-template/scripts/envelope.mjs";

describe("crypto", () => {
  it("round-trips and pads to 512-byte buckets", async () => {
    const { identity, recipient } = await newIdentity();
    const ct = await sealJSON({ hello: "world" }, [recipient]);
    expect(new TextDecoder().decode(ct.subarray(0, AGE_HEADER.length))).toBe(AGE_HEADER);
    const d = new Decrypter(); d.addIdentity(identity);
    expect(new TextEncoder().encode(await d.decrypt(ct, "text")).length % 512).toBe(0);
    expect(await openJSON(ct, identity)).toEqual({ hello: "world" });
  });

  it("reads files sealed by the vault's ingest script", async () => {
    const { identity, recipient } = await newIdentity();
    const ct = await vaultSeal({ v: 1, points: [] }, [recipient]);
    expect(await openJSON(ct, identity)).toEqual({ v: 1, points: [] });
  });

  it("a different key cannot decrypt", async () => {
    const a = await newIdentity(), b = await newIdentity();
    await expect(openJSON(await sealJSON({ x: 1 }, [a.recipient]), b.identity)).rejects.toThrow();
  });

  it("derives recipient and rejects non-keys", async () => {
    const { identity, recipient } = await newIdentity();
    expect(await recipientOf(identity)).toBe(recipient);
    await expect(recipientOf("age1abc")).rejects.toThrow(/secret key/);
  });

  it("passphrase wrap", async () => {
    const blob = await wrapWithPassphrase({ s: 1 }, "correct horse battery", 10);
    expect(await unwrapWithPassphrase(blob, "correct horse battery")).toEqual({ s: 1 });
    await expect(unwrapWithPassphrase(blob, "wrong")).rejects.toThrow();
  });
});
