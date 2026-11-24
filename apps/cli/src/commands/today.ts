import { buildReport, formatToday, loadPrices, startOfToday } from "@grenier/log";
import { environment, type Io, withStore } from "../io.ts";

/** `grenier today`: today's spend per project, the lines the app's menu bar shows. */
export async function today(io: Io, now = Date.now()): Promise<string> {
  const { paths, config } = environment(io);
  return withStore(paths, async (store) =>
    formatToday(buildReport(await store.usage.list({ since: startOfToday(now) }), "repo", loadPrices(config.prices))),
  );
}
