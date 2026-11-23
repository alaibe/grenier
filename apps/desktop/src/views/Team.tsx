import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api, type Invite, type Joining, type Machine, type Member, type Overview, type TeamUsage } from "../api.ts";
import {
  ago,
  Button,
  ConfirmButton,
  Empty,
  Field,
  Input,
  Loading,
  money,
  Notice,
  Page,
  Select,
  Table,
  useAction,
  useLoad,
} from "../ui.tsx";

interface Me {
  name: string;
  role: "admin" | "member";
  device: string;
}

const loadOverview = () => api<Overview>("/overview");
const loadMe = () => api<Me>("/team/me");

/** The team: who is in it and on which machines, invites and their codes, and what each machine spends. */
export function Team({ changed }: ViewProps) {
  const overview = useLoad(loadOverview);
  if (overview.error) return <Notice message={overview.error} />;
  if (!overview.data) return <Loading what="the team" />;
  if (!overview.data.team)
    return (
      <Join
        joined={() => {
          overview.reload();
          changed();
        }}
      />
    );
  return <Members url={overview.data.team.url} lastSync={overview.data.team.lastSync} />;
}

function Join({ joined }: { joined: () => void }) {
  const [state, setState] = useState<Joining | null>(null);
  const action = useAction(() => {});
  useEffect(() => {
    if (state?.state !== "waiting") return;
    const timer = window.setInterval(() => {
      api<Joining>("/join")
        .then((next) => {
          setState(next);
          if (next.state === "joined") joined();
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [state?.state, joined]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const link = String(new FormData(event.currentTarget).get("link") ?? "");
    void action.run("join", async () => {
      setState(await api<Joining>("/join", { body: { link } }));
      return undefined;
    });
  };

  return (
    <Page
      title="Team"
      intro="A team shares one store: what each person and their agents learn, its skills, MCP servers and routines. It lives in the team's own Cloudflare account."
    >
      <Notice message={action.message ?? (state?.state === "failed" ? (state.error ?? "Joining failed.") : null)} />
      {state?.state === "waiting" ? (
        <section className="rounded-xl border border-accent bg-panel px-5 py-5 text-center">
          <p>Read this code to the admin who invited you. They confirm it on their screen.</p>
          <p className="my-3 font-mono text-4xl font-semibold tracking-widest tabular-nums">
            {state.code?.replace(/^(\d{3})(\d{3})$/, "$1 $2")}
          </p>
          <p className="text-sm text-muted">Waiting for the confirmation, up to 10 minutes.</p>
        </section>
      ) : (
        <>
          <form
            className="mb-6 flex items-end gap-2 rounded-xl border border-line bg-panel px-5 py-4"
            onSubmit={submit}
          >
            <div className="flex-1">
              <Field>
                Invite link
                <Input name="link" placeholder="grenier://join/…" required autoComplete="off" spellCheck={false} />
              </Field>
            </div>
            <Button type="submit" disabled={action.busy !== null}>
              Join
            </Button>
          </form>
          <Empty>
            <p>To start a team of your own, deploy its store to your Cloudflare account:</p>
            <code>grenier team deploy</code>
          </Empty>
        </>
      )}
    </Page>
  );
}

function Members({ url, lastSync }: { url: string; lastSync: number | null }) {
  const me = useLoad(loadMe);
  const members = useLoad(useCallback(() => api<{ members: Member[] }>("/team/members").then((a) => a.members), []));
  const admin = me.data?.role === "admin";
  const invites = useLoad(
    useCallback(
      () =>
        admin ? api<{ invites: Invite[] }>("/team/invites").then((a) => a.invites) : Promise.resolve([] as Invite[]),
      [admin],
    ),
  );
  const [link, setLink] = useState<{ member: string; link: string } | null>(null);
  const action = useAction(() => {
    members.reload();
    invites.reload();
    me.reload();
  });

  useEffect(() => {
    if (!admin) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) invites.reload();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [admin, invites.reload]);

  const invite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const role = String(form.get("role") ?? "member");
    void action.run("invite", async () => {
      const made = await api<{ id: string; secret: string; member: string }>("/team/invites", {
        body: { name, role },
      });
      setLink({ member: made.member, link: `grenier://join/${new URL(url).host}/${made.id}/${made.secret}` });
      return undefined;
    });
  };

  const call = (key: string, path: string, method: string, body?: unknown) =>
    void action.run(key, async () => {
      await api(path, { method, ...(body === undefined ? {} : { body }) });
      return undefined;
    });

  return (
    <Page
      title="Team"
      intro={
        <>
          {new URL(url).host} · {me.data ? `you are ${me.data.name} (${me.data.role}) on ${me.data.device}` : "…"} ·
          synced {ago(lastSync)}
        </>
      }
    >
      <Notice message={members.error ?? me.error ?? action.message} />
      {invites.data?.some((entry) => entry.code) && (
        <section className="mb-6 rounded-xl border border-accent bg-accent-soft px-5 py-4" aria-label="Waiting to join">
          {invites.data
            .filter((entry) => entry.code)
            .map((entry) => (
              <div key={entry.id} className="flex items-center justify-between gap-4 py-1">
                <p>
                  <b className="font-semibold">{entry.member}</b> asks to join on {entry.device}, showing{" "}
                  <span className="font-mono text-lg font-semibold tracking-wider">
                    {entry.code?.replace(/^(\d{3})(\d{3})$/, "$1 $2")}
                  </span>
                  . Confirm only if it is the code on their screen.
                </p>
                <Button
                  disabled={action.busy !== null}
                  onClick={() => call(`confirm:${entry.id}`, "/team/invites/confirm", "POST", { code: entry.code })}
                >
                  It matches
                </Button>
              </div>
            ))}
        </section>
      )}

      <h2 className="mb-2.5 font-semibold">Members</h2>
      {!members.data && !members.error && <Loading what="members" />}
      {members.data && (
        <div className="mb-7">
          <Table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Machines</th>
                {admin && <th />}
              </tr>
            </thead>
            <tbody>
              {members.data.map((member) => (
                <tr key={member.name}>
                  <td className="font-medium">{member.name}</td>
                  <td>{member.role}</td>
                  <td>
                    {member.devices.map((device) => (
                      <span key={device.id} className="mr-3 inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span
                          className={`size-2 rounded-full ${device.state === "offline" ? "bg-line-strong" : device.state === "available" ? "bg-edit" : "bg-accent"}`}
                          title={device.state}
                        />
                        {device.name}
                      </span>
                    ))}
                  </td>
                  {admin && (
                    <td className="text-right whitespace-nowrap">
                      <Button
                        quiet
                        className="mr-2"
                        disabled={action.busy !== null}
                        onClick={() =>
                          call(`role:${member.name}`, `/team/members/${encodeURIComponent(member.name)}/role`, "PUT", {
                            role: member.role === "admin" ? "member" : "admin",
                          })
                        }
                      >
                        {member.role === "admin" ? "Make member" : "Make admin"}
                      </Button>
                      {member.name !== me.data?.name && (
                        <ConfirmButton
                          label="Remove"
                          question={`Remove ${member.name} and their machines?`}
                          disabled={action.busy !== null}
                          onConfirm={() =>
                            call(`remove:${member.name}`, `/team/members/${encodeURIComponent(member.name)}`, "DELETE")
                          }
                        />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}

      {admin && (
        <section className="mb-7">
          <h2 className="mb-2.5 font-semibold">Invite</h2>
          {link && (
            <div className="mb-3 rounded-xl border border-accent bg-panel px-5 py-4" role="status">
              <p>
                Send this link to {link.member}. It works once, for 24 hours; their machine then shows a code they read
                to you, and you confirm it here.
              </p>
              <code className="mt-2 block font-mono text-sm break-all select-all">{link.link}</code>
            </div>
          )}
          <form className="flex items-end gap-2" onSubmit={invite}>
            <div className="flex-1">
              <Field>
                Name
                <Input name="name" required placeholder="A new member, or a member's new machine" />
              </Field>
            </div>
            <Field>
              Role
              <Select name="role" defaultValue="member">
                <option value="member">member</option>
                <option value="admin">admin</option>
              </Select>
            </Field>
            <Button type="submit" disabled={action.busy !== null}>
              Create link
            </Button>
          </form>
        </section>
      )}

      <Machines />
      {me.data && <Usage key={me.data.role} admin={admin} />}
    </Page>
  );
}

function Machines() {
  const { data, error } = useLoad(
    useCallback(() => api<{ machines: Machine[] }>("/team/machines").then((a) => a.machines), []),
  );
  if (error) return <Notice message={error} />;
  if (!data) return null;
  return (
    <section className="mb-7">
      <h2 className="mb-2.5 font-semibold">Machines</h2>
      <Table>
        <thead>
          <tr>
            <th>Machine</th>
            <th>Member</th>
            <th>State</th>
            <th>Last seen</th>
            <th className="text-right tabular-nums">Runs, 30 days</th>
          </tr>
        </thead>
        <tbody>
          {data.map((machine) => (
            <tr key={machine.id}>
              <td className="font-medium">{machine.name}</td>
              <td>{machine.member}</td>
              <td>{machine.state}</td>
              <td>{ago(machine.lastSeen)}</td>
              <td className="text-right tabular-nums">{machine.runs ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

type By = "member" | "machine" | "day" | "repo";

/** What the agents cost, priced at API rates: an admin sees everyone's, a member their own. */
function Usage({ admin }: { admin: boolean }) {
  const [by, setBy] = useState<By>(admin ? "member" : "machine");
  const { data, error } = useLoad(
    useCallback(() => api<{ usage: TeamUsage[] }>("/team/usage").then((a) => a.usage), []),
  );
  if (error) return <Notice message={error} />;
  if (!data) return null;
  const rows = new Map<string, { requests: number; cost: number; minutes: number }>();
  for (const row of data) {
    const key = row[by] || "(no repository)";
    const total = rows.get(key) ?? { requests: 0, cost: 0, minutes: 0 };
    rows.set(key, {
      requests: total.requests + row.requests,
      cost: total.cost + row.cost,
      minutes: total.minutes + row.routine_minutes,
    });
  }
  return (
    <section className="mb-7">
      <div className="mb-2.5 flex items-center justify-between">
        <h2 className="font-semibold">{admin ? "Usage, last 30 days" : "Your usage, last 30 days"}</h2>
        <Select aria-label="Group by" value={by} onChange={(event) => setBy(event.currentTarget.value as By)}>
          {(admin ? (["member", "machine", "day", "repo"] as const) : (["machine", "day", "repo"] as const)).map(
            (name) => (
              <option key={name} value={name}>
                By {name}
              </option>
            ),
          )}
        </Select>
      </div>
      {rows.size === 0 ? (
        <Empty>No usage reported yet.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className="capitalize">{by}</th>
              <th className="text-right tabular-nums">Requests</th>
              <th className="text-right tabular-nums">Routine minutes</th>
              <th className="text-right tabular-nums">API cost</th>
            </tr>
          </thead>
          <tbody>
            {[...rows.entries()]
              .sort(([a, x], [b, y]) => (by === "day" ? b.localeCompare(a) : y.cost - x.cost))
              .map(([key, total]) => (
                <tr key={key}>
                  <td>{key}</td>
                  <td className="text-right tabular-nums">{total.requests}</td>
                  <td className="text-right tabular-nums">{Math.round(total.minutes)}</td>
                  <td className="text-right tabular-nums">{money(total.cost)}</td>
                </tr>
              ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
