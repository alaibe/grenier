import { joinCode, sha256 } from "@grenier/core";
import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, expect } from "vitest";
import { hash, SETUP_TOKEN, startWorker } from "../../support/worker.ts";

export let mf: Miniflare;
export let call: Awaited<ReturnType<typeof startWorker>>["call"];

beforeEach(async () => {
  ({ mf, call } = await startWorker());
  const setup = await call("/api/setup", SETUP_TOKEN, { body: { member: "ada", device: "ada-mbp" } });
  expect(setup.status).toBe(201);
}, 60_000);

afterEach(async () => {
  await mf.dispose();
});

export const ADA = SETUP_TOKEN;
export const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;

/** Invites someone, joins from a device, and has ada confirm the code; returns the new device's token. */
export async function join(name: string, device = `${name}-mbp`, role: "member" | "admin" = "member"): Promise<string> {
  const invite = await json<{ id: string; secret: string }>(await call("/api/invites", ADA, { body: { name, role } }));
  const token = `gt_${name}_${device}_token_0123456789abcdef0123456789`;
  const nonce = "a".repeat(32);
  const asked = await call("/api/join", undefined, {
    body: { invite: invite.id, secret: invite.secret, device, tokenHash: hash(token), nonce },
  });
  expect(asked.status).toBe(202);
  const code = await joinCode(await sha256(invite.secret), nonce);
  expect((await call("/api/invites/confirm", ADA, { body: { code } })).status).toBe(200);
  return token;
}

let changeId = 0;
export async function push(token: string, record: Record<string, unknown>, baseVersion = 0, check = false) {
  changeId += 1;
  const id = String(record.id);
  return json<{ applied: { version: number }[]; refused: { reason: string }[]; conflicts: { current: unknown }[] }>(
    await call("/api/changes", token, {
      body: {
        changes: [
          {
            id: `change-${changeId}`,
            recordId: id,
            baseVersion,
            changed: Object.keys(record).filter((key) => key !== "id"),
            record,
            check,
          },
        ],
      },
    }),
  );
}

export async function pull(token: string, after = 0) {
  return json<{ records: { id: string; title: string; body: string; top: string; version: number }[] }>(
    await call(`/api/changes?after=${after}`, token),
  );
}
