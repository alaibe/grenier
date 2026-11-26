import { describe, expect, it } from "vitest";
import { serverName } from "../../../packages/core/src/server-name.ts";

describe("a server's name from the MCP Registry", () => {
  it("is its last part, or its namespace's when that part only says mcp", () => {
    expect(serverName("io.github.getsentry/sentry-mcp")).toBe("sentry-mcp");
    expect(serverName("com.cloudflare.mcp/mcp")).toBe("cloudflare");
    expect(serverName("io.github.acme/mcp-server")).toBe("acme");
    expect(serverName("mcp")).toBe("mcp");
  });
});
