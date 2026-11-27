import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Config } from "@grenier/core";
import { type GrenierPaths, withTomlValue } from "@grenier/core/node";
import type { TeamClient } from "@grenier/index";
import type { Store } from "@grenier/store";
import { Refusal } from "./io.ts";
import { ensurePersonalKey } from "./runtime.ts";

/** The team server and this machine's token: the env var named by `[team] token_env`, else the saved token. */
export function teamClient(config: Config, paths: GrenierPaths, env: NodeJS.ProcessEnv): TeamClient | null {
  if (!config.team.url) return null;
  const fromEnv = env[config.team.token_env];
  const token = fromEnv || (existsSync(paths.teamToken) ? readFileSync(paths.teamToken, "utf8").trim() : "");
  return token ? { url: config.team.url, token } : null;
}

/** An invite link, `grenier://join/<host>/<invite>/<secret>`: the team store's address, the invite and its secret. */
export function parseInvite(link: string): { url: string; invite: string; secret: string } {
  const match = /^grenier:\/\/join\/([\w.:-]+)\/([0-9a-f]+)\/([0-9a-f]+)\/?$/.exec(link.trim());
  if (!match) throw new Refusal("an invite link looks like grenier://join/<host>/<invite>/<secret>");
  const host = match[1] as string;
  const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  return { url: `${local ? "http" : "https"}://${host}`, invite: match[2] as string, secret: match[3] as string };
}

/** A member token as the team server makes them, and the SHA-256 it keeps instead. */
export function newTeamToken(): { token: string; hash: string } {
  const token = `gt_${randomBytes(32).toString("base64url")}`;
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

/** This machine in a team from now on: its address and token saved, who it is there, and its folders and key. */
export async function enterTeam(
  paths: GrenierPaths,
  store: Store,
  team: { url: string; token: string; member: string; role: string; meTop?: string },
): Promise<void> {
  saveTeam(paths, team.url, team.token);
  await store.state.set("team_member", team.member);
  await store.state.set("team_role", team.role);
  if (team.meTop) await store.state.set("team_me_top", team.meTop);
  ensurePersonalKey(paths);
}

/** Saves the team server's address in config.toml and the token beside it, readable by this user only. */
export function saveTeam(paths: GrenierPaths, url: string, token: string): void {
  const text = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  writeFileSync(paths.config, withTomlValue(text, "team", "url", url), { mode: 0o600 });
  writeFileSync(paths.teamToken, `${token}\n`, { mode: 0o600 });
}
