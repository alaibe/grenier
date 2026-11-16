import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";

/** `grenier resume <session>`: lets a session the loop guard paused continue. */
export async function resume(argv: string[], io: Io): Promise<string> {
  const [id, ...rest] = argv;
  if (id === undefined || rest.length > 0)
    throw new UsageError("resume takes one session id: grenier resume <session>");
  const { paths } = environment(io);
  return withStore(paths, async (store) => {
    const session = await store.sessions.get(id);
    if (!session) throw new CommandError(`no session "${id}"`);
    if (!session.paused) return `Session ${id} is not paused.`;
    await store.sessions.setPaused(id, false);
    await store.events.add({ sessionId: id, ts: Date.now(), kind: "resume", detail: null });
    return `Session ${id} resumed.`;
  });
}
