import { json } from "./lib/response.mjs";

export default {
  async fetch(request, env, ctx) {
    return json({ service: "api", environment: env.ENVIRONMENT ?? "unknown" });
  },
};
