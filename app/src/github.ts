// Minimal GitHub REST client for the private vault. Talks only to api.github.com (see CSP).
const API = "https://api.github.com";

export interface VaultRef {
  repo: string;
  branch: string;
  token: string;
}

async function gh(ref: VaultRef, path: string, init: RequestInit = {}, accept = "application/vnd.github+json") {
  const res = await fetch(`${API}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: accept,
      Authorization: `Bearer ${ref.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) throw new Error(await explain(res, (init.method ?? "GET") !== "GET"));
  return res;
}

/** Turn a failed response into a message that says what to fix, plus GitHub's own reason. */
export async function explain(res: Response, isWrite: boolean): Promise<string> {
  let reason = "";
  try { reason = String(((await res.json()) as { message?: unknown }).message ?? ""); } catch { /* no JSON body */ }
  const rateLimited = res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(reason);
  const hint =
    rateLimited ? "GitHub rate limit reached. Wait a few minutes and try again" :
    res.status === 401 ? "The token is invalid or expired. Create a new one and set this device up again" :
    isWrite && (res.status === 403 || res.status === 404)
      ? "This token can read the vault but not write to it. Edit the token on GitHub and set Contents to \"Read and write\""
      : res.status === 403 ? "The token isn't allowed to do this. Check it has access to the vault repo" :
    res.status === 404 ? "Vault repo or branch not found, or the token can't see it" :
    res.statusText || "Request failed";
  return `GitHub ${res.status}: ${hint}${reason ? ` (GitHub says: "${reason.slice(0, 200)}")` : ""}`;
}

export interface VaultFile { path: string; sha: string }

/** All encrypted files in the vault (data/ and config/). */
export async function listVault(ref: VaultRef): Promise<VaultFile[]> {
  const res = await gh(ref, `/repos/${ref.repo}/git/trees/${encodeURIComponent(ref.branch)}?recursive=1`);
  const body = (await res.json()) as { tree: { path: string; sha: string; type: string }[]; truncated: boolean };
  if (body.truncated) console.warn("vault tree truncated: compaction needed");
  return body.tree.filter((e) => e.type === "blob" && /^(data|config)\/.+\.age$/.test(e.path));
}

export async function fetchBlob(ref: VaultRef, sha: string): Promise<Uint8Array> {
  const res = await gh(ref, `/repos/${ref.repo}/git/blobs/${sha}`, {}, "application/vnd.github.raw+json");
  return new Uint8Array(await res.arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const WRITABLE = /^(data\/\d{4}\/\d{2}\/[\w.-]+\.age|config\/[\w.-]+\.age)$/;

export class ConflictError extends Error {}

/**
 * Create or update a file. Pass `sha` when updating: GitHub rejects the write if the file
 * changed since (another device saved first), which surfaces as ConflictError.
 * Returns the new blob sha.
 */
export async function putFile(ref: VaultRef, path: string, bytes: Uint8Array, message: string, sha?: string): Promise<string> {
  if (!WRITABLE.test(path)) throw new Error("Refusing to write outside data/ or config/");
  try {
    const res = await gh(ref, `/repos/${ref.repo}/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({ message, content: toBase64(bytes), branch: ref.branch, ...(sha ? { sha } : {}) }),
    });
    return ((await res.json()) as { content: { sha: string } }).content.sha;
  } catch (e) {
    if (/GitHub (409|422)/.test((e as Error).message)) throw new ConflictError("Outcomes were changed on another device. Refresh, then redo your edit.");
    throw e;
  }
}

/** Map with bounded concurrency to stay polite to the API. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}
