import type {
  AppView,
  ClientMade,
  Clients,
  InstructionFile,
  InstructionText,
  KeyState,
  MachineState,
  Overview,
  PausedSession,
  ShownKey,
} from "@grenier/core/api";
import {
  type Command,
  type Context,
  edited,
  type Group,
  q,
  splitPair,
  strings,
  table,
  textFrom,
  UNCHANGED,
  when,
} from "./client.ts";

const dollars = (cost: number) => `$${cost.toFixed(2)}`;

export const STATUS: Command = {
  usage: "",
  summary: "Who writes from here, the team, and the last 7 days' spend",
  call: ({ admin }) => admin<Overview>("GET", "/overview"),
  show: (overview: Overview) =>
    [
      table([
        ["grenier", overview.version],
        ["me", overview.me],
        ["team", overview.team ? `${overview.team.url}, ${overview.role ?? "member"}` : "none"],
        ...(overview.team ? [["last sync", when(overview.team.lastSync)]] : []),
        ...(overview.waiting > 0 ? [["waiting", `${overview.waiting} pages for the next sync`]] : []),
        ...(overview.outdated ? [["team store", "older than this Grenier: deploy it again"]] : []),
        ...(overview.paused > 0 ? [["paused", `${overview.paused} sessions: grenier session list`]] : []),
        ["7 days", dollars(overview.days.reduce((total, day) => total + day.cost, 0))],
      ]),
      ...(overview.projects.length > 0
        ? ["", table(overview.projects.map((project) => [dollars(project.cost), project.key]))]
        : []),
    ].join("\n"),
};

export const SESSIONS: Group = {
  summary: "Agent sessions the loop guard paused.",
  commands: {
    list: {
      usage: "list",
      summary: "List the paused sessions",
      call: async ({ admin }) => (await admin<{ sessions: PausedSession[] }>("GET", "/sessions/paused")).sessions,
      show: (sessions: PausedSession[]) =>
        table(sessions.map((session) => [session.id, session.client, session.repo, when(session.pausedAt)])) ||
        "no paused sessions",
    },
    resume: {
      usage: "resume <id>",
      summary: "Let a paused session go on",
      takes: [1, 1],
      call: ({ admin, args }) => admin("POST", `/sessions/${q(args[0] as string)}/resume`),
      show: (answer: { resumed: string | null }) =>
        answer.resumed ? `Resumed ${answer.resumed}` : "It was not paused",
    },
  },
};

/** `name=value`, with true, false and numbers as themselves. */
function rule(pair: string): [string, string | number | boolean] {
  const [name, value] = splitPair(pair);
  if (value === "true" || value === "false") return [name, value === "true"];
  return [name, /^\d+(\.\d+)?$/.test(value) ? Number(value) : value];
}

export const MACHINE: Group = {
  summary: "This machine: its name, work folder, and when it takes the team's routines.",
  commands: {
    show: {
      usage: "show",
      summary: "Print this machine's rules, and whether it is free now",
      call: ({ admin }) => admin<MachineState>("GET", "/machine"),
      show: (state: MachineState) =>
        [
          table(Object.entries(state.rules).map(([name, value]) => [name, String(value)])),
          "",
          `${state.running ? "running a routine" : state.state}${(state.reasons ?? []).length > 0 ? `: ${state.reasons.join(", ")}` : ""}`,
        ].join("\n"),
    },
    set: {
      usage: "set <name=value>…",
      summary: "Change rules, as workdir=/home/me/Work routines=true hours=9-18",
      takes: [1, 99],
      call: ({ admin, args }) => admin<MachineState>("PUT", "/machine", { rules: Object.fromEntries(args.map(rule)) }),
      show: () => "Saved",
    },
  },
};

export const KEY: Group = {
  summary: "Your personal key, which seals your Me pages before they reach the team store.",
  commands: {
    status: {
      usage: "status",
      summary: "How many of your Me pages this machine cannot open",
      call: ({ admin }) => admin<KeyState>("GET", "/key"),
      show: (state: KeyState) =>
        state.unopened > 0 ? `${state.unopened} Me pages need your key: grenier key set` : "Every Me page opens here",
    },
    show: {
      usage: "show",
      summary: "Print your key, to enter it on your other machines",
      call: ({ admin }) => admin<ShownKey>("POST", "/key"),
      show: (shown: ShownKey) => shown.key,
    },
    set: {
      usage: "set [<key>]",
      summary: "Use the key of your other machines, from the word given or stdin",
      takes: [0, 1],
      call: ({ admin, args }) => admin<KeyState>("PUT", "/key", { key: args[0] ?? textFrom("-").trim() }),
      show: (state: KeyState) => `Saved${state.unopened > 0 ? `: ${state.unopened} Me pages still don't open` : ""}`,
    },
  },
};

/** The top folders `--scope` names, every one when it names none. */
const scopesOf = (flags: Context["flags"]) => (strings(flags.scope).length > 0 ? strings(flags.scope) : ["*"]);

export const APPS: Group = {
  summary: "The apps that read Grenier over MCP: the ones on this computer, and those with a key of their own.",
  commands: {
    list: {
      usage: "list",
      summary: "List the apps on this computer, and whether Grenier is added to each",
      call: async ({ admin }) => (await admin<{ apps: AppView[] }>("GET", "/apps")).apps,
      show: (apps: AppView[]) => table(apps.map((app) => [app.app, app.label, app.connected ? "added" : ""])),
    },
    add: {
      usage: "add <app> [--scope <top folder>]…",
      summary: "Add Grenier's MCP server to an app, reading every folder unless --scope names some",
      options: { scope: { type: "string", multiple: true } },
      takes: [1, 1],
      call: ({ admin, args, flags }) => {
        return admin("POST", `/apps/${q(args[0] as string)}`, { scopes: scopesOf(flags) });
      },
      show: (answer: { file: string; restart: string }) => `Added Grenier in ${answer.file}: restart ${answer.restart}`,
    },
    keys: {
      usage: "keys",
      summary: "List the apps with a key of their own, and what each reads",
      call: ({ admin }) => admin<Clients>("GET", "/clients"),
      show: (clients: Clients) =>
        table(clients.clients.map((client) => [client.name, client.scopes.join(", "), when(client.createdAt)])) ||
        "no keys",
    },
    key: {
      usage: "key <name> [--scope <top folder>]…",
      summary: "Make a key for an app, shown once",
      options: { scope: { type: "string", multiple: true } },
      takes: [1, 1],
      call: ({ admin, args, flags }) => {
        return admin<ClientMade>("POST", "/clients", { name: args[0], scopes: scopesOf(flags) });
      },
      show: (made: ClientMade) =>
        `${made.name} reads ${made.scopes.join(", ")} with this key, shown once:\n${made.token}`,
    },
    revoke: {
      usage: "revoke <name>",
      summary: "Take an app's key away",
      takes: [1, 1],
      call: ({ admin, args }) => admin("POST", `/clients/${q(args[0] as string)}/revoke`),
      show: (answer: { revoked: string }) => `Revoked ${answer.revoked}'s key`,
    },
  },
};

export const INSTRUCTIONS: Group = {
  summary: "What agents read: every project's and each project's CLAUDE.md and AGENTS.md, and Grenier's own texts.",
  commands: {
    list: {
      usage: "list",
      summary: "List the files, by the id the other commands take",
      call: async ({ admin }) => (await admin<{ files: InstructionFile[] }>("GET", "/instructions")).files,
      show: (files: InstructionFile[]) =>
        table(files.map((file) => [file.id, file.group === "grenier" && !file.exists ? "default" : "", file.path])),
    },
    show: {
      usage: "show <id>",
      summary: "Print one",
      takes: [1, 1],
      call: ({ admin, args }) => admin<InstructionText>("GET", `/instructions/one?id=${q(args[0] as string)}`),
      show: (text: InstructionText) => text.text,
    },
    edit: {
      usage: "edit <id> [--text <file>|-]",
      summary: "Change one, in $EDITOR unless --text gives it",
      options: { text: { type: "string" } },
      takes: [1, 1],
      call: async ({ admin, args, flags, io }) => {
        const id = args[0] as string;
        const before = await admin<InstructionText>("GET", `/instructions/one?id=${q(id)}`);
        const text = edited(io, flags.text, before.text, "text");
        if (text === null) return UNCHANGED;
        await admin("PUT", `/instructions/one?id=${q(id)}`, { text, hash: before.hash });
        return { saved: id };
      },
      show: (answer: { saved: string }) => `Saved ${answer.saved}`,
    },
    reset: {
      usage: "reset <id>",
      summary: "Put Grenier's own text back",
      takes: [1, 1],
      call: ({ admin, args }) => admin("DELETE", `/instructions/one?id=${q(args[0] as string)}`),
      show: () => "Reset to Grenier's own",
    },
  },
};
