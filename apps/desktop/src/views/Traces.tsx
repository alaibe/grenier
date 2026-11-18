import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { ApiError, api } from "../api.ts";
import {
  describeStep,
  rereadsOf,
  type StepKind,
  type Trace,
  type TraceStep,
  type TraceSummary,
  type Tree,
  tokens,
  treeOf,
} from "../trace.ts";
import { count, Empty, Loading, moment, money, Notice, Page, useLoad } from "../ui.tsx";

const STEP_MS = 1600;
const SPEEDS = [1, 2, 4, 8];
const ROW_H = 26;
const GUTTER = 46;
const LINE_H = 20;
const TRAIL = 9;
/** Past this many lines, the reading head stops following a read down the file. */
const FOLLOW_LINES = 300;

const loadTraces = () => api<{ traces: TraceSummary[] }>("/traces");

export function Traces(_: ViewProps) {
  const list = useLoad(loadTraces);
  const [chosen, setChosen] = useState("");
  const traces = list.data?.traces ?? [];
  const id = traces.some((trace) => trace.id === chosen) ? chosen : (traces[0]?.id ?? "");

  return (
    <Page
      title="Traces"
      intro="Where an agent went in your code, one step at a time: what it read, searched and changed, replayed over the files as they are now."
      action={
        traces.length > 0 && (
          <label className="filter">
            <span className="sr-only">Session</span>
            <select value={id} onChange={(event) => setChosen(event.target.value)}>
              {traces.map((trace) => (
                <option key={trace.id} value={trace.id}>
                  {trace.repo} · {trace.client ?? "agent"} · {moment(trace.startedAt)} · {count(trace.steps)} steps
                </option>
              ))}
            </select>
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
      {id && <Player key={id} id={id} />}
    </Page>
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
const KIND_CLASS: Record<StepKind, string> = {
  read: "k-read",
  edit: "k-edit",
  search: "k-look",
  list: "k-look",
  ask: "k-ask",
};

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
    <div className="trace">
      <dl className="figures four">
        <div>
          <dd>{count(steps.length)}</dd>
          <dt>steps</dt>
        </div>
        <div>
          <dd>{count(opened)}</dd>
          <dt>files read or changed</dt>
        </div>
        <div title="Lines the agent read again although nothing it changed touched them in between: exploration Grenier's cache is there to spare.">
          <dd>{count(again.size)}</dd>
          <dt>reads of lines already read</dt>
        </div>
        <div>
          <dd>
            {money(spent.sofar)}
            <span className="of"> of {money(spent.total)}</span>
          </dd>
          <dt>spent up to this step</dt>
        </div>
      </dl>

      <div className="trace-stage">
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

      <div className="trace-caption" aria-live="polite">
        <span className={`swatch ${KIND_CLASS[step.kind]}`} aria-hidden="true" />
        <p>
          {describeStep(step)}
          {again.has(index) && <span className="again"> · read before, unchanged since</span>}
        </p>
        <span className="hint">{new Date(step.ts).toLocaleTimeString()}</span>
      </div>

      <Timeline steps={steps} at={index} again={again} go={go} />

      <div className="trace-controls">
        <button
          type="button"
          className="quiet step"
          onClick={() => go(index - 1)}
          disabled={index === 0}
          aria-label="Previous step"
        >
          ‹
        </button>
        <button
          type="button"
          className="play"
          onClick={() => {
            if (!playing && index >= last) setAt(0);
            setPlaying(!playing);
          }}
        >
          {playing ? "Pause" : index >= last ? "Replay" : "Play"}
        </button>
        <button
          type="button"
          className="quiet step"
          onClick={() => go(index + 1)}
          disabled={index >= last}
          aria-label="Next step"
        >
          ›
        </button>
        <label className="speed">
          <span className="sr-only">Speed</span>
          <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
            {SPEEDS.map((value) => (
              <option key={value} value={value}>
                {value}× speed
              </option>
            ))}
          </select>
        </label>
        <span className="hint position">
          Step {count(index + 1)} of {count(steps.length)}
        </span>
        <button type="button" className="quiet" onClick={reload}>
          Load new steps
        </button>
      </div>

      <ul className="legend" aria-label="Legend">
        <li>
          <span className="swatch k-read" /> read
        </li>
        <li>
          <span className="swatch k-edit" /> changed
        </li>
        <li>
          <span className="swatch k-look" /> searched or listed
        </li>
        <li>
          <span className="swatch k-ask" /> asked Grenier's cache
        </li>
        <li>
          <span className="swatch k-again" /> read again, unchanged
        </li>
        <li className="hint">Space plays and pauses; the arrow keys step.</li>
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
        className={`arc ${KIND_CLASS[steps[i]?.kind ?? "read"]}${age === 0 && duration > 0 ? " drawing" : ""}`}
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
    <div className="trace-tree" ref={scroller}>
      <div className="tree-body" style={{ height: tree.rows.length * ROW_H }}>
        <svg className="tree-arcs" width={GUTTER} height={tree.rows.length * ROW_H} aria-hidden="true">
          {arcs}
          <g ref={dot} className={KIND_CLASS[kind]}>
            <circle className="halo" r={9} />
            <circle className="head" r={4.5} />
            {duration > 0 && from === row && at > 0 && <circle key={at} className="ping" r={5} />}
          </g>
        </svg>
        {tree.rows.map((entry, r) => {
          const visited = visits[r] ?? 0;
          const firstStep = tree.rowOfStep.indexOf(r);
          const rereads = [...again].filter((i) => i <= at && tree.rowOfStep[i] === r).length;
          const className = `tree-row${r === row ? " current" : ""}${visited === 0 && firstStep !== -1 ? " ahead" : ""}${entry.file ? "" : " dir"}`;
          const style = { top: r * ROW_H, paddingLeft: GUTTER + entry.depth * 12 };
          const name = <span className="name">{entry.label}</span>;
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
              className={className}
              style={style}
              onClick={() => go(nextVisit(r))}
              title={
                visited > 0
                  ? `${entry.key || entry.label}: ${visited} step${visited === 1 ? "" : "s"} so far${rereads ? `, ${rereads} of them reading lines again` : ""}. Click for its next step.`
                  : `${entry.key || entry.label}: not reached yet. Click to jump there.`
              }
            >
              <span className="heat" style={{ width: `${(visited / most) * 100}%` }} aria-hidden="true" />
              {name}
              {visited > 0 && (
                <span className="visits">
                  {rereads > 0 && <span className="again-dot" role="img" aria-label="read again" />}
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
      <div className="trace-code">
        <p className="code-note">The agent has not opened a file yet.</p>
      </div>
    );
  }

  const first = Math.max(0, Math.floor(view.top / LINE_H) - 30);
  const shown = lines.slice(first, first + Math.ceil(view.height / LINE_H) + 60);
  const digits = String(Math.max(lines.length, 1)).length;
  const kind = step?.kind === "edit" ? "k-edit" : "k-read";

  return (
    <div className={`trace-code${active ? "" : " elsewhere"}`}>
      <header className="code-head">
        <span className="code-path" title={path}>
          {path}
        </span>
        {band && step?.startLine !== null && (
          <span className="hint">
            {band.start === band.end ? `line ${band.start}` : `lines ${band.start}–${band.end}`}
          </span>
        )}
        <span className="hint">as it is now</span>
      </header>
      <div
        className="code-scroll"
        ref={scroller}
        onScroll={(event) => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
      >
        {file?.status === "missing" && (
          <p className="code-note">This file cannot be shown: it is gone, binary or too large.</p>
        )}
        {file?.status === "loading" && <p className="code-note">Opening {path}…</p>}
        <div className="code-body" style={{ height: lines.length * LINE_H, ["--gutter" as string]: `${digits + 4}ch` }}>
          {ready && band && (
            <div
              className={`band ${kind}${active ? "" : " faded"}`}
              style={{
                top: (band.start - 1) * LINE_H,
                height: (Math.min(band.end, lines.length) - band.start + 1) * LINE_H,
              }}
              aria-hidden="true"
            />
          )}
          <div
            ref={head}
            className={`reading-head ${kind}${active && band && ready ? "" : " hidden"}`}
            aria-hidden="true"
          />
          <div className="code-lines" style={{ transform: `translateY(${first * LINE_H}px)` }}>
            {shown.map((line, offset) => {
              const number = first + offset + 1;
              return (
                <div className="code-line" key={number}>
                  <span className="ln">{number}</span>
                  <span className="src">
                    {tokens(line).map((token, i) =>
                      token.kind === "plain" ? (
                        token.text
                      ) : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one line never move
                        <span key={i} className={`t-${token.kind}`}>
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
        <div className="code-map" aria-hidden="true" title="Where in this file the agent has been">
          {seen.map((range, i) => {
            const top = ((range.start - 1) / lines.length) * 100;
            const height = ((Math.min(range.end, lines.length) - range.start + 1) / lines.length) * 100;
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the ranges only ever grow at the end
                key={i}
                className={`${KIND_CLASS[range.kind]}${i === seen.length - 1 && active ? " now" : ""}`}
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
    <div className="timeline" style={{ ["--n" as string]: Math.max(1, steps.length) }}>
      <div className="ticks" aria-hidden="true">
        {steps.map((step, i) => (
          <span
            key={step.id}
            className={`tick ${KIND_CLASS[step.kind]}${i <= at ? " past" : ""}${again.has(i) ? " again" : ""}${step.outcome === "error" ? " failed" : ""}`}
          />
        ))}
      </div>
      <input
        className="scrub"
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
