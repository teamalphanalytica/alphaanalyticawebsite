export async function resolve(spec, ctx, next) {
  if (spec === "@netlify/database") return { url: new URL("./db-shim.mjs", import.meta.url).href, shortCircuit: true };
  if (spec === "@netlify/identity") return { url: new URL("./id-shim.mjs", import.meta.url).href, shortCircuit: true };
  return next(spec, ctx);
}
