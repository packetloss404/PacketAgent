import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(process.cwd());
const outdir = resolve(root, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await build({
  entryPoints: {
    server: resolve(root, "src", "server.ts"),
    "generated-app-runtime/server-worker": resolve(
      root,
      "src",
      "generated-app-runtime",
      "server-worker.ts",
    ),
  },
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  sourcemap: true,
  sourcesContent: true,
  entryNames: "[dir]/[name]",
  chunkNames: "chunks/[name]-[hash]",
  metafile: true,
  logLevel: "info",
});

await mkdir(resolve(outdir, "generated-app-publish-runtime"), { recursive: true });
await cp(
  resolve(root, "src", "generated-app-publish-runtime", "server.mjs"),
  resolve(outdir, "generated-app-publish-runtime", "server.mjs"),
);

const outputs = Object.keys(result.metafile.outputs).sort();
await writeFile(
  resolve(outdir, "build-manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: "packetagent.production-build/v1",
      target: "node22",
      format: "esm",
      entrypoints: ["server.js", "generated-app-runtime/server-worker.js"],
      sourceMaps: outputs.filter((path) => path.endsWith(".map")),
      outputs,
      optionalRuntimeImports: ["playwright"],
    },
    null,
    2,
  )}\n`,
  "utf8",
);
