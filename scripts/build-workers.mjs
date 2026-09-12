import { build } from "esbuild";
import fs from "fs";
import path from "path";

const workers = [
  { name: "api", entry: "terraform/workers/api/src/index.mjs", output: "terraform/workers/api/dist/index.mjs" },
  { name: "auth", entry: "terraform/workers/auth/src/index.mjs", output: "terraform/workers/auth/dist/index.mjs" },
  { name: "ai", entry: "terraform/workers/ai/src/index.mjs", output: "terraform/workers/ai/dist/index.mjs" },
  { name: "rag", entry: "terraform/workers/rag/index.mjs", output: "terraform/workers/rag/dist/index.mjs" },
  { name: "graph", entry: "terraform/workers/graph/src/index.mjs", output: "terraform/workers/graph/dist/index.mjs" },
];

for (const worker of workers) {
  fs.mkdirSync(path.dirname(worker.output), { recursive: true });

  await build({
    entryPoints: [worker.entry],
    bundle: true,
    format: "esm",
    outfile: worker.output,
    platform: "browser",
    target: "es2022",
  });
  console.log(`✓ Built ${worker.name} worker`);
}
