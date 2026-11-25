import { runInNewContext } from "node:vm";
import { WEB } from "../../../apps/server/src/web.ts";

type Listener = (event: { target: PageNode; preventDefault: () => void }) => unknown;

/** The page's timers, by default the real ones. */
export interface Clock {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (timer: never) => void;
}

/** Just enough of a DOM element for the web view's script. */
export class PageNode {
  readonly tag: string;
  readonly children: PageNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  text = "";
  #value: string | undefined;

  constructor(tag: string) {
    this.tag = tag;
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.text = String(value);
    this.children.length = 0;
  }

  get value(): string {
    if (this.#value === undefined && this.tag === "select") return this.children[0]?.attributes.get("value") ?? "";
    return this.#value ?? "";
  }

  set value(value: string) {
    this.#value = value;
  }

  get firstChild(): PageNode | undefined {
    return this.children[0];
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  append(...nodes: (PageNode | string)[]): void {
    for (const node of nodes) {
      if (typeof node !== "string") {
        this.children.push(node);
        continue;
      }
      const text = new PageNode("#text");
      text.text = node;
      this.children.push(text);
    }
  }

  replaceChildren(...nodes: (PageNode | string)[]): void {
    this.text = "";
    this.children.length = 0;
    this.append(...nodes);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) void listener({ target: this, preventDefault: () => {} });
  }

  #search(match: (node: PageNode) => boolean): PageNode | null {
    if (match(this)) return this;
    for (const child of this.children) {
      const found = child.#search(match);
      if (found) return found;
    }
    return null;
  }

  /** The first node, this one or below, that matches. */
  find(match: (node: PageNode) => boolean): PageNode {
    const found = this.#search(match);
    if (!found) throw new Error(`nothing on the page matches, in: ${this.textContent}`);
    return found;
  }
}

/** The web view signed in with a token: its script runs on a fake page, and asks the team store through `fetch`. */
export function openPage(
  token: string,
  fetch: (path: string, init: RequestInit) => Promise<Response>,
  clock: Clock = { setTimeout, clearTimeout },
): { main: PageNode; nav: PageNode; press: (key: string) => void } {
  const script = /<script>([\s\S]*)<\/script>/.exec(WEB)?.[1] ?? "";
  const nodes = new Map<string, PageNode>();
  const byId = (id: string) => nodes.get(id) ?? nodes.set(id, new PageNode(id)).get(id);
  const main = byId("main") as PageNode;
  const nav = byId("nav") as PageNode;
  const storage = new Map([["grenier-token", token]]);
  const keydowns: ((event: object) => void)[] = [];
  runInNewContext(script, {
    document: {
      getElementById: byId,
      createElement: (tag: string) => new PageNode(tag),
      createElementNS: (_: string, tag: string) => new PageNode(tag),
      addEventListener: (type: string, listener: (event: object) => void) => {
        if (type === "keydown") keydowns.push(listener);
      },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    location: { hash: "", pathname: "/" },
    history: { replaceState: () => {} },
    fetch,
    crypto,
    URLSearchParams,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const press = (key: string) => {
    const event = { key, target: { tagName: "BODY" }, metaKey: false, ctrlKey: false, altKey: false };
    for (const listener of keydowns) listener({ ...event, preventDefault: () => {} });
  };
  return { main, nav, press };
}
