import { createApp, type Env } from "./app.ts";

export { TeamCounter } from "./counter.ts";

const app = createApp();

export default {
  fetch: (request: Request, env: Env, context: ExecutionContext) => app.fetch(request, env, context),
} satisfies ExportedHandler<Env>;
