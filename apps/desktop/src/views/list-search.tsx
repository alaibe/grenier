import { useMemo, useRef, useState } from "react";
import { type Command, useCommands } from "../shell/commands.tsx";
import { SearchField } from "../ui/field.tsx";
import { toTree } from "../ui/tree.tsx";

/** A list's search field above it, focused by / and ⌘F, and what it narrows the list to. */
export function useListSearch(id: string, label: string, placeholder: string) {
  const [words, setWords] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const query = words.trim().toLowerCase();
  const commands = useMemo<Command[]>(
    () => [
      {
        id,
        label,
        keys: "/",
        also: ["mod+f"],
        hint: { in: "list", says: "search", order: 30 },
        run: () => input.current?.focus(),
      },
    ],
    [id, label],
  );
  useCommands(commands);
  const field = (
    <div className="border-b border-line p-3">
      <SearchField
        ref={input}
        label={label}
        placeholder={placeholder}
        live
        value={words}
        onChange={(event) => setWords(event.currentTarget.value)}
        onKeyDown={toTree}
      />
    </div>
  );
  /** Whether any of these texts holds the words searched for; all do while there are none. */
  const matches = (...texts: (string | null | undefined)[]) =>
    !query || texts.some((text) => text?.toLowerCase().includes(query));
  return { field, words, query, matches };
}
