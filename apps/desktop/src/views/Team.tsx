import type { Invite, InviteMade, MadeLink, Member, TeamMe } from "@grenier/core/api";
import { inviteLink } from "@grenier/core/team";
import { Check, Link, RefreshCw, Trash2, UserCog, UserPlus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { since } from "../format.ts";
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
import { RowActions, Table } from "../ui/table.tsx";
import { Status, Tag } from "../ui/tag.tsx";
import { usePolling } from "./polling.ts";
import { Deploy, Join, spaced, useStoreUpdate } from "./TeamJoin.tsx";
import { Machines } from "./TeamMachines.tsx";
import { Usage } from "./TeamUsage.tsx";

const loadMe = () => api<TeamMe>("/team/me");

export function Team({ item, go, changed: done, overview }: ViewProps) {
  const setInviting = useCallback((open: boolean) => go("team", open ? "invite" : undefined), [go]);
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
      deployKept={overview.data.deployKept}
      me={overview.data.me}
      done={done}
      inviting={item === "invite"}
      setInviting={setInviting}
    />
  );
  return <Detail title="Team">{content}</Detail>;
}

function Members({
  url,
  lastSync,
  outdated,
  deployKept,
  me: name,
  done,
  inviting,
  setInviting,
}: {
  url: string;
  lastSync: number | null;
  outdated: boolean;
  deployKept: boolean;
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
  const update = useStoreUpdate(done);
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
      <Problem error={members.error ?? me.error ?? action.problem ?? update.problem} />
      {outdated && (
        <Notice
          kind="warn"
          more="Whoever reaches its Cloudflare account updates it here; the team's records stay."
          action={
            <Button size="sm" busy={update.busy} onClick={deployKept ? update.run : () => setUpdating(true)}>
              {deployKept ? "Update it" : "Update it…"}
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
              setLink({ member: made.member, link: inviteLink(url, made.id, made.secret) });
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
