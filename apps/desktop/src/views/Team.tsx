import type {
  Deployed,
  Invite,
  InviteMade,
  Joining,
  Machine,
  MadeLink,
  Member,
  Overview,
  TeamMe,
  TeamUsage,
} from "@grenier/core/api";
import { ArrowRight, Check, Link, RefreshCw, Trash2, UserCog, UserPlus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { ago, exact, money, since } from "../format.ts";
import { type Command, useCommands } from "../shell/commands.tsx";
import { Detail } from "../shell/regions.tsx";
import { stateTag } from "../states.ts";
import { Avatar } from "../ui/avatar.tsx";
import { Button, Primary } from "../ui/button.tsx";
import { Dialog, useConfirm } from "../ui/dialog.tsx";
import { Skeleton } from "../ui/empty.tsx";
import { Field, Input, Select } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Menu } from "../ui/menu.tsx";
import { Notice, Problem } from "../ui/notice.tsx";
import { Page, Section } from "../ui/page.tsx";
import { Secret } from "../ui/secret.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { Stat, Stats } from "../ui/stat.tsx";
import { RowActions, Table } from "../ui/table.tsx";
import { Status, Tag } from "../ui/tag.tsx";
import { usePolling } from "./polling.ts";

const loadOverview = () => api<Overview>("/overview");
const loadMe = () => api<TeamMe>("/team/me");

export function Team({ item, go, changed }: ViewProps) {
  const overview = useLoad(loadOverview);
  const done = () => {
    overview.reload();
    changed();
  };
  const content = overview.error ? (
    <div className="p-6">
      <Problem error={overview.error} />
    </div>
  ) : !overview.data ? (
    <div className="p-6">
      <Skeleton rows={6} shape="table" />
    </div>
  ) : !overview.data.team ? (
    <Join
      joined={done}
      me={overview.data.me}
      creating={item === "new"}
      setCreating={(open) => go("team", open ? "new" : undefined)}
    />
  ) : (
    <Members
      url={overview.data.team.url}
      lastSync={overview.data.team.lastSync}
      outdated={overview.data.outdated}
      me={overview.data.me}
      done={done}
      inviting={item === "invite"}
      setInviting={(open) => go("team", open ? "invite" : undefined)}
    />
  );
  return <Detail title="Team">{content}</Detail>;
}

/** The six digits a joining machine shows, read as "123 456". */
const spaced = (code: string | null | undefined) => code?.replace(/^(\d{3})(\d{3})$/, "$1 $2") ?? "";

/** The team store put in a Cloudflare account, or updated there, with an API token used once and not kept. */
function Deploy({
  name,
  me,
  title,
  action: verb,
  done,
  cancel,
}: {
  name: string;
  me: string;
  title: string;
  action: string;
  done: () => void;
  cancel: () => void;
}) {
  const action = useAction(done);
  return (
    <Dialog
      wide
      title={title}
      action={verb}
      busy={action.busy !== null}
      onCancel={cancel}
      onAction={(form) =>
        void action.run(
          "deploy",
          async () => {
            const made = await api<Deployed>("/deploy", {
              body: {
                token: String(form.get("token") ?? ""),
                name: String(form.get("name") ?? name),
                member: String(form.get("member") ?? me),
              },
            });
            return made.created
              ? `The team store is at ${made.url}, and you are its admin`
              : `Updated the team store at ${made.url}`;
          },
          "Deploying",
        )
      }
    >
      <p>
        In Cloudflare, under My Profile › API Tokens, create a token from the template{" "}
        <strong>Edit Cloudflare Workers</strong> for your account, and paste it here. Grenier uses it for this deploy
        only, and keeps nothing of it.
      </p>
      <Problem error={action.problem} />
      <Field label="Cloudflare API token">
        <Input name="token" type="password" mono autoComplete="off" required />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Your name">
          <Input name="member" defaultValue={me} required />
        </Field>
        <Field label="Store name" help="Its name in Cloudflare.">
          <Input name="name" mono defaultValue={name} required pattern="[a-z0-9\-]+" />
        </Field>
      </div>
    </Dialog>
  );
}

function Join({
  joined,
  me,
  creating,
  setCreating,
}: {
  joined: () => void;
  me: string;
  creating: boolean;
  setCreating: (open: boolean) => void;
}) {
  const [state, setState] = useState<Joining | null>(null);
  const action = useAction();
  const poll = useCallback(() => {
    api<Joining>("/join")
      .then((next) => {
        setState(next);
        if (next.state === "joined") joined();
      })
      .catch(() => {});
  }, [joined]);
  usePolling(poll, state?.state === "waiting" ? 2000 : null);

  return (
    <Page
      title="Team"
      intro="A team shares one store: what each person and their agents learn, its skills, MCP servers and routines. It lives in the team's own Cloudflare account."
    >
      <Problem error={action.problem ?? (state?.state === "failed" ? (state.error ?? "Joining failed.") : null)} />
      {state?.state === "waiting" ? (
        <>
          <Notice kind="accent" tag="WAITING" more="Waiting for the confirmation, up to 10 minutes.">
            Read this code to the admin who invited you. They confirm it on their screen.
          </Notice>
          <div className="max-w-80">
            <Stats columns={2}>
              <Stat label="Your code" value={spaced(state.code)} lit />
              <Stat label="Admin confirms" value="…" />
            </Stats>
          </div>
        </>
      ) : (
        <>
          <form
            className="flex max-w-(--layout-reading) items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const link = String(new FormData(event.currentTarget).get("link") ?? "");
              void action.run(
                "join",
                async () => {
                  setState(await api<Joining>("/join", { body: { link } }));
                  return undefined;
                },
                "Joining",
              );
            }}
          >
            <div className="flex-1">
              <Field label="Invite link">
                <Input name="link" mono placeholder="grenier://join/…" required autoComplete="off" spellCheck={false} />
              </Field>
            </div>
            <Primary type="submit" busy={action.busy !== null}>
              Join
            </Primary>
          </form>
          <Section
            heading
            title="Or start a team"
            description="Its store goes in your own Cloudflare account, and you become its admin."
            actions={
              <Button trailing={ArrowRight} onClick={() => setCreating(true)}>
                Create a team…
              </Button>
            }
          />
        </>
      )}
      {creating && (
        <Deploy
          name="grenier-team"
          me={me}
          title="Create a team"
          action="Create the team"
          done={joined}
          cancel={() => setCreating(false)}
        />
      )}
    </Page>
  );
}

function Members({
  url,
  lastSync,
  outdated,
  me: name,
  done,
  inviting,
  setInviting,
}: {
  url: string;
  lastSync: number | null;
  outdated: boolean;
  me: string;
  done: () => void;
  inviting: boolean;
  setInviting: (open: boolean) => void;
}) {
  const me = useLoad(loadMe);
  const members = useLoad(useCallback(() => api<{ members: Member[] }>("/team/members").then((a) => a.members), []));
  const admin = me.data?.role === "admin";
  const [signedOut, setSignedOut] = useState(false);
  const [updating, setUpdating] = useState(false);
  const invites = useLoad(
    useCallback(
      () =>
        admin ? api<{ invites: Invite[] }>("/team/invites").then((a) => a.invites) : Promise.resolve([] as Invite[]),
      [admin],
    ),
  );
  const [link, setLink] = useState<{ member: string; link: string } | null>(null);
  const [web, setWeb] = useState<string | null>(null);
  const action = useAction(() => {
    members.reload();
    invites.reload();
    me.reload();
  });
  const { ask, dialog } = useConfirm();
  usePolling(invites.reload, admin && !signedOut ? 3000 : null);

  const call = (key: string, path: string, method: string, body: unknown, said: string, undo?: () => void) =>
    void action.run(key, async () => {
      await api(path, { method, ...(body === undefined ? {} : { body }) });
      return undo ? { text: said, undo } : said;
    });
  const setRole = (member: Member, role: string) =>
    call(
      `role:${member.name}`,
      `/team/members/${encodeURIComponent(member.name)}/role`,
      "PUT",
      { role },
      `${member.name} is ${role === "admin" ? "an admin" : "a member"} now`,
      () => setRole(member, member.role),
    );

  // biome-ignore lint/correctness/useExhaustiveDependencies: makeWeb reads the action as it is when it runs
  const commands = useMemo<Command[]>(
    () =>
      admin
        ? [
            {
              id: "team.invite",
              label: "Invite someone",
              icon: UserPlus,
              keys: "n",
              also: ["mod+n"],
              hint: { in: "list", says: "invite", order: 20 },
              run: () => setInviting(true),
            },
            {
              id: "team.web",
              label: "Make a web link",
              icon: Link,
              run: () => makeWeb(),
            },
          ]
        : [{ id: "team.web", label: "Make a web link", icon: Link, run: () => makeWeb() }],
    [admin, setInviting],
  );
  useCommands(commands);

  function makeWeb() {
    void action.run("web", async () => {
      setWeb(`${url}${(await api<MadeLink>("/team/weblinks", { method: "POST" })).path}`);
      return "Made a web link: it works once, for 10 minutes";
    });
  }

  if (signedOut) {
    return (
      <Page title="Team" intro={new URL(url).host}>
        <Notice kind="err">
          This machine was removed from the team: the team store no longer takes its token, so it is signed out and
          syncs nothing.
        </Notice>
      </Page>
    );
  }
  const waiting = invites.data?.filter((entry) => entry.code) ?? [];
  return (
    <Page
      title="Team"
      intro={
        <>
          {new URL(url).host} · {me.data ? `you are ${me.data.name} (${me.data.role}) on ${me.data.device}` : "…"} ·
          synced {since(lastSync)}
        </>
      }
      actions={
        <>
          <Button
            icon={Link}
            disabled={action.busy !== null}
            title="Sign a browser in to the team's web view, once, within 10 minutes"
            onClick={makeWeb}
          >
            Web link
          </Button>
          <Button
            icon={RefreshCw}
            busy={action.busy === "sync"}
            disabled={action.busy !== null}
            onClick={() =>
              void action.run(
                "sync",
                async () => {
                  const synced = await api<{ pushed: number; pulled: number }>("/sync", { method: "POST" });
                  done();
                  return `Synced: sent ${synced.pushed}, took ${synced.pulled}`;
                },
                "Syncing",
              )
            }
          >
            Sync now
          </Button>
        </>
      }
      primary={
        admin && (
          <Primary keys="n" onClick={() => setInviting(true)}>
            Invite…
          </Primary>
        )
      }
    >
      <Problem error={members.error ?? me.error ?? action.problem} />
      {outdated && (
        <Notice
          kind="warn"
          more="Whoever reaches its Cloudflare account updates it here; the team's records stay."
          action={
            <Button size="sm" onClick={() => setUpdating(true)}>
              Update it…
            </Button>
          }
        >
          The team store is older than this Grenier, so sync waits.
        </Notice>
      )}
      {web && (
        <Secret
          label="Web link"
          value={web}
          help="Open it in a browser within 10 minutes: it signs that browser in, once."
        />
      )}
      {waiting.map((entry) => (
        <Notice
          key={entry.id}
          kind="accent"
          tag="WAITING"
          more="Confirm only if it is the code on their screen."
          action={
            <Button
              size="sm"
              icon={Check}
              disabled={action.busy !== null}
              onClick={() =>
                call(
                  `confirm:${entry.id}`,
                  "/team/invites/confirm",
                  "POST",
                  { code: entry.code },
                  `${entry.member} joined on ${entry.device}`,
                )
              }
            >
              Confirm {spaced(entry.code)}
            </Button>
          }
        >
          {entry.member} asks to join on {entry.device}, showing {spaced(entry.code)}.
        </Notice>
      ))}
      {link && (
        <Secret
          label={`Invite link for ${link.member}`}
          value={link.link}
          help="It works once, for 24 hours. Their machine then shows a code they read to you, and you confirm it here."
        />
      )}

      <Section heading title="Members">
        {!members.data && !members.error && <Skeleton rows={3} shape="table" />}
        {members.data && (
          <Table
            label="Members"
            head={
              <>
                <th>Name</th>
                <th>Role</th>
                <th>Machines</th>
                {admin && (
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </>
            }
          >
            {members.data.map((member) => (
              <tr key={member.name}>
                <td>
                  <span className="flex items-center gap-2">
                    <Avatar name={member.name} />
                    {member.name}
                  </span>
                </td>
                <td>
                  <Tag>{member.role}</Tag>
                </td>
                <td className="whitespace-normal">
                  <span className="flex flex-wrap gap-x-4 gap-y-1">
                    {member.devices.map((device) => (
                      <span key={device.id} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span className="font-mono text-sm">{device.name}</span>
                        <Status {...stateTag(device.state)} />
                      </span>
                    ))}
                  </span>
                </td>
                {admin && (
                  <RowActions>
                    <Menu
                      label={`More for ${member.name}`}
                      items={[
                        {
                          label: member.role === "admin" ? "Make member" : "Make admin",
                          icon: UserCog,
                          disabled: action.busy !== null,
                          run: () => setRole(member, member.role === "admin" ? "member" : "admin"),
                        },
                        ...(member.name !== me.data?.name
                          ? [
                              {
                                label: "Remove…",
                                icon: Trash2,
                                danger: true,
                                run: () =>
                                  ask({
                                    title: `Remove ${member.name}?`,
                                    body: `${member.name} and their ${member.devices.length === 1 ? "machine are" : `${member.devices.length} machines are`} signed out of the team. What they wrote stays.`,
                                    action: "Remove the member",
                                    typed: member.name,
                                    run: () =>
                                      call(
                                        `remove:${member.name}`,
                                        `/team/members/${encodeURIComponent(member.name)}`,
                                        "DELETE",
                                        undefined,
                                        `Removed ${member.name}`,
                                      ),
                                  }),
                              },
                            ]
                          : []),
                      ]}
                    />
                  </RowActions>
                )}
              </tr>
            ))}
          </Table>
        )}
      </Section>
      <Machines me={me.data} removed={(self) => (self ? setSignedOut(true) : members.reload())} />
      {me.data && <Usage key={me.data.role} admin={admin} />}
      {dialog}
      {inviting && admin && (
        <Dialog
          title="Invite someone"
          action="Make the link"
          busy={action.busy !== null}
          onCancel={() => setInviting(false)}
          onAction={(form) => {
            const invited = String(form.get("name") ?? "").trim();
            void action.run("invite", async () => {
              const made = await api<InviteMade>("/team/invites", {
                body: { name: invited, role: String(form.get("role") ?? "member") },
              });
              setLink({ member: made.member, link: `grenier://join/${new URL(url).host}/${made.id}/${made.secret}` });
              setInviting(false);
              return `Made an invite link for ${made.member}`;
            });
          }}
        >
          <p>A new member, or a member's new machine: they join with the link, then read you a code.</p>
          <Problem error={action.problem} />
          <Field label="Name">
            <Input name="name" required placeholder="noor" />
          </Field>
          <Field label="Role">
            <Select name="role" defaultValue="member">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
          </Field>
        </Dialog>
      )}
      {updating && (
        <Deploy
          name={new URL(url).hostname.split(".")[0] ?? "grenier-team"}
          me={name}
          title="Update the team store"
          action="Update the team store"
          done={() => {
            setUpdating(false);
            done();
          }}
          cancel={() => setUpdating(false)}
        />
      )}
    </Page>
  );
}

/** The team's machines; an admin removes any of them, a member their own. */
function Machines({ me, removed }: { me: TeamMe | null; removed: (self: boolean) => void }) {
  const machines = useLoad(
    useCallback(() => api<{ machines: Machine[] }>("/team/machines").then((a) => a.machines), []),
  );
  const action = useAction();
  const { ask, dialog } = useConfirm();
  if (machines.error) return <Problem error={machines.error} />;
  if (!machines.data) return null;
  const mayRemove = (machine: Machine) => me !== null && (me.role === "admin" || machine.member === me.name);
  const remove = (machine: Machine) =>
    void action.run(`remove:${machine.id}`, async () => {
      await api(`/team/devices/${encodeURIComponent(machine.id)}`, { method: "DELETE" });
      const self = machine.id === me?.deviceId;
      if (!self) machines.reload();
      removed(self);
      return `Removed ${machine.name}`;
    });
  return (
    <Section heading title="Machines">
      <Problem error={action.problem} />
      <Table
        label="Machines"
        head={
          <>
            <th>Machine</th>
            <th>Member</th>
            <th>State</th>
            <th>Last seen</th>
            <th className="num">Runs, 30 days</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </>
        }
      >
        {machines.data.map((machine) => (
          <tr key={machine.id}>
            <td>
              <span className="flex items-center gap-2">
                <span className="font-mono text-sm">{machine.name}</span>
                {machine.id === me?.deviceId && <Tag>this one</Tag>}
              </span>
            </td>
            <td>{machine.member}</td>
            <td>
              <Status {...stateTag(machine.state)} />
            </td>
            <td className="mono">
              <time title={machine.lastSeen ? exact(machine.lastSeen) : undefined}>{ago(machine.lastSeen)}</time>
            </td>
            <td className="num mono">{machine.runs ?? 0}</td>
            <RowActions>
              {mayRemove(machine) && (
                <Button
                  variant="danger"
                  size="sm"
                  icon={Trash2}
                  disabled={action.busy !== null}
                  onClick={() =>
                    ask({
                      title: `Remove ${machine.name}?`,
                      body:
                        machine.id === me?.deviceId
                          ? "It is the machine you are on: removing it signs it out of the team, and it syncs nothing after."
                          : "It is signed out of the team. Joining again takes a new invite.",
                      action: "Remove the machine",
                      run: () => remove(machine),
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </RowActions>
          </tr>
        ))}
      </Table>
      {dialog}
    </Section>
  );
}

type By = "member" | "machine" | "day" | "repo";

/** What the agents cost, priced at API rates: an admin sees everyone's, a member their own. */
function Usage({ admin }: { admin: boolean }) {
  const [by, setBy] = useState<By>(admin ? "member" : "machine");
  const { data, error } = useLoad(
    useCallback(() => api<{ usage: TeamUsage[] }>("/team/usage").then((a) => a.usage), []),
  );
  if (error) return <Problem error={error} />;
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
  const totals = [...rows.values()].reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      cost: sum.cost + row.cost,
      minutes: sum.minutes + row.minutes,
    }),
    { requests: 0, cost: 0, minutes: 0 },
  );
  const options = (admin ? (["member", "machine", "day", "repo"] as const) : (["machine", "day", "repo"] as const)).map(
    (name) => [name, name === "repo" ? "Repository" : name[0]?.toUpperCase() + name.slice(1)] as const,
  );
  return (
    <Section
      heading
      title={admin ? "Usage" : "Your usage"}
      description="The last 30 days, priced at API rates."
      actions={<Segmented label="Group by" options={options} value={by} onChange={setBy} />}
    >
      {rows.size === 0 ? (
        <p className="text-muted">No usage reported yet.</p>
      ) : (
        <Table
          label="Usage"
          head={
            <>
              <th>{options.find(([key]) => key === by)?.[1]}</th>
              <th className="num">Requests</th>
              <th className="num">Routine minutes</th>
              <th className="num">API cost</th>
            </>
          }
          foot={
            <>
              <td>Total</td>
              <td className="num">{totals.requests}</td>
              <td className="num">{Math.round(totals.minutes)}</td>
              <td className="num">{money(totals.cost)}</td>
            </>
          }
        >
          {[...rows.entries()]
            .sort(([a, x], [b, y]) => (by === "day" ? b.localeCompare(a) : y.cost - x.cost))
            .map(([key, total]) => (
              <tr key={key}>
                <td className={by === "day" || by === "machine" ? "mono" : undefined}>{key}</td>
                <td className="num mono">{total.requests}</td>
                <td className="num mono">{Math.round(total.minutes)}</td>
                <td className="num mono">{money(total.cost)}</td>
              </tr>
            ))}
        </Table>
      )}
    </Section>
  );
}
