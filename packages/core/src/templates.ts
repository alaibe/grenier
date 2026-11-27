import type { RoutineMode } from "./routines.ts";

/** What a new routine's form can start from: it only fills the form in, and the admin creates a routine of their own. */
export interface RoutineTemplate {
  id: string;
  title: string;
  schedule: string;
  prompt: string;
  mode: RoutineMode;
}

export const ROUTINE_TEMPLATES: readonly RoutineTemplate[] = [
  {
    id: "keeper",
    title: "Instructions keeper",
    schedule: "fri 16:00",
    mode: "read-only",
    prompt: [
      "Suggest how each project's CLAUDE.md and AGENTS.md should change, from what the team keeps in Grenier. Never edit those files.",
      "",
      "For each git repository in the work folder: read its CLAUDE.md and AGENTS.md, then call get with the questions they should answer, and for the team's conventions and decisions about the project. Where one is missing from them, or they say what has since changed, call set with the folder Team/<repository>, where <repository> is the name of the repository's folder, the title \"Instructions to update\", and, as Markdown, the exact lines to add, change or remove, each with the page it comes from.",
      "",
      "End with the repositories you wrote a page for, or none.",
    ].join("\n"),
  },
];
