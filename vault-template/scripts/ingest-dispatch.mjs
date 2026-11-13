// Ingest one Apple Health daily payload from a repository_dispatch event.
// Never logs payload values: errors name fields only.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { parseRecipients, sealJSON } from "./envelope.mjs";

// Allowlist: metric -> [unit, min, max]. Anything else is rejected.
export const HEALTH_METRICS = {
  steps:        ["count", 0, 200000],
  rhr:          ["bpm", 20, 250],
  hrv:          ["ms", 0, 500],
  sleep_h:      ["h", 0, 24],
  weight_kg:    ["kg", 20, 400],
  body_fat_pct: ["%", 1, 80],
  active_kcal:  ["kcal", 0, 20000],
  exercise_min: ["min", 0, 1440],
  workouts:     ["count", 0, 50],
};

export function validateHealthPayload(p) {
  if (!p || typeof p !== "object") throw new Error("client_payload missing");
  if (typeof p.d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.d) || isNaN(Date.parse(p.d)))
    throw new Error("field d must be YYYY-MM-DD");
  if (!p.m || typeof p.m !== "object") throw new Error("field m must be an object");
  const points = [];
  for (const [k, raw] of Object.entries(p.m)) {
    const spec = HEALTH_METRICS[k];
    if (!spec) throw new Error(`unknown metric: ${k}`);
    if (raw === null || raw === "") continue; // Shortcut sends blanks for missing samples
    const value = Number(raw);
    const [unit, min, max] = spec;
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`metric ${k} out of range`);
    points.push({ metric: `health.${k}`, t: p.d, value, unit });
  }
  if (points.length === 0) throw new Error("no metrics in payload");
  return points;
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const points = validateHealthPayload(event.client_payload);
  const recipients = parseRecipients(process.env.AGE_RECIPIENTS);
  const sealed = await sealJSON(
    { v: 1, source: "apple_health", kind: "auto", ingested_at: new Date().toISOString(), points },
    recipients,
  );
  const [y, m, d] = points[0].t.split("-");
  const dir = `data/${y}/${m}`;
  const path = `${dir}/${d}-apple_health-${process.env.GITHUB_RUN_ID ?? Date.now()}.age`;
  await mkdir(dir, { recursive: true });
  await writeFile(path, sealed);
  console.log(`sealed ${points.length} point(s) -> ${path}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`ingest failed: ${e.message}`); process.exit(1); });
}
