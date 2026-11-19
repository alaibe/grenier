import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import type { TeamClient } from "@grenier/index";

/** Where `grenier team join` keeps the member token, readable by this user only. */
export function tokenFile(paths: GrenierPaths): string {
  return join(paths.home, "team-token");
}

/** The team server and this machine's token: the env var named by `[team] token_env`, else the saved token. */
export function teamClient(config: Config, paths: GrenierPaths, env: NodeJS.ProcessEnv): TeamClient | null {
  if (!config.team.url) return null;
  const fromEnv = env[config.team.token_env];
  const token = fromEnv || (existsSync(tokenFile(paths)) ? readFileSync(tokenFile(paths), "utf8").trim() : "");
  return token ? { url: config.team.url, token } : null;
}

/** A member token as the team server makes them, and the SHA-256 it keeps instead. */
export function newTeamToken(): { token: string; hash: string } {
  const token = `gt_${randomBytes(32).toString("base64url")}`;
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

/** Sets `key = "value"` in a TOML table, editing the text so comments and other settings stay as they were. */
export function withTomlValue(text: string, table: string, key: string, value: string): string {
  const line = `${key} = ${JSON.stringify(value)}`;
  const lines = text.split("\n");
  const start = lines.findIndex((entry) => entry.trim() === `[${table}]`);
  if (start === -1) {
    const body = text.replace(/\n*$/, "");
    return `${body}${body ? "\n\n" : ""}[${table}]\n${line}\n`;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] ?? "")) end++;
  const existing = lines.findIndex(
    (entry, index) => index > start && index < end && new RegExp(`^\\s*${key}\\s*=`).test(entry),
  );
  if (existing !== -1) lines[existing] = line;
  else lines.splice(start + 1, 0, line);
  return lines.join("\n");
}

/** Saves this machine's member token, readable by this user only. */
export function saveToken(paths: GrenierPaths, token: string): void {
  writeFileSync(tokenFile(paths), `${token}\n`, { mode: 0o600 });
}

/** Saves the team server's address in config.toml and the token beside it. */
export function saveTeam(paths: GrenierPaths, url: string, token: string): void {
  const text = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  writeFileSync(paths.config, withTomlValue(text, "team", "url", url), { mode: 0o600 });
  saveToken(paths, token);
}
