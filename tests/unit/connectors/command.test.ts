import { commandWords } from "@grenier/connectors";
import { describe, expect, it } from "vitest";

describe("commandWords", () => {
  it("splits a command line as a shell would, without running one", () => {
    expect(commandWords("op read 'op://Personal/Mail/password'")).toEqual([
      "op",
      "read",
      "op://Personal/Mail/password",
    ]);
    expect(commandWords('security find-generic-password -s "grenier mail" -w')).toEqual([
      "security",
      "find-generic-password",
      "-s",
      "grenier mail",
      "-w",
    ]);
    expect(commandWords("pass\\ word  ''")).toEqual(["pass word", ""]);
    expect(() => commandWords("op read 'open")).toThrow("left open");
  });
});
