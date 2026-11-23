import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Config } from "@grenier/core";

/** What this machine is doing now, read from the system. Null where it cannot tell. */
export interface Probes {
  pluggedIn(): Promise<boolean | null>;
  idleSeconds(): Promise<number | null>;
  /** CPU load per core, as a share. */
  load(): number;
  /** Memory in use, as a share. */
  memory(): Promise<number>;
  hour(): number;
}

const run = async (command: string, args: string[]) =>
  (await promisify(execFile)(command, args, { timeout: 5000, encoding: "utf8" })).stdout;

/** The probes of this system: pmset and ioreg on macOS, /sys and xprintidle on Linux. */
export function systemProbes(platform: NodeJS.Platform = process.platform): Probes {
  return {
    async pluggedIn() {
      try {
        if (platform === "darwin") {
          const out = await run("pmset", ["-g", "batt"]);
          return out.includes("AC Power") ? true : out.includes("Battery Power") ? false : null;
        }
        if (platform === "linux") {
          const root = "/sys/class/power_supply";
          if (!existsSync(root)) return true;
          const mains = readdirSync(root).filter(
            (name) => readFileSync(join(root, name, "type"), "utf8").trim() === "Mains",
          );
          if (mains.length === 0) return true;
          return mains.some((name) => readFileSync(join(root, name, "online"), "utf8").trim() === "1");
        }
      } catch {
        return null;
      }
      return null;
    },
    async idleSeconds() {
      try {
        if (platform === "darwin") {
          const nanos = /"HIDIdleTime" = (\d+)/.exec(await run("ioreg", ["-c", "IOHIDSystem", "-d", "4"]))?.[1];
          return nanos ? Number(nanos) / 1e9 : null;
        }
        if (platform === "linux") return Number((await run("xprintidle", [])).trim()) / 1000;
      } catch {
        return null;
      }
      return null;
    },
    load: () => (loadavg()[0] ?? 0) / Math.max(1, cpus().length),
    async memory() {
      if (platform === "darwin") {
        try {
          const out = await run("vm_stat", []);
          const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
          const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
          const used =
            (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * page;
          return Math.min(1, used / totalmem());
        } catch {
          // Fall back to what Node reads, which counts the file cache as used.
        }
      }
      if (platform === "linux" && existsSync("/proc/meminfo")) {
        const info = readFileSync("/proc/meminfo", "utf8");
        const available = Number(/MemAvailable:\s+(\d+)/.exec(info)?.[1] ?? 0) * 1024;
        if (available > 0) return 1 - available / totalmem();
      }
      return 1 - freemem() / totalmem();
    },
    hour: () => new Date().getHours(),
  };
}

export interface Availability {
  state: "available" | "busy" | "away";
  /** How much this machine could take on, from 0 to 1: the team store offers work to the one with the most. */
  room: number;
  /** Why it is not available, in the words the app and `grenier machine` show. */
  reasons: string[];
}

/** Whether `hour` is inside "a-b", which wraps past midnight when a > b. */
export function withinHours(hours: string, hour: number): boolean {
  const [from = 0, to = 24] = hours.split("-").map(Number);
  if (from === to || (from === 0 && to >= 24)) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** Whether every rule the person set holds now, and how much room there is. */
export async function availability(rules: Config["machine"], probes: Probes, running: boolean): Promise<Availability> {
  const reasons: string[] = [];
  const [plugged, idle, memory] = await Promise.all([probes.pluggedIn(), probes.idleSeconds(), probes.memory()]);
  const load = probes.load();
  const percent = (share: number) => `${Math.round(share * 100)}%`;
  if (rules.plugged_in && plugged === false) reasons.push("on battery");
  if (rules.idle_minutes > 0) {
    if (idle === null) reasons.push("cannot tell whether someone is using it; set idle_minutes = 0 if it is always on");
    else if (idle < rules.idle_minutes * 60) {
      reasons.push(`in use: idle ${Math.floor(idle / 60)} of ${rules.idle_minutes} minutes`);
    }
  }
  if (load > rules.cpu_max) reasons.push(`CPU at ${percent(load)}, above ${percent(rules.cpu_max)}`);
  if (memory > rules.memory_max) reasons.push(`memory at ${percent(memory)}, above ${percent(rules.memory_max)}`);
  if (!withinHours(rules.hours, probes.hour())) reasons.push(`outside its hours, ${rules.hours}`);
  const room = Math.max(0, Math.min(1, (1 - Math.min(1, load)) * (1 - memory)));
  if (running) return { state: "busy", room, reasons: ["a run is going", ...reasons] };
  return { state: reasons.length === 0 ? "available" : "away", room, reasons };
}
