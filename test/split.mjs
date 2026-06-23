// Unit test for the bundle-splitting helper (no browser, no MCP server).
// Verifies splitIntoParts cuts a file into ≤partBytes parts that rejoin byte-for-byte.
// Run: npm run build && node test/split.mjs
import { splitIntoParts, SPLIT_PART_BYTES } from "../dist/storage.js";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

let failures = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? "✅" : "❌"} ${msg}`);
  if (!cond) failures++;
};

const dir = await mkdtemp(path.join(tmpdir(), "har-split-"));
try {
  // --- splits an oversized file into ≤partBytes parts that rejoin exactly ---
  const partBytes = 1000;
  const data = randomBytes(3500); // 4 parts: 1000 + 1000 + 1000 + 500
  const file = path.join(dir, "bundle.zip");
  await writeFile(file, data);

  const parts = await splitIntoParts(file, partBytes);
  assert(parts.length === 4, `4 parti per 3500/1000 byte (trovate ${parts.length})`);
  assert(
    JSON.stringify(parts) ===
      JSON.stringify(["bundle.zip.001", "bundle.zip.002", "bundle.zip.003", "bundle.zip.004"]),
    "parti nominate <file>.001..004 in ordine",
  );

  const sizes = [];
  for (const p of parts) sizes.push((await stat(path.join(dir, p))).size);
  assert(sizes.every((s) => s <= partBytes), `ogni parte ≤ ${partBytes} byte (${sizes.join(",")})`);
  assert(sizes.reduce((a, b) => a + b, 0) === data.length, "la somma delle parti = dimensione originale");

  // reconstruct: cat the parts back together and compare byte-for-byte
  const chunks = [];
  for (const p of parts) chunks.push(await readFile(path.join(dir, p)));
  assert(Buffer.concat(chunks).equals(data), "ricostruzione byte-per-byte identica all'originale");

  // --- a file at/under the limit is NOT split ---
  const small = path.join(dir, "small.zip");
  await writeFile(small, randomBytes(partBytes));
  const none = await splitIntoParts(small, partBytes);
  assert(none.length === 0, "file ≤ limite: nessuno split (0 parti)");

  // --- sanity on the real transfer cap ---
  assert(SPLIT_PART_BYTES <= 20 * 1000 * 1000, "SPLIT_PART_BYTES ≤ 20 MB (limite transfer)");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nSPLIT PASS" : `\nSPLIT FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
