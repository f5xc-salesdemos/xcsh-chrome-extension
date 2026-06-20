import * as fs from "node:fs";

await Bun.build({
  entrypoints: ["src/accessibility-tree.ts"],
  outdir: "dist",
  target: "browser",
  minify: false,
});

await Bun.build({
  entrypoints: ["src/service-worker.ts"],
  outdir: "dist",
  target: "browser",
  minify: false,
  format: "esm",
});

await Bun.build({
  entrypoints: ["src/agent-visual-indicator.ts"],
  outdir: "dist",
  target: "browser",
  minify: false,
});

await Bun.build({
  entrypoints: ["src/options.ts"],
  outdir: "dist",
  target: "browser",
  minify: false,
});

fs.copyFileSync("manifest.json", "dist/manifest.json");
fs.copyFileSync("managed_schema.json", "dist/managed_schema.json");
fs.copyFileSync("src/options.html", "dist/options.html");

// Copy branded icons.
fs.mkdirSync("dist/icons", { recursive: true });
for (const s of [16, 48, 128]) {
  fs.copyFileSync(`icons/icon-${s}.png`, `dist/icons/icon-${s}.png`);
}

console.log("built dist/");
