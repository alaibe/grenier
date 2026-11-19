import { daemonState } from "../daemon.ts";
import { environment, type Io, withStore } from "../io.ts";

/** Creates ~/.grenier and the database on first run, then describes them and the daemon. */
export async function status(io: Io, version: string): Promise<string[]> {
  const { paths, config, configFound } = environment(io);
  const schema = await withStore(paths, (store) => store.schemaVersion());
  const daemon = await daemonState(paths.home, config.proxy.port);
  const running =
    daemon.state === "running"
      ? `running (pid ${daemon.pid}, port ${daemon.port}${daemon.version && daemon.version !== version ? `, version ${daemon.version}: restart it to use ${version}` : ""})`
      : daemon.state === "stale"
        ? `stopped (its record names pid ${daemon.pid}, now another program's)`
        : "stopped";
  return [
    `grenier ${version}`,
    `config    ${paths.config}${configFound ? "" : " (not found, using defaults)"}`,
    `database  ${paths.db} (schema ${schema})`,
    `proxy     127.0.0.1:${config.proxy.port} → ${config.proxy.upstream_anthropic}`,
    `daemon    ${running}`,
  ];
}
