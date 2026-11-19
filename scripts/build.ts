// One self-contained binary: daemon + bundled UI (HTML import, Tailwind).
import tailwind from "bun-plugin-tailwind";

const t0 = performance.now();
const out = process.argv[2] ?? "dist/keel";
// Another platform's binary: bun-linux-x64, bun-darwin-arm64, ...
const target = process.argv[3] as Bun.Build.Target | undefined;
const res = await Bun.build({
  entrypoints: ["src/main.ts"],
  compile: target ? { outfile: out, target } : { outfile: out },
  minify: true,
  sourcemap: "none",
  plugins: [tailwind],
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!res.success) {
  for (const l of res.logs) console.error(l);
  process.exit(1);
}
console.log(`built ${out} in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
