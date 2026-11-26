import type { LocalServer, RecordFull, ServerChange, SharedNow, SharedState } from "@grenier/core/api";
import { folderName } from "@grenier/core/names";
import { Plus, Settings, Share2, Trash2, Undo2 } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { api } from "../api.ts";
import { useSaveCommand } from "../shell/commands.tsx";
import { DetailBar, ItemMeta, ItemName, Reading } from "../shell/regions.tsx";
import { installTag } from "../states.ts";
import { Button, IconButton, Primary } from "../ui/button.tsx";
import { useConfirm } from "../ui/dialog.tsx";
import { Skeleton } from "../ui/empty.tsx";
import { Field, Input, Textarea } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Menu, type MenuItem } from "../ui/menu.tsx";
import { Notice, Problem } from "../ui/notice.tsx";
import { Section } from "../ui/page.tsx";
import { Status, Tag } from "../ui/tag.tsx";
import { KeysDialog, sharedEntryParts } from "./shared-entry.tsx";

/** Where a server of the person's is, as its bar shows it. */
function serverPath(server: LocalServer): string {
  if (server.scope === "user") return `Me / ${server.client} / ${server.name}`;
  return `Me / ${server.client} / Projects / ${folderName(server.where ?? "")} / ${server.name}`;
}

/** A server as it reads: its bar, its name and how it runs, then what is set for it. */
function ServerPage({
  path,
  name,
  meta,
  state,
  actions,
  notice,
  children,
}: {
  path: string;
  name: string;
  meta: ReactNode;
  state?: ReactNode;
  actions: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="flex h-full min-w-0 flex-col overflow-y-auto" data-verb="save">
      <DetailBar crumb={path}>
        {state}
        {actions}
      </DetailBar>
      <Reading gap="gap-6">
        <div>
          <ItemName>{name}</ItemName>
          <ItemMeta>{meta}</ItemMeta>
        </div>
        {notice && <div className="grid gap-2">{notice}</div>}
        {children}
      </Reading>
    </article>
  );
}

/** The variables or headers a server sets, by name: a value is replaced or removed here, never shown. */
function Keys({
  title,
  set,
  change,
  editable,
  onChange,
}: {
  title: string;
  set: string[];
  change: Record<string, string | null>;
  editable: boolean;
  onChange: (change: Record<string, string | null>) => void;
}) {
  const [replacing, setReplacing] = useState<string | null>(null);
  const [adding, setAdding] = useState({ name: "", value: "" });
  const added = Object.keys(change).filter((name) => !set.includes(name) && change[name] !== null);
  const rows = [...set, ...added];
  if (rows.length === 0 && !editable) return null;
  return (
    <Section title={title}>
      <ul className="grid gap-1">
        {rows.map((name) => {
          const removed = change[name] === null;
          const replaced = typeof change[name] === "string";
          return (
            <li key={name} className="flex items-center gap-2 font-mono text-sm">
              <span className={`min-w-0 flex-1 truncate ${removed ? "text-muted line-through" : ""}`}>{name}</span>
              {replacing === name ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const value = String(new FormData(event.currentTarget).get("value") ?? "");
                    if (value) onChange({ ...change, [name]: value });
                    setReplacing(null);
                  }}
                >
                  <Input name="value" type="password" mono aria-label={`New value of ${name}`} autoComplete="off" />
                  <Button size="sm" type="submit">
                    Set
                  </Button>
                </form>
              ) : (
                <span className="text-muted">{removed ? "removed" : replaced ? "new value" : "••••"}</span>
              )}
              {editable && replacing !== name && (
                <>
                  {!removed && (
                    <Button size="sm" variant="ghost" onClick={() => setReplacing(name)}>
                      Replace…
                    </Button>
                  )}
                  <IconButton
                    label={removed ? `Keep ${name}` : `Remove ${name}`}
                    icon={removed ? Undo2 : Trash2}
                    size="sm"
                    onClick={() => {
                      const next = { ...change };
                      if (removed || (replaced && !set.includes(name))) delete next[name];
                      else next[name] = null;
                      onChange(next);
                    }}
                  />
                </>
              )}
            </li>
          );
        })}
        {rows.length === 0 && <li className="text-sm text-muted">None.</li>}
      </ul>
      {editable && (
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!adding.name.trim() || !adding.value) return;
            onChange({ ...change, [adding.name.trim()]: adding.value });
            setAdding({ name: "", value: "" });
          }}
        >
          <div className="flex-1">
            <Input
              mono
              aria-label={`Name of a new ${title === "Headers" ? "header" : "variable"}`}
              placeholder={title === "Headers" ? "Authorization" : "API_TOKEN"}
              value={adding.name}
              onChange={(event) => setAdding({ ...adding, name: event.currentTarget.value })}
            />
          </div>
          <div className="flex-1">
            <Input
              mono
              type="password"
              aria-label="Its value"
              placeholder="Its value"
              autoComplete="off"
              value={adding.value}
              onChange={(event) => setAdding({ ...adding, value: event.currentTarget.value })}
            />
          </div>
          <Button size="sm" icon={Plus} type="submit">
            Add
          </Button>
        </form>
      )}
    </Section>
  );
}

/** One of the person's servers: changed in its agent's config, read-only when it is kept elsewhere. */
export function LocalServerView({
  server,
  share,
  changed,
  removed,
  settings,
}: {
  server: LocalServer;
  /** An admin in a team can share it. */
  share: boolean;
  changed: () => void;
  removed: () => void;
  settings: () => void;
}) {
  const [draft, setDraft] = useState({
    command: server.command ?? "",
    args: server.args.join("\n"),
    url: server.url ?? "",
  });
  const [keys, setKeys] = useState<Record<string, string | null>>({});
  const action = useAction(() => {
    setKeys({});
    changed();
  });
  const { ask, dialog } = useConfirm();
  const part = server.transport === "stdio" ? "env" : "headers";
  const args = draft.args.split("\n").filter((line) => line.trim() !== "");
  const change: ServerChange = {
    ...(server.transport === "stdio" && draft.command !== (server.command ?? "") ? { command: draft.command } : {}),
    ...(server.transport === "stdio" && args.join("\n") !== server.args.join("\n") ? { args } : {}),
    ...(server.transport !== "stdio" && draft.url !== (server.url ?? "") ? { url: draft.url } : {}),
    ...(Object.keys(keys).length > 0 ? { [part]: keys } : {}),
  };
  const dirty = Object.keys(change).length > 0;
  const editable = server.editable;
  const items: MenuItem[] =
    editable && share
      ? [
          {
            label: "Share with the team",
            icon: Share2,
            run: () =>
              void action.run("share", async () => {
                const done = await api<SharedNow>(`/servers/share?id=${encodeURIComponent(server.id)}`, {
                  method: "POST",
                });
                return `${done.updated ? "Shared a new version of" : "Shared"} ${done.title}: each teammate enters their own keys`;
              }),
          },
        ]
      : [];
  const remove = () =>
    ask({
      title: `Remove ${server.name}?`,
      body: `Its entry and the keys in it leave ${server.client}'s config. This can't be undone.`,
      action: "Remove the server",
      run: () =>
        void action.run("remove", async () => {
          await api(`/servers/one?id=${encodeURIComponent(server.id)}`, { method: "DELETE" });
          removed();
          return `Removed ${server.name}`;
        }),
    });
  const kept = server.grenier ? (
    <Notice
      kind="info"
      action={
        <Button size="sm" icon={Settings} onClick={settings}>
          Open Settings
        </Button>
      }
    >
      Grenier's own server: it is added to your apps, and its key changed, in Settings.
    </Notice>
  ) : server.scope === "repo" ? (
    <Notice kind="info">In {server.where}/.mcp.json: change it in the repository.</Notice>
  ) : !server.editable ? (
    <Notice kind="info">{server.client}'s own: change it there.</Notice>
  ) : null;

  const save = () =>
    void action.run("save", async () => {
      await api(`/servers/one?id=${encodeURIComponent(server.id)}`, { method: "PUT", body: change });
      return `Saved ${server.name}: restart ${server.client} to load it`;
    });
  useSaveCommand("server.save", "Save the server", editable, () => dirty && save());

  return (
    <>
      <ServerPage
        path={serverPath(server)}
        name={server.name}
        meta={
          <>
            {server.transport === "stdio" ? "a local command" : `at a URL, over ${server.transport}`}
            {server.scope === "user" ? " · every project" : server.where ? ` · ${server.where}` : ""}
          </>
        }
        state={server.grenier ? <Tag>grenier</Tag> : undefined}
        actions={
          <>
            {editable && <span className="text-xs text-muted">{dirty ? "Edited" : "Saved"}</span>}
            {editable && (
              <Button size="sm" icon={Trash2} busy={action.busy === "remove"} onClick={remove}>
                Remove
              </Button>
            )}
            {items.length > 0 && <Menu label="More" items={items} />}
            {editable && (
              <Primary size="sm" keys="mod+enter" busy={action.busy === "save"} disabled={!dirty} onClick={save}>
                Save
              </Primary>
            )}
          </>
        }
        notice={
          (action.problem || kept) && (
            <>
              <Problem error={action.problem} />
              {kept}
            </>
          )
        }
      >
        {server.transport === "stdio" ? (
          <>
            <Field label="Command">
              <Input
                mono
                readOnly={!editable}
                value={draft.command}
                onChange={(event) => setDraft({ ...draft, command: event.currentTarget.value })}
              />
            </Field>
            <Field label="Arguments" help="One per line. •••• stands for a key: leave it, or type the whole key again.">
              <Textarea
                mono
                rows={Math.max(3, server.args.length + 1)}
                readOnly={!editable}
                value={draft.args}
                onChange={(event) => setDraft({ ...draft, args: event.currentTarget.value })}
              />
            </Field>
          </>
        ) : (
          <Field label="URL">
            <Input
              mono
              readOnly={!editable}
              value={draft.url}
              onChange={(event) => setDraft({ ...draft, url: event.currentTarget.value })}
            />
          </Field>
        )}
        <Keys
          title={server.transport === "stdio" ? "Environment" : "Headers"}
          set={server.transport === "stdio" ? server.env : server.headers}
          change={keys}
          editable={editable}
          onChange={setKeys}
        />
      </ServerPage>
      {dialog}
    </>
  );
}

/** A server the team shares: what it runs, the keys each person enters, and whether it is installed here. */
export function TeamServerView({
  entry,
  admin,
  changed,
  removed,
}: {
  entry: SharedState;
  admin: boolean;
  changed: () => void;
  /** After an admin removed it from the team. */
  removed: () => void;
}) {
  const load = useCallback(() => api<RecordFull>(`/records/${encodeURIComponent(entry.id)}`), [entry.id]);
  const record = useLoad(load);
  const { ask, dialog } = useConfirm();
  const [asking, setAsking] = useState(false);
  const action = useAction(() => {
    setAsking(false);
    changed();
  });
  if (record.error) return <Problem error={record.error} />;
  if (!record.data) return <Skeleton rows={6} shape="text" />;
  const config = (record.data.fields.config ?? {}) as { url?: string; command?: string; args?: string[] };

  const shared = sharedEntryParts({
    entry,
    admin,
    action,
    ask,
    removed,
    primary: true,
    askKeys: () => setAsking(true),
  });

  return (
    <ServerPage
      path={`Team / ${entry.title}`}
      name={entry.title}
      meta={config.url ? "at a URL" : "a local command"}
      state={<Status {...installTag(entry.state)} />}
      actions={
        <>
          {shared.buttons}
          {shared.items.length > 0 && <Menu label="More" items={shared.items} />}
        </>
      }
      notice={
        <>
          <Problem error={action.problem} />
          {shared.notice}
        </>
      }
    >
      {entry.description && <p>{entry.description}</p>}
      <Field label={config.url ? "URL" : "Command"}>
        <Input mono readOnly value={config.url ?? [config.command, ...(config.args ?? [])].join(" ")} />
      </Field>
      {entry.credentials.length > 0 && (
        <p className="text-sm text-muted">
          Needs your {entry.credentials.join(", ")}: they go only into your agents' configs.
        </p>
      )}
      {dialog}
      {asking && (
        <KeysDialog
          title={`Install ${entry.title}`}
          action="Install"
          names={entry.credentials}
          busy={action.busy !== null}
          problem={action.problem}
          onCancel={() => setAsking(false)}
          onKeys={shared.install}
        />
      )}
    </ServerPage>
  );
}
