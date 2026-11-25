import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * A screen's page header and content (patterns/app-shell.md#regions): its title, a one-line intro, its actions on the
 * right with the screen's one `primary` last.
 */
export function Page({
  title,
  intro,
  actions,
  primary,
  children,
}: {
  title: string;
  intro?: ReactNode;
  /** Secondary or ghost buttons. */
  actions?: ReactNode;
  /** The one action the screen is for: a `Primary`. */
  primary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col px-6 pt-6 pb-12">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-mono text-xl leading-tight font-semibold tracking-tight">{title}</h1>
          {intro && <p className="mt-1 max-w-[68ch] text-muted">{intro}</p>}
        </div>
        {(actions || primary) && (
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            {primary}
          </div>
        )}
      </header>
      <div className="flex flex-1 flex-col gap-4">{children}</div>
    </div>
  );
}

/**
 * Related content under a heading, on the page itself, with lines and no box (components/section.md). A page's main
 * sections take a `heading`; the parts inside them a label.
 */
export function Section({
  title,
  heading = false,
  description,
  actions,
  collapsible,
  danger = false,
  children,
}: {
  title: string;
  heading?: boolean;
  description?: ReactNode;
  actions?: ReactNode;
  /** Folded or not, kept under this key per person. */
  collapsible?: string;
  danger?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(() => !collapsible || readFolded(collapsible) === false);
  const Title = heading ? "h2" : "h3";
  const name = heading ? "section-heading" : "label";
  return (
    <section className={danger ? "section section-raised section-danger" : "section"}>
      <header className="section-header">
        <div>
          <Title className={collapsible ? undefined : name}>
            {collapsible ? (
              <button
                type="button"
                className={`${name} inline-flex cursor-pointer items-center gap-1`}
                aria-expanded={open}
                onClick={() => {
                  setOpen(!open);
                  writeFolded(collapsible, open);
                }}
              >
                <ChevronRight
                  className={`icon size-3 transition-transform duration-120 ${open ? "rotate-90" : ""}`}
                  aria-hidden="true"
                />
                {title}
              </button>
            ) : (
              title
            )}
          </Title>
          {description && <p className="section-desc">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {open && children}
    </section>
  );
}

const FOLDED = "grenier.folded";

function readFolded(key: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(FOLDED) ?? "{}") as Record<string, boolean>)[key] ?? true;
  } catch {
    return true;
  }
}

function writeFolded(key: string, folded: boolean) {
  try {
    const all = JSON.parse(localStorage.getItem(FOLDED) ?? "{}") as Record<string, boolean>;
    localStorage.setItem(FOLDED, JSON.stringify({ ...all, [key]: folded }));
  } catch {}
}

/** One line of a section: its label and what it means on the left, a control or a value on the right. */
export function SectionRow({
  label,
  description,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="section-row">
      <div className="min-w-0">
        <div>{label}</div>
        {description && <div className="section-desc">{description}</div>}
      </div>
      {children}
    </div>
  );
}
