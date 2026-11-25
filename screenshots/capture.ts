// Captures the shots of a list in light and dark with headless Chrome, checks their size, then replaces the old ones.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WIDTH = 1440;
const HEIGHT = 900;
const MODES = ["light", "dark"] as const;

interface Shot {
  name: string;
  path: string;
  scale: number;
}

/** Reads the list's one shape: `- name:`, then `path:` and `scale:`, one per line. */
function readShots(text: string): Shot[] {
  const shots: Partial<Shot>[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.replace(/\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(- | {2})(name|path|scale): (\S+)$/.exec(line);
    const last = shots.at(-1);
    if (!match || (match[1] === "  " && !last))
      throw new Error(`line ${index + 1} isn't "- name: …", "  path: …" or "  scale: …"`);
    const [, indent, key, value] = match as unknown as [string, string, keyof Shot, string];
    const shot = indent === "- " ? {} : (last as Partial<Shot>);
    if (indent === "- ") shots.push(shot);
    if (key === "scale") shot.scale = Number(value);
    else shot[key] = value;
  }
  return shots.map((shot, index) => {
    if (!shot.name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(shot.name))
      throw new Error(`shot ${index + 1} needs a kebab-case name`);
    if (!shot.path?.startsWith("/")) throw new Error(`${shot.name} needs a path starting with /`);
    if (shot.scale !== 2 && shot.scale !== 1.25) throw new Error(`${shot.name}'s scale is 2 (the hero) or 1.25`);
    return shot as Shot;
  });
}

/** A WebP's width and height, from its VP8, VP8L or VP8X header. */
function webpSize(image: Buffer): { width: number; height: number } {
  if (image.toString("ascii", 0, 4) !== "RIFF" || image.toString("ascii", 8, 12) !== "WEBP")
    throw new Error("not a WebP");
  const chunk = image.toString("ascii", 12, 16);
  if (chunk === "VP8 ") return { width: image.readUInt16LE(26) & 0x3fff, height: image.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = image.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: image.readUIntLE(24, 3) + 1, height: image.readUIntLE(27, 3) + 1 };
  throw new Error(`unknown WebP chunk ${chunk}`);
}

interface Session {
  send<T = unknown>(method: string, params?: object): Promise<T>;
  once(event: string): Promise<void>;
}

async function launch(chrome: string, profile: string) {
  const args = [
    "--headless",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
  ];
  if (process.getuid?.() === 0) args.push("--no-sandbox");
  const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise<string>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error(`${chrome} didn't start:\n${log}`)), 30_000);
    child.stderr.on("data", (data: Buffer) => {
      log += data.toString();
      const found = /DevTools listening on (ws:\S+)/.exec(log);
      if (found?.[1]) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
    child.once("exit", (code) => reject(new Error(`${chrome} exited with ${code}:\n${log}`)));
  });
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let next = 0;
  const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const waits = new Map<string, () => void>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      sessionId?: string;
      result?: unknown;
      error?: { message: string };
    };
    const call = message.id === undefined ? undefined : calls.get(message.id);
    if (call) {
      if (message.id !== undefined) calls.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    }
    const wait = message.method && waits.get(`${message.sessionId}:${message.method}`);
    if (wait) {
      waits.delete(`${message.sessionId}:${message.method}`);
      wait();
    }
  };
  const session = (sessionId?: string): Session => ({
    send: <T>(method: string, params: object = {}) =>
      new Promise<T>((resolve, reject) => {
        const id = ++next;
        calls.set(id, { resolve: resolve as (value: unknown) => void, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      }),
    once: (event: string) => new Promise<void>((resolve) => waits.set(`${sessionId}:${event}`, resolve)),
  });
  const browser = session();
  // A fresh tab per shot: moving between two hashes of /demo would load nothing to wait for.
  const tab = async <T>(use: (page: Session) => Promise<T>): Promise<T> => {
    const { targetId } = await browser.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await browser.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    try {
      return await use(session(sessionId));
    } finally {
      await browser.send("Target.closeTarget", { targetId });
    }
  };
  const close = async () => {
    socket.close();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  };
  return { tab, close };
}

async function capture(page: Session, url: string, shot: Shot, mode: (typeof MODES)[number]): Promise<Buffer> {
  await page.send("Page.enable");
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: mode }] });
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: shot.scale,
    mobile: false,
  });
  const loaded = page.once("Page.loadEventFired");
  const { errorText } = await page.send<{ errorText?: string }>("Page.navigate", { url: url + shot.path });
  if (errorText) throw new Error(`${url + shot.path}: ${errorText}`);
  await loaded;
  await page.send("Runtime.evaluate", { expression: "document.fonts.ready.then(() => true)", awaitPromise: true });
  // The views fetch their data from the demo's daemon after the page has loaded.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const { data } = await page.send<{ data: string }>("Page.captureScreenshot", { format: "webp", quality: 82 });
  const image = Buffer.from(data, "base64");
  const size = webpSize(image);
  const want = { width: Math.round(WIDTH * shot.scale), height: Math.round(HEIGHT * shot.scale) };
  if (size.width !== want.width || size.height !== want.height) {
    throw new Error(`${shot.name}-${mode} is ${size.width} × ${size.height}, not ${want.width} × ${want.height}`);
  }
  return image;
}

async function main(list: string, url: string, out: string, chrome: string) {
  const shots = readShots(readFileSync(list, "utf8"));
  const run = mkdtempSync(join(tmpdir(), "grenier-shots-"));
  const { tab, close } = await launch(chrome, join(run, "profile"));
  try {
    const images = new Map<string, Buffer>();
    for (const mode of MODES) {
      for (const shot of shots) {
        images.set(`${shot.name}-${mode}.webp`, await tab((page) => capture(page, url, shot, mode)));
        process.stdout.write(`${shot.name}-${mode}.webp\n`);
      }
    }
    for (const file of readdirSync(out)) {
      if (/-(light|dark)\.webp$/.test(file)) rmSync(join(out, file));
    }
    for (const [file, image] of images) writeFileSync(join(out, file), image);
  } finally {
    await close();
    rmSync(run, { recursive: true, force: true });
  }
}

const [list, url, out, chrome] = process.argv.slice(2);
if (!list || !url || !out || !chrome) {
  process.stderr.write("usage: node screenshots/capture.ts <list.yaml> <demo url> <out dir> <chrome>\n");
  process.exit(1);
}
await main(list, url, out, chrome);
