import type { ViewProps } from "../App.tsx";
import { Page } from "../ui.tsx";
import { Clients } from "./Clients.tsx";
import { Servers } from "./Skills.tsx";

/** What connects agents: the servers the team shares for Claude Code, and the apps here that read Grenier. */
export function Mcp(props: ViewProps) {
  return (
    <Page
      title="MCP"
      intro="How agents connect: the tools the team shares for Claude Code, and the apps on this computer that read Grenier."
    >
      <Servers go={props.go} member={props.member} />
      <Clients {...props} />
    </Page>
  );
}
