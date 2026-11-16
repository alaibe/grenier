import type { Source } from "@grenier/store";
import { pullCalDav, pullIcs } from "./calendar.ts";
import { pullImap } from "./imap.ts";
import { pullMarkdown } from "./markdown.ts";
import type { Pull } from "./source.ts";

/** The connector for a source's kind. The memory source has none: approved memories are written directly. */
export function pullSource(source: Pick<Source, "kind" | "config" | "state">): Promise<Pull> | null {
  switch (source.kind) {
    case "markdown":
      return pullMarkdown(source.config, source.state);
    case "ics":
      return pullIcs(source.config, source.state);
    case "caldav":
      return pullCalDav(source.config, source.state);
    case "imap":
      return pullImap(source.config, source.state);
    case "memory":
      return null;
  }
}
