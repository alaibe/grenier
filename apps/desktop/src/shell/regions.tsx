import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
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
  try {
    const width = Number(localStorage.getItem(LIST.key));
    return width >= LIST.min && width <= LIST.max ? width : LIST.width;
  } catch {
    return LIST.width;
  }
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
  useEffect(() => {
    try {
      localStorage.setItem(LIST.key, String(width));
    } catch {}
  }, [width]);
  return (
    <main className="content" data-list style={{ "--list-width": `${width}px` } as React.CSSProperties}>
      <section className="region-list" data-region="list" aria-label={`${title}: list`}>
        {list}
        <Resizer min={LIST.min} max={LIST.max} onResize={setWidth} onReset={() => setWidth(LIST.width)} />
      </section>
      <section className="region-detail" data-region="detail" tabIndex={-1} aria-label={title}>
        <PrimaryScope name={title}>{children}</PrimaryScope>
      </section>
    </main>
  );
}

/** A region's right edge: drag to resize between `min` and `max`, double-click to reset. */
export function Resizer({
  min,
  max,
  onResize,
  onReset,
}: {
  min: number;
  max: number;
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable edge, which an <hr> can't be
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize"
      className="resizer"
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        const edge = event.currentTarget;
        edge.setPointerCapture(event.pointerId);
        const left = edge.parentElement?.getBoundingClientRect().left ?? 0;
        const move = (next: PointerEvent) => onResize(Math.round(Math.max(min, Math.min(max, next.clientX - left))));
        const stop = () => {
          edge.removeEventListener("pointermove", move);
          edge.removeEventListener("pointerup", stop);
        };
        edge.addEventListener("pointermove", move);
        edge.addEventListener("pointerup", stop);
      }}
    />
  );
}
