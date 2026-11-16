import { daemonPid } from "../daemon.ts";
import { environment, type Io, withStore } from "../io.ts";

/** Creates ~/.grenier and the database on first run, then describes them and the daemon. */
export async function status(io: Io, version: string): Promise<string[]> {
  const { paths, config, configFound } = environment(io);
  const schema = await withStore(paths, (store) => store.schemaVersion());
  const pid = daemonPid(paths.home);
  return [
    `grenier ${version}`,
    `config    ${paths.config}${configFound ? "" : " (not found, using defaults)"}`,
    `database  ${paths.db} (schema ${schema})`,
    `proxy     127.0.0.1:${config.proxy.port} → ${config.proxy.upstream_anthropic}`,
    `daemon    ${pid === null ? "stopped" : `running (pid ${pid})`}`,
  ];
}
