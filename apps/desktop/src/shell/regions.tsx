import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { store, stored } from "../storage.ts";
import { PrimaryScope } from "../ui/button.tsx";

/** The shell's regions, for F6 and for where focus starts (patterns/app-shell.md#focus-and-landmarks). */
export type RegionName = "sidebar" | "list" | "detail";

/** What the title bar shows after the place, set by the screen: the open record's title. */
const ItemTitle = createContext<(title: string | null) => void>(() => {});

export const ItemTitleProvider = ItemTitle.Provider;

/** Names the open item in the title bar and the window's title while the screen shows it. */
export function useItemTitle(title: string | null | undefined) {
  const set = useContext(ItemTitle);
  useEffect(() => {
    set(title || null);
    return () => set(null);
  }, [set, title]);
}

const LIST = { key: "grenier.list", width: 360, min: 280, max: 480 };

function savedWidth(): number {
  const width = Number(stored(LIST.key, LIST.width));
  return width >= LIST.min && width <= LIST.max ? width : LIST.width;
}

/** The detail of a screen without a list: a dashboard, settings. Its page header scrolls with it. */
export function Detail({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="content">
      <section className="region-detail" data-region="detail" tabIndex={-1} aria-label={title}>
        <PrimaryScope name={title}>{children}</PrimaryScope>
      </section>
    </main>
  );
}

/** A list of the place's items beside the open one (layout.md#window-regions); the list resizes from 280 to 480. */
export function ListDetail({ title, list, children }: { title: string; list: ReactNode; children: ReactNode }) {
  const [width, setWidth] = useState(savedWidth);
  const keep = (final: number) => {
    setWidth(final);
    store(LIST.key, final);
  };
  return (
    <main className="content" data-list style={{ "--list-width": `${width}px` } as React.CSSProperties}>
      <section className="region-list" data-region="list" aria-label={`${title}: list`}>
        {list}
        <Resizer
          width={width}
          min={LIST.min}
          max={LIST.max}
          onResize={setWidth}
          onDone={keep}
          onReset={() => keep(LIST.width)}
        />
      </section>
      <section className="region-detail" data-region="detail" tabIndex={-1} aria-label={title}>
        <PrimaryScope name={title}>{children}</PrimaryScope>
      </section>
    </main>
  );
}

/** How far an arrow key moves the list's edge; with Shift, further. */
const STEP = 8;
const SHIFT_STEP = 40;

/**
 * A region's right edge: drag it, or focus it and press ← →, to resize between `min` and `max`; double-click or Enter
 * resets it. The width is kept once the drag or the key is done.
 */
function Resizer({
  width,
  min,
  max,
  onResize,
  onDone,
  onReset,
}: {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onDone: (width: number) => void;
  onReset: () => void;
}) {
  const clamp = (value: number) => Math.round(Math.max(min, Math.min(max, value)));
  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable edge, which an <hr> can't be
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the list"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className="resizer"
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const by = event.shiftKey ? SHIFT_STEP : STEP;
        const next =
          event.key === "ArrowLeft"
            ? clamp(width - by)
            : event.key === "ArrowRight"
              ? clamp(width + by)
              : event.key === "Home"
                ? min
                : event.key === "End"
                  ? max
                  : null;
        if (event.key === "Enter") {
          event.preventDefault();
          onReset();
        } else if (next !== null) {
          event.preventDefault();
          event.stopPropagation();
          onDone(next);
        }
      }}
      onPointerDown={(event) => {
        const edge = event.currentTarget;
        edge.setPointerCapture(event.pointerId);
        const left = edge.parentElement?.getBoundingClientRect().left ?? 0;
        let last = width;
        const move = (next: PointerEvent) => {
          last = clamp(next.clientX - left);
          onResize(last);
        };
        const stop = () => {
          edge.removeEventListener("pointermove", move);
          edge.removeEventListener("pointerup", stop);
          edge.removeEventListener("pointercancel", stop);
          onDone(last);
        };
        edge.addEventListener("pointermove", move);
        edge.addEventListener("pointerup", stop);
        edge.addEventListener("pointercancel", stop);
      }}
    />
  );
}

/** An open item's text under its bar, at reading width; `gap` spaces its parts as a grid. */
export function Reading({ gap, children }: { gap?: "gap-4" | "gap-6"; children: ReactNode }) {
  return (
    <div className={`mx-auto w-full max-w-(--layout-reading) px-6 pt-10 pb-24${gap ? ` grid ${gap}` : ""}`}>
      {children}
    </div>
  );
}

/** An open item's name, at the top of its text. */
export function ItemName({ children }: { children: ReactNode }) {
  return <h1 className="font-mono text-xl leading-tight font-semibold tracking-tight">{children}</h1>;
}

/** The line under an item's name that says what it is. */
export function ItemMeta({ children }: { children: ReactNode }) {
  return <p className="mt-2 font-mono text-xs text-muted">{children}</p>;
}

/** A detail's top row, which stays as the page scrolls: where the item is, then its actions. */
export function DetailBar({ crumb, title, children }: { crumb: ReactNode; title?: string; children?: ReactNode }) {
  return (
    <header className="sticky top-0 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-bg px-4 font-mono text-sm">
      <p className="min-w-0 flex-1 truncate text-muted" title={title}>
        {crumb}
      </p>
      {children}
    </header>
  );
}
