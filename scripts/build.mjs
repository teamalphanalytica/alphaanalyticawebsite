// Bundles the portal's browser code (it imports @netlify/identity) into public/portal/app.js
import { build } from "esbuild";

await build({
  entryPoints: ["src/portal/app.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2020",
  outfile: "public/portal/app.js",
  logLevel: "info",
});
