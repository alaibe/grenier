import { secretIn } from "@grenier/core";
import type { FullRecord } from "@grenier/store";
import type { ServerEntry } from "./agents/index.ts";
import { Refusal } from "./io.ts";

/** A server's name: letters, digits, `.`, `_` and `-`; `grenier` and `grenier-…` are Grenier's own. */
export const SERVER_NAME = /^[\w.-]{1,60}$/;
export const BAD_SERVER_NAME = "a server's name takes letters, digits, ., _ and -";

/** A key's name, as a server's environment variable or a template's `{name}`. */
export const KEY_NAME = /^[\w-]{1,80}$/;

/** The names a template's `{name}`s ask for, as "Bearer {api_key}" asks for api_key. */
export const templateNames = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);

/** An object's values as strings, for a server's env or headers from a request. */
export const stringRecord = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries((value ?? {}) as Record<string, unknown>).map(([name, text]) => [name, String(text)]),
  );

/** Flags and values that look like they carry a credential, which a shared server's arguments may not. */
export const CREDENTIAL_FLAG = /^--?[\w-]*(key|token|secret|password|auth)[\w-]*(=|$)/i;

/**
 * A server as an admin adds it from the app: a URL with header templates, or a command with its arguments and fixed
 * environment, plus the names of the keys each person enters. Nothing in it may already be a key.
 */
export function serverToShare(input: { config?: unknown; credentials?: unknown }): {
  config: Record<string, unknown>;
  credentials: string[];
} {
  const given = (input.config ?? {}) as Record<string, unknown>;
  const credentials = Array.isArray(input.credentials) ? input.credentials.map(String) : [];
  if (credentials.some((name) => !KEY_NAME.test(name))) {
    throw new Refusal("a key's name takes letters, digits, _ and -");
  }
  let config: Record<string, unknown>;
  if (typeof given.url === "string" && given.url.trim()) {
    let url: URL;
    try {
      url = new URL(given.url.trim());
    } catch (error) {
      throw new Refusal((error as Error).message);
    }
    if (
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) => /key|token|secret|auth/i.test(key))
    ) {
      throw new Refusal("its URL carries a credential; move it to a header first");
    }
    const headers = stringRecord(given.headers);
    config = {
      type: given.type === "sse" ? "sse" : "http",
      url: given.url.trim(),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  } else if (typeof given.command === "string" && given.command.trim()) {
    const args = Array.isArray(given.args) ? given.args.map(String) : [];
    if (args.some((arg) => CREDENTIAL_FLAG.test(arg))) {
      throw new Refusal("its arguments carry a credential; pass it in an environment variable first");
    }
    const env = stringRecord(given.env);
    config = { command: given.command.trim(), args, ...(Object.keys(env).length > 0 ? { env } : {}) };
  } else {
    throw new Refusal("a server has a URL, or a command to run");
  }
  if (secretIn(JSON.stringify(config))) throw new Refusal("its configuration holds what looks like a key or a token");
  return { config, credentials };
}

const credentialsOf = (record: Pick<FullRecord, "fields">) =>
  Array.isArray(record.fields.credentials) ? (record.fields.credentials as string[]) : [];

/** A remote server's headers as shared: each value a template, as "Bearer {api_key}", whose names are credentials. */
function headerTemplates(config: Record<string, unknown>, credentials: string[]): Record<string, string> {
  const headers = (config.headers ?? {}) as Record<string, unknown>;
  const templates = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)]));
  // A credential no template names is sent as a header of its own name.
  for (const name of credentials) {
    if (!Object.values(templates).some((template) => template.includes(`{${name}}`))) templates[name] = `{${name}}`;
  }
  return templates;
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The keys a person entered, read back from their server's entry in an agent's config. */
export function keysIn(
  record: Pick<FullRecord, "fields">,
  entry: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!entry) return {};
  const config = (record.fields.config ?? {}) as Record<string, unknown>;
  const keys: Record<string, string> = {};
  if (typeof config.url !== "string") {
    for (const [name, value] of Object.entries((entry.env ?? {}) as Record<string, unknown>))
      keys[name] = String(value);
    return keys;
  }
  const headers = (entry.headers ?? {}) as Record<string, unknown>;
  for (const [header, template] of Object.entries(headerTemplates(config, credentialsOf(record)))) {
    const names = templateNames(template);
    const pattern = new RegExp(`^${literal(template).replace(/\\\{\w+\\\}/g, "(.*)")}$`);
    const found = pattern.exec(String(headers[header] ?? ""));
    if (!found) continue;
    for (const [index, name] of names.entries()) keys[name] = found[index + 1] as string;
  }
  return keys;
}

/** A server's entry in each agent's config, with the keys this person entered: they go nowhere else. */
export function serverEntry(record: Pick<FullRecord, "fields">, keys: Record<string, string>): Record<string, unknown> {
  const config = (record.fields.config ?? {}) as Record<string, unknown>;
  const credentials = credentialsOf(record);
  const missing = credentials.filter((name) => !keys[name]);
  if (missing.length > 0) throw new Refusal(`it needs your ${missing.join(", ")}`);
  if (typeof config.url === "string") {
    const headers = Object.fromEntries(
      Object.entries(headerTemplates(config, credentials)).map(([name, template]) => [
        name,
        template.replace(/\{(\w+)\}/g, (_, key: string) => keys[key] ?? ""),
      ]),
    );
    return {
      type: config.type === "sse" ? "sse" : "http",
      url: config.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  const env = {
    ...((config.env ?? {}) as Record<string, string>),
    ...Object.fromEntries(credentials.map((name) => [name, keys[name] as string])),
  };
  return {
    type: "stdio",
    command: String(config.command ?? ""),
    args: Array.isArray(config.args) ? config.args.map(String) : [],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/** A server's entry from the app's form: a command and its arguments, or a URL, with the values the person typed. */
export function entryOf(input: {
  url?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  headers?: unknown;
}): ServerEntry {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (url) {
    try {
      new URL(url);
    } catch (error) {
      throw new Refusal((error as Error).message);
    }
    const headers = stringRecord(input.headers);
    return { type: "http", url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  }
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Refusal("a server has a URL, or a command to run");
  const env = stringRecord(input.env);
  return {
    type: "stdio",
    command,
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
