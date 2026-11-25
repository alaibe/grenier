import { Check } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

type Box = Omit<ComponentProps<"input">, "type" | "className" | "style" | "children">;

/** A setting that takes effect the moment it is flipped: its label and what it means left, the switch right. */
export function Toggle({ label, description, ...props }: Box & { label: ReactNode; description?: ReactNode }) {
  return (
    <label className="choice choice-setting">
      <span>
        {label}
        {description && <span className="choice-desc">{description}</span>}
      </span>
      <input className="choice-input" type="checkbox" role="switch" aria-checked={props.checked} {...props} />
      <span className="toggle" aria-hidden="true" />
    </label>
  );
}

/** A choice a button confirms later, or one of several picked in a form. */
export function Checkbox({ label, description, ...props }: Box & { label: ReactNode; description?: ReactNode }) {
  return (
    <label className="choice">
      <input className="choice-input" type="checkbox" {...props} />
      <span className="checkbox" aria-hidden="true">
        <Check className="icon" />
      </span>
      <span>
        {label}
        {description && <span className="choice-desc">{description}</span>}
      </span>
    </label>
  );
}
