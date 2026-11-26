import type { LocalSkillFull, RecordFull, SharedNow, SharedState } from "@grenier/core/api";
import { Check, Download, FileText, Share2, Trash2, Undo2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { MarkdownEditor } from "../editor/markdown-editor.tsx";
import { type Command, useCommands } from "../shell/commands.tsx";
import { useItemTitle } from "../shell/regions.tsx";
import { descriptionOf, joinManifest, splitManifest, withDescription } from "../skill-manifest.ts";
import { Button, Primary } from "../ui/button.tsx";
import { useConfirm } from "../ui/dialog.tsx";
import { Skeleton } from "../ui/empty.tsx";
import { Input } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Menu, type MenuItem } from "../ui/menu.tsx";
import { Notice, Problem } from "../ui/notice.tsx";
import { Section } from "../ui/page.tsx";
import { Status } from "../ui/tag.tsx";

/** A skill as it reads: where it is, its name, its description, its instructions in the editor, and its other files. */
function SkillPage({
  path,
  name,
  manifest,
  files,
  editable,
  state,
  actions,
  notice,
  problem,
  saving,
  save,
  open,
}: {
  path: string;
  name: string;
  manifest: string;
  files: string[];
  editable: boolean;
  /** Beside the path: whether it is installed here, for a team skill. */
  state?: ReactNode;
  actions: ReactNode;
  notice?: ReactNode;
  problem: string | null;
  saving: boolean;
  save: (manifest: string) => void;
  open: (id: string) => void;
}) {
  const [draft, setDraft] = useState(() => splitManifest(manifest));
  useEffect(() => setDraft(splitManifest(manifest)), [manifest]);
  const written = joinManifest(draft.front, draft.body);
  const dirty = written !== manifest;
  const description = descriptionOf(draft.front);
  useItemTitle(name);

  // biome-ignore lint/correctness/useExhaustiveDependencies: save reads the draft as it is when it runs
  const commands = useMemo<Command[]>(
    () =>
      editable
        ? [
            {
              id: "skill.save",
              label: "Save the skill",
              keys: "mod+enter",
              also: ["mod+s"],
              hint: { in: "item", says: "save", order: 10 },
              run: () => dirty && save(written),
            },
          ]
        : [],
    [editable, dirty, written],
  );
  useCommands(commands);

  return (
    <article className="flex h-full min-w-0 flex-col overflow-y-auto" data-verb="save">
      <header className="sticky top-0 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-bg px-4 font-mono text-sm">
        <p className="min-w-0 flex-1 truncate text-muted">{path}</p>
        {state}
        {editable && <span className="text-xs text-muted">{dirty ? "Edited" : "Saved"}</span>}
        {actions}
        {editable && (
          <Primary size="sm" keys="mod+enter" busy={saving} disabled={!dirty} onClick={() => save(written)}>
            Save
          </Primary>
        )}
      </header>
      <div className="mx-auto w-full max-w-(--layout-reading) px-6 pt-10 pb-24">
        <h1 className="font-mono text-xl leading-tight font-semibold tracking-tight">{name}</h1>
        {editable && description !== null ? (
          <div className="mt-3">
            <Input
              aria-label="When to use it"
              placeholder="When to use it, in one line: an agent reads it to decide."
              value={description}
              onChange={(event) =>
                setDraft({ ...draft, front: withDescription(draft.front, event.currentTarget.value) })
              }
            />
          </div>
        ) : (
          description && <p className="mt-2 text-muted">{description}</p>
        )}
        <div className="mt-4 grid gap-2 empty:hidden">
          <Problem error={problem} />
          {notice}
        </div>
        <div className="mt-6">
          <MarkdownEditor
            value={draft.body}
            editable={editable}
            label="Instructions, in Markdown"
            onChange={(body) => setDraft((now) => ({ ...now, body }))}
            onLink={() => {}}
            open={open}
          />
        </div>
        {files.length > 0 && (
          <div className="mt-12">
            <Section title="Files">
              <ul className="grid gap-1 font-mono text-sm">
                {files.map((file) => (
                  <li key={file} className="flex items-center gap-2 text-muted">
                    <FileText className="icon" aria-hidden="true" />
                    {file}
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        )}
      </div>
    </article>
  );
}

const WHERE: Record<LocalSkillFull["kind"], string> = {
  own: "Me",
  linked: "Me",
  synced: "Me / Synced",
  plugin: "Me / Plugins",
};

/** One of the person's own skills, from ~/.claude/skills: edited in place when it is their folder. */
export function LocalSkillView({
  id,
  share,
  changed,
  removed,
  open,
}: {
  id: string;
  /** An admin in a team can share it. */
  share: boolean;
  changed: () => void;
  removed: () => void;
  open: (id: string) => void;
}) {
  const load = useCallback(() => api<LocalSkillFull>(`/skills/one?id=${encodeURIComponent(id)}`), [id]);
  const skill = useLoad(load);
  const action = useAction(() => {
    skill.reload();
    changed();
  });
  const { ask, dialog } = useConfirm();
  if (skill.error) return <Problem error={skill.error} />;
  const data = skill.data;
  if (!data) return <Skeleton rows={6} shape="text" />;

  const remove = () =>
    ask({
      title: data.kind === "linked" ? `Remove the link to ${data.name}?` : `Delete ${data.name}?`,
      body:
        data.kind === "linked"
          ? `Your agents stop loading it. The link goes; ${data.path} stays as it is.`
          : "Its folder and every file in it are deleted from your skills. This can't be undone.",
      action: data.kind === "linked" ? "Remove the link" : "Delete the skill",
      run: () =>
        void action.run("remove", async () => {
          await api(`/skills/one?id=${encodeURIComponent(id)}`, { method: "DELETE" });
          changed();
          removed();
          return data.kind === "linked" ? `Removed the link to ${data.name}` : `Deleted ${data.name}`;
        }),
    });
  const items: MenuItem[] = [
    ...(share
      ? [
          {
            label: "Share with the team",
            icon: Share2,
            run: () =>
              void action.run("share", async () => {
                const done = await api<SharedNow>(`/skills/share?id=${encodeURIComponent(id)}`, { method: "POST" });
                return `${done.updated ? "Shared a new version of" : "Shared"} ${done.title}: each teammate installs it, or not`;
              }),
          },
        ]
      : []),
  ];
  const kept =
    data.kind === "linked"
      ? `Linked from ${data.path}: change it there.`
      : data.kind === "synced"
        ? "Synced from your claude.ai account: change it there."
        : data.kind === "plugin"
          ? `Comes with a plugin, from ${data.path}.`
          : null;

  return (
    <>
      <SkillPage
        key={id}
        path={`${WHERE[data.kind]} / ${data.name}`}
        name={data.name}
        manifest={data.manifest}
        files={data.files}
        editable={data.kind === "own"}
        actions={
          <>
            {(data.kind === "own" || data.kind === "linked") && (
              <Button size="sm" icon={Trash2} busy={action.busy === "remove"} onClick={remove}>
                {data.kind === "linked" ? "Remove the link" : "Delete"}
              </Button>
            )}
            {items.length > 0 && <Menu label="More" items={items} />}
          </>
        }
        notice={kept && <Notice kind="info">{kept}</Notice>}
        problem={action.problem}
        saving={action.busy === "save"}
        save={(manifest) =>
          void action.run("save", async () => {
            await api(`/skills/one?id=${encodeURIComponent(id)}`, { method: "PUT", body: { manifest } });
            return `Saved ${data.name}: your agents load it as it is now`;
          })
        }
        open={open}
      />
      {dialog}
    </>
  );
}

const HERE: Record<SharedState["state"], ReactNode> = {
  installed: <Status kind="ok" word="installed" />,
  update: <Status kind="warn" word="update" />,
  available: <Status kind="draft" word="not here" />,
};

/** A skill the team shares: installed here or not, and edited by an admin as a new version each machine approves. */
export function TeamSkillView({
  entry,
  admin,
  changed,
  removed,
  open,
}: {
  entry: SharedState;
  admin: boolean;
  changed: () => void;
  /** After an admin removed it from the team. */
  removed: () => void;
  open: (id: string) => void;
}) {
  const load = useCallback(() => api<RecordFull>(`/records/${encodeURIComponent(entry.id)}`), [entry.id]);
  const record = useLoad(load);
  const { ask, dialog } = useConfirm();
  const action = useAction(() => {
    record.reload();
    changed();
  });
  if (record.error) return <Problem error={record.error} />;
  if (!record.data) return <Skeleton rows={6} shape="text" />;
  const files = (record.data.fields.files ?? {}) as Record<string, string>;

  const call = (key: string, path: string, method: string, said: string) =>
    void action.run(key, async () => {
      await api(path, { method });
      return said;
    });
  const install = () =>
    call(
      "install",
      `/installs/${entry.id}`,
      "POST",
      `${entry.state === "update" ? "Approved the update of" : "Installed"} ${entry.title}: restart Claude Code to load it`,
    );
  const uninstall = () =>
    void action.run("remove", async () => {
      await api(`/installs/${entry.id}`, { method: "DELETE" });
      return { text: `Uninstalled ${entry.title} from this machine`, undo: install };
    });
  const items: MenuItem[] = [
    ...(entry.canRollBack
      ? [
          {
            label: "Roll back",
            icon: Undo2,
            run: () =>
              call(
                "rollback",
                `/installs/${entry.id}/rollback`,
                "POST",
                `Rolled ${entry.title} back to the version before`,
              ),
          },
        ]
      : []),
    ...(admin
      ? [
          {
            label: "Remove from the team",
            icon: Trash2,
            danger: true,
            run: () =>
              ask({
                title: `Remove ${entry.title} from the team?`,
                body: "It leaves every teammate's list, and each machine that installed it uninstalls it at its next sync. Its history stays.",
                action: "Remove from the team",
                run: () =>
                  void action.run("retire", async () => {
                    await api(`/records/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
                    removed();
                    return `Removed ${entry.title} from the team`;
                  }),
              }),
          },
        ]
      : []),
  ];
  const Install = admin ? Button : Primary;

  return (
    <>
      <SkillPage
        key={`${entry.id}:${record.data.version}`}
        path={`Team / ${entry.title}`}
        name={entry.title}
        manifest={files["SKILL.md"] ?? ""}
        files={Object.keys(files).filter((path) => path !== "SKILL.md")}
        editable={admin}
        state={HERE[entry.state]}
        actions={
          <>
            {entry.state !== "installed" && (
              <Install
                size="sm"
                icon={entry.state === "update" ? Check : Download}
                busy={action.busy === "install"}
                onClick={install}
              >
                {entry.state === "update" ? "Approve the update" : "Install"}
              </Install>
            )}
            {entry.state !== "available" && (
              <Button size="sm" icon={Trash2} busy={action.busy === "remove"} onClick={uninstall}>
                Uninstall
              </Button>
            )}
            {items.length > 0 && <Menu label="More" items={items} />}
          </>
        }
        notice={
          entry.state === "update" && (
            <Notice kind="warn">
              Changed since you installed it: it loads as it is now once you approve the update.
            </Notice>
          )
        }
        problem={action.problem}
        saving={action.busy === "save"}
        save={(manifest) =>
          void action.run("save", async () => {
            await api(`/installs/${entry.id}/skill`, { method: "PUT", body: { manifest } });
            return `Saved ${entry.title}: each teammate approves the new version`;
          })
        }
        open={open}
      />
      {dialog}
    </>
  );
}
