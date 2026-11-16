import { parseArgs } from "node:util";
import { ConfigError } from "@grenier/core";
import { StoreError } from "@grenier/store";
import { version } from "../package.json";
import { status } from "./status.ts";

export interface Io {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `Usage: grenier <command>

Commands:
  status         Show the config, the database and whether the daemon runs

Options:
  -h, --help     Show this help
  -v, --version  Show the version`;

/** Runs one command and returns its exit code: 0 done, 1 failed, 2 wrong usage. */
export async function run(argv: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err(`grenier: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    io.out(version);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === "help") {
    io.out(USAGE);
    return 0;
  }
  if (rest.length > 0) {
    io.err(`grenier: ${command} takes no arguments\n\n${USAGE}`);
    return 2;
  }

  try {
    switch (command) {
      case "status":
        for (const line of await status(io.env, version)) io.out(line);
        return 0;
      default:
        io.err(`grenier: unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof StoreError) {
      io.err(`grenier: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}
