export interface DiffLine {
  kind: "same" | "gone" | "new";
  text: string;
}

const MAX_CELLS = 4_000_000;

/** The lines of `before` and `now`, each kept, gone or new; null when the changed middle is too long to compare. */
export function lineDiff(before: string, now: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = now.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_CELLS) return null;
  const width = midB.length + 1;
  const table = new Uint32Array((midA.length + 1) * width);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      table[i * width + j] =
        midA[i] === midB[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
    }
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      out.push({ kind: "same", text: midA[i++] as string });
      j++;
    } else if (
      j < midB.length &&
      (i === midA.length || (table[i * width + j + 1] as number) >= (table[(i + 1) * width + j] as number))
    ) {
      out.push({ kind: "new", text: midB[j++] as string });
    } else {
      out.push({ kind: "gone", text: midA[i++] as string });
    }
  }
  for (const text of a.slice(endA)) out.push({ kind: "same", text });
  return out;
}

/** The changed lines with `context` kept lines around each run of changes; null stands for the lines left out. */
export function hunks(lines: readonly DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = lines.map(() => false);
  lines.forEach((line, n) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, n - context); k <= Math.min(lines.length - 1, n + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((line, n) => {
    if (keep[n]) out.push(line);
    else if (out.at(-1) !== null) out.push(null);
  });
  return out;
}
