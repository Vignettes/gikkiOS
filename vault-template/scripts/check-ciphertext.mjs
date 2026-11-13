// Fails if any file under data/ or config/ is not an age-encrypted file.
import { readdir, open } from "node:fs/promises";
import { join } from "node:path";
import { AGE_HEADER } from "./envelope.mjs";

const ALLOWED_PLAINTEXT = new Set([".gitkeep"]);

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

let bad = 0;
for (const root of ["data", "config"]) {
  for await (const f of walk(root)) {
    if (ALLOWED_PLAINTEXT.has(f.split("/").pop())) continue;
    const fh = await open(f, "r");
    const buf = Buffer.alloc(AGE_HEADER.length);
    await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    if (!f.endsWith(".age") || buf.toString() !== AGE_HEADER) { console.error(`NOT CIPHERTEXT: ${f}`); bad++; }
  }
}
if (bad) { console.error(`${bad} plaintext file(s) found. Remove them and rotate anything they exposed.`); process.exit(1); }
console.log("ok: all vault files are age ciphertext");
