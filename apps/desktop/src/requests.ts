interface RoutineRow {
  id: string;
  title: string;
  fields: Record<string, unknown>;
}

/** Whether people file requests for a routine: a scheduled one runs on its own. */
export function takesRequests(routine: RoutineRow): boolean {
  return (routine.fields.trigger ?? "request") === "request";
}

/** The routine a task or a run is for, by name, whatever starts it. */
export function routineTitle(routines: readonly RoutineRow[] | null, id: unknown): string {
  return routines?.find((routine) => routine.id === id)?.title ?? "a routine";
}
