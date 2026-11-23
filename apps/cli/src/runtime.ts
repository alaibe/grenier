import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { type Config, newVaultKey } from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import type { Embedder, Identity, StoreDeps } from "@grenier/index";
import type { Store } from "@grenier/store";
import { gitFiles } from "./exploration.ts";

/** This machine's name as the team sees it: `[machine] name`, else its host name made safe. */
export function deviceName(config: Config): string {
  if (config.machine.name) return config.machine.name;
  const name = hostname()
    .replace(/\.local$/, "")
    .replace(/[^\w.-]+/g, "-")
    .slice(0, 40);
  return name || "machine";
}

/** Who writes from here: the team member this device joined as, else this computer's user. */
export async function identity(store: Store, config: Config): Promise<Identity> {
  const member = (await store.state.get("team_member")) ?? userInfo().username.replace(/[^\w.@-]+/g, "-");
  return { member, device: deviceName(config) };
}

/** Where the person's own key for the `me` space is kept, readable by this user only. */
export function personalKeyFile(paths: GrenierPaths): string {
  return join(paths.home, "personal.key");
}

export function personalKey(paths: GrenierPaths): string | null {
  const file = personalKeyFile(paths);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

/** The personal key, made the first time it is needed. Copy it to the person's other machines: `grenier key`. */
export function ensurePersonalKey(paths: GrenierPaths): string {
  const existing = personalKey(paths);
  if (existing) return existing;
  const key = newVaultKey();
  writeFileSync(personalKeyFile(paths), `${key}\n`, { mode: 0o600 });
  return key;
}

/** The `me` space, which every machine has, team or not. */
export async function ensureBaseSpaces(store: Store): Promise<void> {
  if (!(await store.spaces.get("me"))) {
    await store.spaces.put({ id: "me", name: "me", kind: "me", repoId: null, root: null });
  }
}

export async function storeDeps(
  store: Store,
  config: Config,
  embedder: () => Promise<Embedder | null>,
): Promise<StoreDeps> {
  await ensureBaseSpaces(store);
  return { store, files: gitFiles, embedder: await embedder(), me: await identity(store, config) };
}
