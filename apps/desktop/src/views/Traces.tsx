import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { ApiError, api } from "../api.ts";
import {
  describeStep,
  rereadsOf,
  type StepKind,
  type TokenKind,
  type Trace,
  type TraceStep,
  type TraceSummary,
  type Tree,
  tokens,
  treeOf,
} from "../trace.ts";
import {
  Button,
  count,
  Empty,
  Figure,
  Figures,
  Loading,
  moment,
  money,
  Notice,
  Page,
  Select,
  times,
  useLoad,
} from "../ui.tsx";

const STEP_MS = 1600;
const SPEEDS = [1, 2, 4, 8];
const ROW_H = 26;
const GUTTER = 46;
const LINE_H = 20;
const TRAIL = 9;
/** Past this many lines, the reading head stops following a read down the file. */
const FOLLOW_LINES = 300;

const loadTraces = () => api<{ traces: TraceSummary[] }>("/traces");

export function Traces({ focus }: ViewProps) {
  const list = useLoad(loadTraces);
  const [chosen, setChosen] = useState(focus ?? "");
  const traces = list.data?.traces ?? [];
  const id = traces.some((trace) => trace.id === chosen) ? chosen : (traces[0]?.id ?? "");

  return (
    <Page
      title="Traces"
      intro="Where an agent went in your code, one step at a time: what it read, searched and changed, replayed over the files as they are now."
      action={
        traces.length > 0 && (
          <label>
            <span className="sr-only">Session</span>
            <Select className="min-w-40" value={id} onChange={(event) => setChosen(event.target.value)}>
              {traces.map((trace) => (
                <option key={trace.id} value={trace.id}>
                  {trace.repo} · {trace.client ?? "agent"} · {moment(trace.startedAt)} · {count(trace.steps)} steps
                </option>
              ))}
            </Select>
          </label>
        )
      }
    >
      <Notice message={list.error} />
      {!list.data && !list.error && <Loading what="traces" />}
      {list.data && traces.length === 0 && (
        <Empty>
          <p>No traces yet. Run an agent through Grenier inside a repository, and the path it takes shows here:</p>
          <code>grenier run -- claude</code>
        </Empty>
      )}
      {id && <CacheUse traces={traces} current={traces.find((trace) => trace.id === id)} />}
      {id && <Player key={id} id={id} />}
    </Page>
  );
}

/** Whether agents ask the exploration cache before they explore: this session, and every session listed. */
function CacheUse({ traces, current }: { traces: TraceSummary[]; current: TraceSummary | undefined }) {
  if (!current) return null;
  const first = traces.filter((trace) => trace.asks > 0 && trace.readsBeforeAsk === 0).length;
  const never = traces.filter((trace) => trace.asks === 0).length;
  const session =
    current.asks === 0
      ? `This session never asked Grenier's cache: its ${times(current.readsBeforeAsk, "read")} went to exploring.`
      : `This session asked Grenier's cache ${times(current.asks, "time")} (${times(current.hits, "hit")}), ${current.readsBeforeAsk === 0 ? "before reading any code" : `after ${times(current.readsBeforeAsk, "read")}`}.`;
  const across =
    traces.length > 1
      ? ` Of the ${times(traces.length, "session")} listed, ${count(first)} asked before reading code and ${count(never)} never asked.`
      : "";
  return (
    <p className="mb-4 text-muted">
      {session}
      {across}
    </p>
  );
}

function Player({ id }: { id: string }) {
  const load = useCallback(() => api<Trace>(`/traces/${encodeURIComponent(id)}`), [id]);
  const { data, error, reload } = useLoad(load);
  if (error && !data) return <Notice message={error} />;
  if (!data) return <Loading what="the trace" />;
  if (data.steps.length === 0) return <Empty>This session took no step in its repository.</Empty>;
  return <Replay trace={data} reload={reload} />;
}

function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return reduced;
}

type FileState = { status: "loading" } | { status: "ready"; lines: string[] } | { status: "missing"; reason: string };

function useFiles(id: string) {
  const [files, setFiles] = useState<ReadonlyMap<string, FileState>>(new Map());
  const asked = useRef(new Set<string>());
  const want = useCallback(
    (path: string) => {
      if (asked.current.has(path)) return;
      asked.current.add(path);
      const set = (state: FileState) => setFiles((current) => new Map(current).set(path, state));
      set({ status: "loading" });
      api<{ text: string }>(`/traces/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`)
        .then(({ text }) => set({ status: "ready", lines: text.replace(/\n$/, "").split("\n") }))
        .catch((reason: unknown) =>
          set({ status: "missing", reason: reason instanceof ApiError ? reason.message : String(reason) }),
        );
    },
    [id],
  );
  return { files, want };
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
/** Sets `--kind`, the colour of what the agent did, for the marks inside. */
const KIND_CLASS: Record<StepKind, string> = {
  read: "[--kind:var(--color-accent)]",
  edit: "[--kind:var(--color-edit)]",
  search: "[--kind:var(--color-look)]",
  list: "[--kind:var(--color-look)]",
  ask: "[--kind:var(--color-ask)]",
};
const AGAIN_CLASS = "[--kind:var(--color-problem)]";
const SWATCH = "inline-block size-2.5 flex-none rounded-full bg-(color:--kind)";
const HINT = "text-sm font-normal text-muted";
const TOKEN_CLASS: Record<Exclude<TokenKind, "plain">, string> = {
  keyword: "text-accent",
  string: "text-tok-string",
  number: "text-tok-string",
  comment: "text-muted italic",
};
const PANE = "relative flex min-h-0 min-w-0 flex-col";
/** Each step gets an equal slot, and a bar at most 6px wide in it: thin with few steps, solid with many. */
const TICK_HEIGHT: Partial<Record<StepKind, string>> = { edit: "h-full", read: "h-[70%]" };
const AGAIN_DOT =
  "after:absolute after:-top-1.5 after:left-1/2 after:-ml-0.5 after:size-1 after:rounded-full after:bg-problem";

function Replay({ trace, reload }: { trace: Trace; reload: () => void }) {
  const steps = trace.steps;
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const reduced = useReducedMotion();
  const tree = useMemo(() => treeOf(trace.repo, steps), [trace.repo, steps]);
  const again = useMemo(() => rereadsOf(steps), [steps]);
  const opened = useMemo(
    () => new Set(steps.filter((s) => s.outcome !== "error" && tree.files.has(s.path ?? "")).map((s) => s.path)).size,
    [steps, tree],
  );
  const { files, want } = useFiles(trace.id);

  const last = steps.length - 1;
  const index = Math.min(at, last);
  const step = steps[index] as TraceStep;

  // The file on screen: the one the agent last opened, up to this step.
  const shownAt = useMemo(() => {
    for (let i = index; i >= 0; i--) if (tree.files.has(steps[i]?.path ?? "")) return i;
    return -1;
  }, [index, steps, tree]);
  const shownPath = shownAt === -1 ? null : (steps[shownAt]?.path ?? null);
  const nextFile = useMemo(
    () => steps.slice(index + 1).find((s) => tree.files.has(s.path ?? ""))?.path,
    [index, steps, tree],
  );
  useEffect(() => {
    if (shownPath) want(shownPath);
    if (nextFile) want(nextFile);
  }, [shownPath, nextFile, want]);

  useEffect(() => {
    if (!playing) return;
    if (index >= last) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setAt(index + 1), STEP_MS / speed);
    return () => window.clearTimeout(timer);
  }, [playing, index, last, speed]);

  const go = useCallback((to: number) => setAt(Math.max(0, Math.min(last, to))), [last]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowRight") go(index + 1);
      else if (event.key === "ArrowLeft") go(index - 1);
      else if (event.key === " " && target.tagName !== "BUTTON") setPlaying((value) => !value);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, index]);

  const spent = useMemo(() => {
    let total = 0;
    let sofar = 0;
    for (const request of trace.requests) {
      total += request.cost;
      if (request.ts <= step.ts) sofar += request.cost;
    }
    return { total, sofar };
  }, [trace.requests, step.ts]);

  const onShown = shownAt === index && (step.kind === "read" || step.kind === "edit");
  const duration = reduced ? 0 : Math.min(STEP_MS / speed, 1100);

  return (
    <div>
      <Figures className="mb-4 grid-cols-4 max-lg:grid-cols-2">
        <Figure value={count(steps.length)} label="steps" />
        <Figure value={count(opened)} label="files read or changed" />
        <Figure
          title="Lines the agent read again although nothing it changed touched them in between: exploration Grenier's cache is there to spare."
          value={count(again.size)}
          label="reads of lines already read"
        />
        <Figure
          value={
            <>
              {money(spent.sofar)}
              <span className="text-md font-normal text-muted"> of {money(spent.total)}</span>
            </>
          }
          label="spent up to this step"
        />
      </Figures>

      <div className="grid h-[clamp(360px,calc(100vh_-_400px),820px)] grid-cols-[minmax(220px,300px)_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-panel max-lg:h-[clamp(520px,calc(100vh_-_340px),900px)] max-lg:grid-cols-[minmax(0,1fr)] max-lg:grid-rows-[200px_minmax(0,1fr)]">
        <FileTree tree={tree} steps={steps} at={index} go={go} duration={duration} again={again} />
        <CodePane
          path={shownPath}
          file={shownPath ? files.get(shownPath) : undefined}
          steps={steps}
          at={index}
          shownAt={shownAt}
          active={onShown}
          duration={duration}
        />
      </div>

      <div className="mt-3.5 mb-2 flex min-h-6 items-center gap-2.5" aria-live="polite">
        <span className={`${SWATCH} ${KIND_CLASS[step.kind]}`} aria-hidden="true" />
        <p className="min-w-0 truncate text-lg">
          {describeStep(step)}
          {again.has(index) && <span className="text-problem"> · read before, unchanged since</span>}
        </p>
        <span className={`ml-auto tabular-nums ${HINT}`}>{new Date(step.ts).toLocaleTimeString()}</span>
      </div>

      <Timeline steps={steps} at={index} again={again} go={go} />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button quiet square onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous step">
          ‹
        </Button>
        <Button
          className="min-w-19"
          onClick={() => {
            if (!playing && index >= last) setAt(0);
            setPlaying(!playing);
          }}
        >
          {playing ? "Pause" : index >= last ? "Replay" : "Play"}
        </Button>
        <Button quiet square onClick={() => go(index + 1)} disabled={index >= last} aria-label="Next step">
          ›
        </Button>
        <label>
          <span className="sr-only">Speed</span>
          <Select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
            {SPEEDS.map((value) => (
              <option key={value} value={value}>
                {value}× speed
              </option>
            ))}
          </Select>
        </label>
        <span className={`mr-auto tabular-nums ${HINT}`}>
          Step {count(index + 1)} of {count(steps.length)}
        </span>
        <Button quiet onClick={reload}>
          Load new steps
        </Button>
      </div>

      <ul
        className="mt-3.5 flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-muted *:inline-flex *:items-center *:gap-1.5"
        aria-label="Legend"
      >
        <li>
          <span className={`${SWATCH} ${KIND_CLASS.read}`} /> read
        </li>
        <li>
          <span className={`${SWATCH} ${KIND_CLASS.edit}`} /> changed
        </li>
        <li>
          <span className={`${SWATCH} ${KIND_CLASS.search}`} /> searched or listed
        </li>
        <li>
          <span className={`${SWATCH} ${KIND_CLASS.ask}`} /> asked Grenier's cache
        </li>
        <li>
          <span className={`${SWATCH} ${AGAIN_CLASS}`} /> read again, unchanged
        </li>
        <li className={`ml-auto ${HINT}`}>Space plays and pauses; the arrow keys step.</li>
      </ul>
    </div>
  );
}

function FileTree({
  tree,
  steps,
  at,
  go,
  duration,
  again,
}: {
  tree: Tree;
  steps: TraceStep[];
  at: number;
  go: (to: number) => void;
  duration: number;
  again: Set<number>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const dot = useRef<SVGGElement>(null);
  const row = tree.rowOfStep[at] ?? 0;
  const from = at > 0 ? (tree.rowOfStep[at - 1] ?? row) : row;
  const x = GUTTER - 8;
  const y = (r: number) => r * ROW_H + ROW_H / 2;
  const bend = (r1: number, r2: number) => Math.min(2 * (x - 4), 14 + Math.abs(y(r2) - y(r1)) * 0.5);

  const visits = useMemo(() => {
    const counts = new Array<number>(tree.rows.length).fill(0);
    for (let i = 0; i <= at; i++) counts[tree.rowOfStep[i] ?? 0] = (counts[tree.rowOfStep[i] ?? 0] ?? 0) + 1;
    return counts;
  }, [tree, at]);
  const most = Math.max(1, ...visits);

  const arcs: ReactElement[] = [];
  for (let i = Math.max(1, at - TRAIL + 1); i <= at; i++) {
    const r1 = tree.rowOfStep[i - 1] ?? 0;
    const r2 = tree.rowOfStep[i] ?? 0;
    if (r1 === r2) continue;
    const age = at - i;
    arcs.push(
      <path
        key={`${i}-${at === i}`}
        className={`fill-none stroke-(color:--kind) stroke-[1.5] [stroke-linecap:round] ${KIND_CLASS[steps[i]?.kind ?? "read"]}${age === 0 && duration > 0 ? " animate-draw-arc [stroke-dasharray:1]" : ""}`}
        d={`M ${x} ${y(r1)} Q ${x - bend(r1, r2)} ${(y(r1) + y(r2)) / 2} ${x} ${y(r2)}`}
        pathLength={1}
        style={{ opacity: 1 - age / TRAIL, animationDuration: `${duration * 0.4}ms` }}
      />,
    );
  }

  useEffect(() => {
    const element = scroller.current?.querySelector<HTMLElement>(`[data-row="${row}"]`);
    element?.scrollIntoView({ block: "nearest", behavior: duration > 0 ? "smooth" : "auto" });
  }, [row, duration]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the dot moves once per step
  useEffect(() => {
    const place = (t: number) => {
      const c = bend(from, row);
      const px = (1 - t) ** 2 * x + 2 * (1 - t) * t * (x - c) + t ** 2 * x;
      const py = (1 - t) ** 2 * y(from) + 2 * (1 - t) * t * ((y(from) + y(row)) / 2) + t ** 2 * y(row);
      dot.current?.setAttribute("transform", `translate(${px} ${py})`);
    };
    if (duration === 0 || from === row) {
      place(1);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / (duration * 0.4));
      place(ease(t));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [at]);

  const kind = steps[at]?.kind ?? "read";
  const nextVisit = (r: number) => {
    const later = tree.rowOfStep.findIndex((value, i) => i > at && value === r);
    return later === -1 ? tree.rowOfStep.indexOf(r) : later;
  };

  return (
    <div className="overflow-auto border-r border-line bg-side max-lg:border-r-0 max-lg:border-b" ref={scroller}>
      <div className="relative min-w-full" style={{ height: tree.rows.length * ROW_H }}>
        <svg
          className="pointer-events-none absolute top-0 left-0 z-1 overflow-visible"
          width={GUTTER}
          height={tree.rows.length * ROW_H}
          aria-hidden="true"
        >
          {arcs}
          <g ref={dot} className={KIND_CLASS[kind]}>
            <circle className="fill-(color:--kind) opacity-20" r={9} />
            <circle className="fill-(color:--kind)" r={4.5} />
            {duration > 0 && from === row && at > 0 && (
              <circle
                key={at}
                className="origin-center animate-ping fill-none stroke-(color:--kind) stroke-[1.5] [transform-box:fill-box]"
                r={5}
              />
            )}
          </g>
        </svg>
        {tree.rows.map((entry, r) => {
          const visited = visits[r] ?? 0;
          const firstStep = tree.rowOfStep.indexOf(r);
          const rereads = [...again].filter((i) => i <= at && tree.rowOfStep[i] === r).length;
          const current = r === row;
          const ahead = visited === 0 && firstStep !== -1;
          const className = `absolute inset-x-0 flex h-6.5 items-center gap-2 pr-2.5 text-left font-mono text-sm whitespace-nowrap ${current ? "bg-panel inset-ring inset-ring-line-strong" : ""} ${ahead ? "text-muted" : "text-fg"}`;
          const style = { top: r * ROW_H, paddingLeft: GUTTER + entry.depth * 12 };
          const nameColor = current ? "font-semibold text-fg" : ahead || !entry.file ? "text-muted" : "";
          const name = <span className={`relative overflow-hidden text-ellipsis ${nameColor}`}>{entry.label}</span>;
          // A directory only on the way to others: nothing happened there, so nothing to jump to.
          if (firstStep === -1) {
            return (
              <div key={entry.key || "."} data-row={r} className={className} style={style}>
                {name}
              </div>
            );
          }
          return (
            <button
              type="button"
              key={entry.key || "."}
              data-row={r}
              className={`${className} cursor-pointer hover:bg-hover focus-visible:-outline-offset-2`}
              style={style}
              onClick={() => go(nextVisit(r))}
              title={
                visited > 0
                  ? `${entry.key || entry.label}: ${visited} step${visited === 1 ? "" : "s"} so far${rereads ? `, ${rereads} of them reading lines again` : ""}. Click for its next step.`
                  : `${entry.key || entry.label}: not reached yet. Click to jump there.`
              }
            >
              <span
                className="absolute inset-y-0.75 left-11.5 max-w-[calc(100%_-_52px)] rounded-sm bg-accent-soft transition-[width] duration-300 ease-[ease] motion-reduce:transition-none"
                style={{ width: `${(visited / most) * 100}%` }}
                aria-hidden="true"
              />
              {name}
              {visited > 0 && (
                <span className="relative ml-auto inline-flex items-center gap-1.25 text-2xs text-muted tabular-nums">
                  {rereads > 0 && (
                    <span className="size-1.5 rounded-full bg-problem" role="img" aria-label="read again" />
                  )}
                  {visited}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CodePane({
  path,
  file,
  steps,
  at,
  shownAt,
  active,
  duration,
}: {
  path: string | null;
  file: FileState | undefined;
  steps: TraceStep[];
  at: number;
  shownAt: number;
  active: boolean;
  duration: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 400 });
  const lines = file?.status === "ready" ? file.lines : [];
  const step = steps[shownAt];
  const start = step?.startLine ?? 1;
  // A read with no end runs to the end of the file; an edit whose lines are unknown gets no band.
  const band =
    step && step.outcome !== "error" && (step.kind === "read" || (step.kind === "edit" && step.startLine !== null))
      ? { start, end: Math.max(start, step.endLine ?? (lines.length || start)) }
      : null;

  const seen = useMemo(() => {
    if (!path) return [];
    return steps
      .slice(0, at + 1)
      .filter((s) => s.path === path && (s.kind === "read" || (s.kind === "edit" && s.startLine !== null)))
      .map((s) => ({ kind: s.kind, start: s.startLine ?? 1, end: s.endLine ?? Number.POSITIVE_INFINITY }));
  }, [steps, at, path]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Each step: bring its first line a quarter down the pane, then run the reading head over the lines it covers.
  const ready = file?.status === "ready";
  // biome-ignore lint/correctness/useExhaustiveDependencies: the head runs once per step, and again once the file arrives
  useEffect(() => {
    const element = scroller.current;
    const dot = head.current;
    if (!element || !dot || !band || !active) return;
    const visible = Math.max(1, Math.floor(element.clientHeight / LINE_H));
    const target = Math.max(0, (band.start - 1) * LINE_H - element.clientHeight / 4);
    const follow = band.end - band.start <= FOLLOW_LINES;
    const last = follow ? band.end : Math.min(band.end, band.start + visible - 2);
    const put = (line: number) => {
      dot.style.transform = `translateY(${(line - 1) * LINE_H}px)`;
    };
    if (duration === 0) {
      element.scrollTop = target;
      put(last);
      return;
    }
    element.scrollTo({ top: target, behavior: "smooth" });
    put(band.start);
    let frame = 0;
    const begin = performance.now() + duration * 0.35;
    const sweep = duration * 0.6;
    const tick = (now: number) => {
      const t = Math.max(0, Math.min(1, (now - begin) / sweep));
      const line = band.start + (last - band.start) * ease(t);
      put(line);
      if (follow && t > 0) {
        const y = (line - 1) * LINE_H;
        if (y > element.scrollTop + element.clientHeight * 0.75) element.scrollTop = y - element.clientHeight * 0.75;
      }
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [at, ready]);

  if (!path) {
    return (
      <div className={PANE}>
        <p className="p-4.5 text-muted">The agent has not opened a file yet.</p>
      </div>
    );
  }

  const first = Math.max(0, Math.floor(view.top / LINE_H) - 30);
  const shown = lines.slice(first, first + Math.ceil(view.height / LINE_H) + 60);
  const digits = String(Math.max(lines.length, 1)).length;
  const kind = KIND_CLASS[step?.kind === "edit" ? "edit" : "read"];

  return (
    <div className={PANE}>
      <header className="flex items-baseline gap-3 border-b border-line px-3.5 py-2">
        <span className="min-w-0 truncate font-mono text-sm font-semibold" title={path}>
          {path}
        </span>
        {band && step?.startLine !== null && (
          <span className={HINT}>
            {band.start === band.end ? `line ${band.start}` : `lines ${band.start}–${band.end}`}
          </span>
        )}
        <span className={`ml-auto ${HINT}`}>as it is now</span>
      </header>
      <div
        className="relative flex-1 overflow-auto pr-3.5"
        ref={scroller}
        onScroll={(event) => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
      >
        {file?.status === "missing" && (
          <p className="absolute p-4.5 text-muted">This file cannot be shown: it is gone, binary or too large.</p>
        )}
        {file?.status === "loading" && <p className="absolute p-4.5 text-muted">Opening {path}…</p>}
        <div
          className="relative min-w-max font-mono text-sm leading-5"
          style={{ height: lines.length * LINE_H, ["--gutter" as string]: `${digits + 4}ch` }}
        >
          {ready && band && (
            <div
              className={`absolute left-0 -right-3.5 border-l-3 border-(color:--kind) bg-(color:--kind)/13 ${kind}${active ? "" : " opacity-45"}`}
              style={{
                top: (band.start - 1) * LINE_H,
                height: (Math.min(band.end, lines.length) - band.start + 1) * LINE_H,
              }}
              aria-hidden="true"
            />
          )}
          <div
            ref={head}
            className={`absolute top-1.25 left-1 z-1 size-2.5 rounded-full bg-(color:--kind) ring-3 ring-(color:--kind)/25 ${kind}${active && band && ready ? "" : " hidden"}`}
            aria-hidden="true"
          />
          <div
            className={
              active
                ? undefined
                : "opacity-55 transition-opacity duration-300 ease-[ease] motion-reduce:transition-none"
            }
            style={{ transform: `translateY(${first * LINE_H}px)` }}
          >
            {shown.map((line, offset) => {
              const number = first + offset + 1;
              return (
                <div className="flex h-5 whitespace-pre" key={number}>
                  <span className="w-(--gutter) flex-none pr-3 text-right text-muted select-none">{number}</span>
                  <span>
                    {tokens(line).map((token, i) =>
                      token.kind === "plain" ? (
                        token.text
                      ) : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one line never move
                        <span key={i} className={TOKEN_CLASS[token.kind]}>
                          {token.text}
                        </span>
                      ),
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {ready && lines.length > 0 && (
        <div
          className="absolute top-9.25 right-0.75 bottom-1.5 w-1.5 rounded-[3px] bg-hover"
          aria-hidden="true"
          title="Where in this file the agent has been"
        >
          {seen.map((range, i) => {
            const top = ((range.start - 1) / lines.length) * 100;
            const height = ((Math.min(range.end, lines.length) - range.start + 1) / lines.length) * 100;
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the ranges only ever grow at the end
                key={i}
                className={`absolute inset-x-0 rounded-xs bg-(color:--kind) ${KIND_CLASS[range.kind]}${i === seen.length - 1 && active ? "" : " opacity-45"}`}
                style={{ top: `${top}%`, height: `max(2px, ${height}%)` }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function Timeline({
  steps,
  at,
  again,
  go,
}: {
  steps: TraceStep[];
  at: number;
  again: Set<number>;
  go: (to: number) => void;
}) {
  return (
    <div
      className="relative h-10 rounded-lg border border-line bg-panel"
      style={{ ["--n" as string]: Math.max(1, steps.length) }}
    >
      <div className="absolute inset-x-0 inset-y-1.5 flex items-end" aria-hidden="true">
        {steps.map((step, i) => (
          <span
            key={step.id}
            className={`relative min-w-0 flex-1 before:absolute before:inset-y-0 before:left-1/2 before:w-[min(6px,calc(100%_-_1px))] before:-translate-x-1/2 before:rounded-[1px] ${TICK_HEIGHT[step.kind] ?? "h-[45%]"} ${KIND_CLASS[step.kind]}${i <= at ? "" : " opacity-30"}${again.has(i) ? ` ${AGAIN_DOT}` : ""} ${step.outcome === "error" ? "before:bg-[repeating-linear-gradient(0deg,var(--kind)_0_2px,transparent_2px_4px)]" : "before:bg-(color:--kind)"}`}
          />
        ))}
      </div>
      {/* The slider sits on the ticks, its thumb on the current one: a click or the arrow keys move the agent. */}
      <input
        className="absolute inset-y-0 right-[calc(50%/var(--n)_-_1.5px)] left-[calc(50%/var(--n)_-_1.5px)] h-full w-auto cursor-pointer appearance-none bg-transparent focus-visible:outline-offset-3 [&::-moz-range-thumb]:h-9.5 [&::-moz-range-thumb]:w-0.75 [&::-moz-range-thumb]:rounded-xs [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-fg [&::-webkit-slider-runnable-track]:h-full [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:h-9.5 [&::-webkit-slider-thumb]:w-0.75 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-xs [&::-webkit-slider-thumb]:bg-fg"
        type="range"
        min={0}
        max={steps.length - 1}
        value={at}
        onChange={(event) => go(Number(event.target.value))}
        aria-label="Step"
        aria-valuetext={describeStep(steps[at] as TraceStep)}
      />
    </div>
  );
}
