// Walk dist/ after vite build and emit .br + .gz siblings for compressible
// files. main.ts's serveStatic picks the best encoding the client accepts.
// We precompute at build time (not at request time) because the add-on runs
// on whatever Pi the user has, and brotli-on-every-request at level 11 would
// burn the CPU on a constrained host.

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const DIST = new URL("../dist/", import.meta.url).pathname;
const COMPRESSIBLE = /\.(html|js|mjs|css|svg|json|map|wasm)$/i;
// Don't bother compressing anything under this — the gzip/brotli framing
// overhead (~20 bytes) eats the saving and the smaller the file the less
// the compressor has to work with anyway.
const MIN_BYTES = 1024;

async function* walk(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(path);
    else if (ent.isFile()) yield path;
  }
}

let kept = 0;
let bytesIn = 0;
let bytesGz = 0;
let bytesBr = 0;

for await (const path of walk(DIST)) {
  if (!COMPRESSIBLE.test(path)) continue;
  const st = await stat(path);
  if (st.size < MIN_BYTES) continue;
  const buf = await readFile(path);
  const gz = gzipSync(buf, { level: 9 });
  const br = brotliCompressSync(buf, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
  // Only emit a precompressed sibling if it's actually smaller than the
  // original (small text files with high entropy can grow under gzip).
  if (gz.length < buf.length) {
    await writeFile(`${path}.gz`, gz);
    bytesGz += gz.length;
  }
  if (br.length < buf.length) {
    await writeFile(`${path}.br`, br);
    bytesBr += br.length;
  }
  kept++;
  bytesIn += buf.length;
  console.log(
    `  ${relative(DIST, path).padEnd(50)} ${(buf.length / 1024).toFixed(1)} KB → gz ${(gz.length / 1024).toFixed(1)} KB · br ${(br.length / 1024).toFixed(1)} KB`,
  );
}

const fmt = (b) => `${(b / 1024).toFixed(1)} KB`;
console.log(
  `\n${kept} file(s) precompressed: ${fmt(bytesIn)} → gz ${fmt(bytesGz)} (${((1 - bytesGz / bytesIn) * 100).toFixed(0)}%) · br ${fmt(bytesBr)} (${((1 - bytesBr / bytesIn) * 100).toFixed(0)}%)`,
);
