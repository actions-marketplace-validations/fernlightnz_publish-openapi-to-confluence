import { build } from "esbuild";
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/index.mjs",
  // Some CommonJS dependencies call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: "none",
});
