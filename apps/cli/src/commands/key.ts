import { writeFileSync } from "node:fs";
import { open, seal, VaultError } from "@grenier/core";
import { CommandError, environment, type Io, UsageError } from "../io.ts";
import { ensurePersonalKey, personalKey, personalKeyFile } from "../runtime.ts";

/**
 * `grenier key`: the person's own key for the `me` space, made the first time; `grenier key set <key>` puts the same
 * key on another of their machines, so it can open what the first one sealed.
 */
export async function key(argv: string[], io: Io): Promise<string[]> {
  const [action, value] = argv;
  const { paths } = environment(io);
  if (!action) {
    const made = personalKey(paths) === null;
    const current = ensurePersonalKey(paths);
    return [
      current,
      made
        ? `Made a personal key in ${personalKeyFile(paths)}. Put it on your other machines with: grenier key set <key>`
        : "Put it on your other machines with: grenier key set <key>. The team store never sees it.",
    ];
  }
  if (action !== "set" || !value) throw new UsageError("key takes nothing, or: set <key>");
  try {
    // Sealing a test object checks the key's form without sending anything anywhere.
    await open(value.trim(), "check", await seal(value.trim(), "check", new Uint8Array([1])));
  } catch (error) {
    throw new CommandError(error instanceof VaultError ? error.message : String(error));
  }
  const existing = personalKey(paths);
  if (existing && existing !== value.trim()) {
    throw new CommandError(`this machine has another personal key (${personalKeyFile(paths)}); move it aside first`);
  }
  writeFileSync(personalKeyFile(paths), `${value.trim()}\n`, { mode: 0o600 });
  return ["Saved. Your `me` records from your other machines open here at the next sync."];
}
