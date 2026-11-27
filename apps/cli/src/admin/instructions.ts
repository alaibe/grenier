import type { InstructionFile, InstructionText } from "@grenier/core/api";
import { Hono } from "hono";
import { z } from "zod";
import { instructionFiles, readInstructions, resetInstructions, writeInstructions } from "../instructions.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyAs, queryId } from "./request.ts";

/** The CLAUDE.md and AGENTS.md files of the work folder's projects and of every project, read and written in place. */
export function instructionRoutes(deps: AdminDeps): Hono {
  const app = new Hono();
  const places = () => ({ workdir: deps.config().machine.workdir, where: deps.where, grenierHome: deps.paths.home });

  app.get("/instructions", (c) =>
    c.json({
      workdir: deps.config().machine.workdir,
      files: instructionFiles(places()) satisfies InstructionFile[],
    }),
  );

  app.get("/instructions/one", async (c) =>
    c.json((await readInstructions(places(), queryId(c))) satisfies InstructionText),
  );

  app.put("/instructions/one", async (c) => {
    const { text, hash } = await bodyAs(c, z.object({ text: z.string(), hash: z.string().nullable().default(null) }));
    return c.json((await writeInstructions(places(), queryId(c), text, hash)) satisfies InstructionText);
  });

  app.delete("/instructions/one", (c) => {
    resetInstructions(places(), queryId(c));
    return c.json({ reset: true });
  });

  return app;
}
