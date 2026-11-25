import type { KeyboardEvent } from "react";

/** One of two to four modes or filters (components/tabs.md#segmented-anatomy); arrows move and pick. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
}) {
  const at = options.findIndex(([key]) => key === value);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const by =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!by) return;
    event.preventDefault();
    const next = options[(at + by + options.length) % options.length];
    if (!next) return;
    onChange(next[0]);
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
    buttons[(at + by + options.length) % options.length]?.focus();
  };
  return (
    <div className="segmented" role="radiogroup" aria-label={label} onKeyDown={keyDown}>
      {options.map(([key, name]) => (
        // biome-ignore lint/a11y/useSemanticElements: a segment is a button that acts as a radio (components/tabs.md)
        <button
          type="button"
          key={key}
          className="segment"
          role="radio"
          aria-checked={key === value}
          tabIndex={key === value ? 0 : -1}
          onClick={() => onChange(key)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
