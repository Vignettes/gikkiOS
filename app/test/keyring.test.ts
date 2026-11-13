import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { newIdentity } from "../src/crypto";
import { forgetDevice, hasKeyring, type Keyring, saveKeyring, unlockKeyring } from "../src/keyring";

describe("keyring", async () => {
  const { identity, recipient } = await newIdentity();
  const k: Keyring = { identity, recipients: [recipient], repo: "me/gikkiOS-vault", branch: "main", token: "github_pat_x" };

  it("saves wrapped, unlocks, forgets", async () => {
    expect(await hasKeyring()).toBe(false);
    await saveKeyring(k, "a long passphrase", 10);
    expect(await hasKeyring()).toBe(true);
    expect(await unlockKeyring("a long passphrase")).toEqual(k);
    await expect(unlockKeyring("nope nope nope")).rejects.toThrow("Wrong passphrase");
    await forgetDevice();
    expect(await hasKeyring()).toBe(false);
  });

  it("validates input", async () => {
    await expect(saveKeyring({ ...k, token: "ghp_classic" }, "a long passphrase", 10)).rejects.toThrow(/fine-grained/);
    await expect(saveKeyring({ ...k, repo: "nope" }, "a long passphrase", 10)).rejects.toThrow(/owner\/name/);
    await expect(saveKeyring(k, "short", 10)).rejects.toThrow(/12/);
  });
});
