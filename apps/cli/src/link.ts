import type { Config } from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import { type Embedder, type SyncResult, syncOnce, type TeamClient, teamApi } from "@grenier/index";
import type { Store } from "@grenier/store";
import { personalKey } from "./runtime.ts";

/** The daemon's link to the team store; offline, the local copy carries on alone. */
export class TeamLink {
  #syncing: Promise<SyncResult | null> | null = null;
  #again = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #socket: WebSocket | null = null;
  #closed = false;
  #lastError = "";
  #retry = 1000;
  #known = 0;
  listeners: ((result: SyncResult) => void)[] = [];

  constructor(
    readonly team: TeamClient,
    readonly store: Store,
    readonly config: Config,
    readonly paths: GrenierPaths,
    readonly embedder: () => Promise<Embedder | null>,
    readonly log: (line: string) => void,
  ) {}

  start(): void {
    this.#timer = setInterval(() => void this.sync(), this.config.team.sync_interval * 1000);
    void this.sync();
    this.#connect();
  }

  stop(): void {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#socket?.close();
  }

  /** One round now, or right after the one running; `before` runs first, while no round runs. */
  sync(before?: () => Promise<void>): Promise<SyncResult | null> {
    if (this.#syncing !== null) {
      // A round in flight writes the cursor after each page: `before` waits for it to end.
      if (before) return this.#syncing.catch(() => null).then(() => this.sync(before));
      this.#again = true;
      return this.#syncing;
    }
    this.#syncing = (async () => {
      await before?.();
      return this.#round();
    })().finally(() => {
      this.#syncing = null;
      if (this.#again) {
        this.#again = false;
        void this.sync();
      }
    });
    return this.#syncing;
  }

  async #round(): Promise<SyncResult | null> {
    try {
      const result = await syncOnce({
        store: this.store,
        team: this.team,
        embedder: await this.embedder(),
        personalKey: personalKey(this.paths),
      });
      for (const refused of result.refused) {
        this.log(`grenier: the team store refused a change to ${refused.recordId}, dropped: ${refused.reason}`);
      }
      if (this.#lastError) this.log("grenier: team sync works again");
      this.#lastError = "";
      for (const listener of this.listeners) listener(result);
      return result;
    } catch (error) {
      const message = (error as Error).message;
      if (message !== this.#lastError) this.log(`grenier: team sync failed, will retry: ${message}`);
      this.#lastError = message;
      return null;
    }
  }

  /** The live connection; it comes back after a growing pause when it drops. */
  #connect(): void {
    if (this.#closed || typeof WebSocket === "undefined") return;
    const url = new URL("/api/live", this.team.url);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, ["grenier", this.team.token]);
    } catch {
      return;
    }
    this.#socket = socket;
    socket.addEventListener("open", () => {
      this.#retry = 1000;
    });
    socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data)) as { type?: string; version?: number };
        if (data.type === "version" && typeof data.version === "number" && data.version !== this.#known) {
          this.#known = data.version;
          void this.sync();
        }
      } catch {
        // A message this version does not know.
      }
    });
    let dropped = false;
    const drop = () => {
      if (dropped) return;
      dropped = true;
      if (this.#socket === socket) this.#socket = null;
      if (this.#closed) return;
      this.#reconnect = setTimeout(() => this.#connect(), this.#retry);
      this.#retry = Math.min(this.#retry * 2, 60_000);
    };
    socket.addEventListener("close", drop);
    // Node's WebSocket fires no close after a refused handshake, and close() there fires error again.
    socket.addEventListener("error", drop);
  }

  /** Tells the store this machine's state over the live connection, else over HTTP. */
  async tell(state: Record<string, unknown>): Promise<void> {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify({ type: "state", ...state }));
      return;
    }
    await teamApi(this.team, "/api/machines/me", { method: "PUT", body: state }).catch(() => undefined);
  }
}
