import { Fragment, type ReactNode } from "react";
import { caps, type Shortcut } from "./keys.ts";

/** One key, as on the keyboard (components/keycap.md). */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** A shortcut: one cap per key, the steps of a sequence joined by "then". */
export function Keys({ shortcut }: { shortcut: Shortcut }) {
  const steps = caps(shortcut);
  if (steps.length === 1 && steps[0]?.length === 1) return <Kbd>{steps[0][0]}</Kbd>;
  return (
    <span className="keys">
      {steps.map((step, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the steps of a shortcut have no other identity
        <Fragment key={index}>
          {index > 0 && <span className="keys-then">then</span>}
          {step.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </Fragment>
      ))}
    </span>
  );
}
