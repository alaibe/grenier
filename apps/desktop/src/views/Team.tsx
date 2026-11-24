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

export function Team({ changed }: ViewProps) {
  const overview = useLoad(loadOverview);
  if (overview.error) return <Notice message={overview.error} />;
  if (!overview.data) return <Loading what="the team" />;
  const done = () => {
    overview.reload();
    changed();
  };
  if (!overview.data.team) return <Join joined={done} me={overview.data.me ?? ""} />;
  return (
    <>
      {overview.data.outdated && (
        <section className="mb-6 rounded-xl border border-problem bg-problem-soft px-5 py-4">
          <p className="mb-3">
            The team store is older than this Grenier, so sync waits. Whoever reaches its Cloudflare account updates it
            here; the team's records stay.
          </p>
          <Deploy
            name={new URL(overview.data.team.url).hostname.split(".")[0] ?? "grenier-team"}
            me={overview.data.me ?? ""}
            label="Update the team store"
            done={done}
          />
        </section>
      )}
      <Members url={overview.data.team.url} lastSync={overview.data.team.lastSync} />
    </>
  );
}

/** The team store put in a Cloudflare account, or updated there, with an API token used once and not kept. */
function Deploy({ name, me, label, done }: { name: string; me: string; label: string; done: () => void }) {
  const action = useAction(done);
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void action.run("deploy", async () => {
          const made = await api<{ url: string; created: boolean }>("/deploy", {
            body: {
              token: String(form.get("token") ?? ""),
              name: String(form.get("name") ?? name),
              member: String(form.get("member") ?? me),
            },
          });
          return {
            text: made.created
              ? `The team store is at ${made.url}, and you are its admin.`
              : `The team store at ${made.url} is up to date.`,
          };
        });
      }}
    >
      <Notice message={action.message} />
      <p className="text-sm text-muted">
        In Cloudflare, under My Profile › API Tokens, create a token from the template <b>Edit Cloudflare Workers</b>{" "}
        for your account, and paste it here. Grenier uses it for this deploy only, and keeps nothing of it.
      </p>
      <Field>
        Cloudflare API token
        <Input name="token" type="password" autoComplete="off" required />
      </Field>
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <Field>
          Your name in the team
          <Input name="member" defaultValue={me} required />
        </Field>
        <Field>
          The store's name in Cloudflare
          <Input name="name" defaultValue={name} required pattern="[a-z0-9\-]+" />
        </Field>
      </div>
      <div>
        <Button type="submit" disabled={action.busy !== null}>
          {action.busy === "deploy" ? "Deploying…" : label}
        </Button>
      </div>
    </form>
  );
}

function Join({ joined, me }: { joined: () => void; me: string }) {
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
          <section className="rounded-xl border border-line bg-panel px-5 py-4">
            <h2 className="mb-2 font-semibold">Or start a team</h2>
            <p className="mb-3 text-sm text-muted">
              Its store goes in your own Cloudflare account, and you become its admin.
            </p>
            <Deploy name="grenier-team" me={me} label="Create the team" done={joined} />
          </section>
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

  const [web, setWeb] = useState<string | null>(null);
  return (
    <Page
      title="Team"
      intro={
        <>
          {new URL(url).host} · {me.data ? `you are ${me.data.name} (${me.data.role}) on ${me.data.device}` : "…"} ·
          synced {ago(lastSync)}
        </>
      }
      action={
        <div className="flex gap-2">
          <Button
            quiet
            disabled={action.busy !== null}
            title="Sign a browser in to the team's web view, once, within 10 minutes"
            onClick={() =>
              void action.run("web", async () => {
                setWeb(`${url}${(await api<{ path: string }>("/team/weblinks", { method: "POST" })).path}`);
                return undefined;
              })
            }
          >
            Web link
          </Button>
          <Button
            quiet
            disabled={action.busy !== null}
            onClick={() =>
              void action.run("sync", async () => {
                const done = await api<{ pushed: number; pulled: number }>("/sync", { method: "POST" });
                return { text: `Synced: sent ${done.pushed}, took ${done.pulled}.` };
              })
            }
          >
            Sync now
          </Button>
        </div>
      }
    >
      {web && (
        <p className="mb-5 text-sm">
          Open it in a browser within 10 minutes; it signs that browser in once:
          <code className="mt-1 block break-all whitespace-normal select-all">{web}</code>
        </p>
      )}
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
              <code className="mt-2 block break-all whitespace-normal select-all">{link.link}</code>
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

      {admin && <Folders />}
      <Machines />
      {me.data && <Usage key={me.data.role} admin={admin} />}
    </Page>
  );
}

/** The top folders only some members read, as admins make them. */
function Folders() {
  const tops = useLoad(
    useCallback(
      () =>
        api<{ tops: { id: string; kind: string; name?: string; members: string[] | null }[] }>("/team/tops").then(
          (answer) => answer.tops.filter((top) => top.kind === "custom"),
        ),
      [],
    ),
  );
  const action = useAction(tops.reload);
  return (
    <section className="mb-7">
      <h2 className="mb-2.5 font-semibold">Folders for some members</h2>
      <Notice message={tops.error ?? action.message} />
      {tops.data && tops.data.length > 0 && (
        <ul className="mb-3 rounded-xl border border-line bg-panel">
          {tops.data.map((top) => (
            <li key={top.id} className="border-t border-line px-4 py-2 first:border-t-0">
              <b className="font-semibold">{top.name ?? top.id}</b>{" "}
              <span className="text-sm text-muted">{top.members ? top.members.join(", ") : "everyone"}</span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const members = String(form.get("members") ?? "")
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean);
          void action.run("folder", async () => {
            await api("/team/tops", { body: { name: String(form.get("name") ?? ""), members } });
            return { text: "Made: it shows in Knowledge for its members after their next sync." };
          });
        }}
      >
        <Field>
          Name
          <Input name="name" placeholder="leads" required />
        </Field>
        <div className="min-w-56 flex-1">
          <Field>
            Members, comma-separated
            <Input name="members" placeholder="ada, bob" required />
          </Field>
        </div>
        <Button type="submit" disabled={action.busy !== null}>
          Make the folder
        </Button>
      </form>
    </section>
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
