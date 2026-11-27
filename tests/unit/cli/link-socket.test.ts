import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@grenier/core";
import { resolvePaths } from "@grenier/core/node";
import { openSqliteStore } from "@grenier/store/sqlite";
import { describe, expect, it, vi } from "vitest";
import { TeamLink } from "../../../apps/cli/src/link.ts";

describe("the live connection to the team store", () => {
  it("tries again after a refused handshake, without throwing", async () => {
    const home = mkdtempSync(join(tmpdir(), "grenier-link-"));
    const store = openSqliteStore(":memory:");
    let upgrades = 0;
    const server = createServer((_req, res) => res.writeHead(404).end());
    server.on("upgrade", (_req, socket) => {
      upgrades += 1;
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const thrown: unknown[] = [];
    const onError = (error: unknown) => thrown.push(error);
    process.on("uncaughtException", onError);
    const link = new TeamLink(
      {
        url: `http://127.0.0.1:${port}`,
        token: "gt_x",
        fetch: (async () => new Response("", { status: 503 })) as typeof fetch,
      },
      store,
      defaultConfig(),
      resolvePaths({ GRENIER_HOME: home }),
      async () => null,
      () => {},
    );
    link.start();
    await vi.waitFor(() => expect(upgrades).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    link.stop();
    process.off("uncaughtException", onError);
    expect(thrown).toEqual([]);
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });
});
