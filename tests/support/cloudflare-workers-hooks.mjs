// Node ESM loader hooks that resolve the "cloudflare:workers" builtin (only available
// inside the workerd runtime) to a minimal in-repo shim, so `node --test` can import
// workers written as `WorkerEntrypoint` subclasses without pulling in Miniflare/wrangler.
// Registered via tests/support/register.mjs (see package.json "test" script).
const SHIM_URL = "cloudflare-workers-shim:main";

const SHIM_SOURCE = `
  export class WorkerEntrypoint {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
    }
  }
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: SHIM_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === SHIM_URL) {
    return { format: "module", shortCircuit: true, source: SHIM_SOURCE };
  }
  return nextLoad(url, context);
}
