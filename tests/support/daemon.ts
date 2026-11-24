import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolvePaths } from "@grenier/core/node";

/** `grenier daemon` started as the app starts it, once it answers; `stop` ends it. */
export async function startDaemon(
  binary: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const child = spawn(binary, ["daemon"], { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
  let said = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    said += chunk.toString();
  });
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  };
  const info = resolvePaths(env).daemonInfo;
  for (let waited = 0; waited < 20_000; waited += 100) {
    if (existsSync(info)) {
      const recorded = JSON.parse(readFileSync(info, "utf8")) as { pid: number; port: number };
      if (recorded.pid === child.pid) return { port: recorded.port, stop };
    }
    if (child.exitCode !== null) throw new Error(`the daemon exited: ${said}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error(`the daemon did not start: ${said}`);
}
