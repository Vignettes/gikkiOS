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
  if (!res.ok) {
    const hint =
      res.status === 401 ? "token invalid or expired" :
      res.status === 403 ? "token lacks permission (or rate limited)" :
      res.status === 404 ? "repo/branch not found, or token can't see it" : res.statusText;
    throw new Error(`GitHub ${res.status}: ${hint}`);
  }
  return res;
}

export async function listDataFiles(ref: VaultRef): Promise<{ path: string; sha: string }[]> {
  const res = await gh(ref, `/repos/${ref.repo}/git/trees/${encodeURIComponent(ref.branch)}?recursive=1`);
  const body = (await res.json()) as { tree: { path: string; sha: string; type: string }[]; truncated: boolean };
  if (body.truncated) console.warn("vault tree truncated: compaction needed");
  return body.tree.filter((e) => e.type === "blob" && /^data\/.+\.age$/.test(e.path));
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

export async function putFile(ref: VaultRef, path: string, bytes: Uint8Array, message: string): Promise<void> {
  if (!/^data\/\d{4}\/\d{2}\/[\w.-]+\.age$/.test(path)) throw new Error("Refusing to write outside data/");
  await gh(ref, `/repos/${ref.repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: toBase64(bytes), branch: ref.branch }),
  });
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
