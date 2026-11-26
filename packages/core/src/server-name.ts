const GENERIC = /^(mcp|server|mcp-server|mcpserver)$/i;
const DOMAIN = /^(com|io|org|net|dev|ai|app|co|github)$/i;

/** A name for a server found in the MCP Registry: its last part, unless that only says "mcp", then its namespace's. */
export function serverName(registryName: string): string {
  const [namespace = "", last = ""] = registryName.split("/");
  if (last && !GENERIC.test(last)) return last;
  return (
    namespace
      .split(".")
      .filter((part) => part && !DOMAIN.test(part) && !GENERIC.test(part))
      .at(-1) ??
    (last || registryName)
  );
}
