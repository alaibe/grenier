import type { InstructionFile, InstructionText } from "@grenier/core/api";
import { Hono } from "hono";
import { instructionFiles, readInstructions, writeInstructions } from "../instructions.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyOf } from "./body.ts";

/** The CLAUDE.md and AGENTS.md files of the work folder's projects and of every project, read and written in place. */
export function instructionRoutes(deps: AdminDeps): Hono {
  const app = new Hono();
  const workdir = () => deps.config().machine.workdir;
  const home = deps.where.home;
  const id = (query: string | undefined) => String(query ?? "");

  app.get("/instructions", (c) =>
    c.json({ workdir: workdir(), files: instructionFiles(workdir(), home) satisfies InstructionFile[] }),
  );

  app.get("/instructions/one", async (c) =>
    c.json((await readInstructions(workdir(), home, id(c.req.query("id")))) satisfies InstructionText),
  );

  app.put("/instructions/one", async (c) => {
    const body = await bodyOf(c);
    const hash = typeof body.hash === "string" ? body.hash : null;
    return c.json(
      (await writeInstructions(
        workdir(),
        home,
        id(c.req.query("id")),
        String(body.text ?? ""),
        hash,
      )) satisfies InstructionText,
    );
  });

  return app;
}
