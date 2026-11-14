import { describe, expect, it } from "vitest";
import { explain } from "../src/github";

const res = (status: number, body?: object, headers: Record<string, string> = {}) =>
  new Response(body ? JSON.stringify(body) : null, { status, headers });

describe("GitHub error messages", () => {
  it("403 on write points at the Contents permission and keeps GitHub's reason", async () => {
    const m = await explain(res(403, { message: "Resource not accessible by personal access token" }), true);
    expect(m).toMatch(/^GitHub 403: This token can read the vault but not write to it\. .*Read and write/);
    expect(m).toContain('GitHub says: "Resource not accessible by personal access token"');
  });
  it("404 on write means the same thing (GitHub hides repos it won't let you write)", async () => {
    expect(await explain(res(404, { message: "Not Found" }), true)).toMatch(/can read the vault but not write/);
  });
  it("reads, auth and rate limits", async () => {
    expect(await explain(res(404), false)).toMatch(/not found/);
    expect(await explain(res(401, { message: "Bad credentials" }), false)).toMatch(/invalid or expired/);
    expect(await explain(res(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" }), true)).toMatch(/rate limit/);
  });
});
