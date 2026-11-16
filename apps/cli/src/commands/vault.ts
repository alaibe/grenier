import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newVaultKey, open, seal, VaultError } from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import { vaultPull, vaultPush } from "@grenier/index";
import type { Store } from "@grenier/store";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";
import { teamClient } from "../team.ts";

export function vaultKeyFile(paths: GrenierPaths): string {
  return join(paths.home, "vault.key");
}

/** This machine's vault key, or null before `grenier vault init` or `join`. */
export function vaultKey(paths: GrenierPaths): string | null {
  return existsSync(vaultKeyFile(paths)) ? readFileSync(vaultKeyFile(paths), "utf8").trim() : null;
}

/** A random id for this device, made once. */
export async function deviceId(store: Store): Promise<string> {
  const existing = await store.team.get("device_id");
  if (existing) return existing;
  const id = crypto.randomUUID().slice(0, 8);
  await store.team.set("device_id", id);
  return id;
}

/** `grenier vault init|key|join <key>|sync`: end-to-end encrypted sync of memories and sources between devices. */
export async function vault(argv: string[], io: Io): Promise<string[]> {
  const [action, value] = argv;
  const { paths, config } = environment(io);
  const keyFile = vaultKeyFile(paths);

  switch (action) {
    case "init": {
      if (existsSync(keyFile)) throw new CommandError(`this machine already has a vault key (${keyFile})`);
      const key = newVaultKey();
      writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
      return [
        `Created a vault key in ${keyFile}. Copy it to your other devices with: grenier vault join ${key}`,
        "Keep a copy somewhere safe: the team server only ever sees what it encrypts, and without the key nobody can read it.",
      ];
    }
    case "key": {
      const key = vaultKey(paths);
      if (!key) throw new CommandError("no vault key yet: grenier vault init, or grenier vault join <key>");
      return [key];
    }
    case "join": {
      if (!value) throw new UsageError("vault join takes the key printed by grenier vault init on another device");
      try {
        // Sealing a test object checks the key's form without sending anything anywhere.
        await open(value.trim(), "check", await seal(value.trim(), "check", new Uint8Array([1])));
      } catch (error) {
        throw new CommandError(error instanceof VaultError ? error.message : String(error));
      }
      if (existsSync(keyFile) && readFileSync(keyFile, "utf8").trim() !== value.trim()) {
        throw new CommandError(`this machine already has another vault key (${keyFile}); move it aside first`);
      }
      writeFileSync(keyFile, `${value.trim()}\n`, { mode: 0o600 });
      return ["Joined the vault. Sync with: grenier vault sync (the daemon also syncs it with the team server)."];
    }
    case "sync": {
      const key = vaultKey(paths);
      if (!key) throw new CommandError("no vault key yet: grenier vault init, or grenier vault join <key>");
      const team = teamClient(config, paths, io.env);
      if (!team)
        throw new CommandError("the vault is stored on the team server: grenier team join <url> <token> first");
      return withStore(paths, async (store) => {
        try {
          const device = await deviceId(store);
          const pushed = await vaultPush(store, team, key, device);
          const pulled = await vaultPull(store, team, key, device);
          return [
            pushed ? "Pushed this device's memories and sources, encrypted." : "Nothing new to push.",
            `Pulled ${pulled.memories} memory(ies) and ${pulled.sources} source(s) from other devices.`,
          ];
        } catch (error) {
          if (error instanceof VaultError) throw new CommandError(error.message);
          throw error;
        }
      });
    }
    default:
      throw new UsageError("vault takes: init, key, join <key> or sync");
  }
}
