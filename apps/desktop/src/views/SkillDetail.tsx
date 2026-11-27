import type { LocalSkillFull, RecordFull, SharedNow, SharedState } from "@grenier/core/api";
import { frontField, joinManifest, splitManifest, withDescription } from "@grenier/core/skill-manifest";
import { FileText, Share2, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { MarkdownEditor } from "../editor/markdown-editor.tsx";
import { useSaveCommand } from "../shell/commands.tsx";
import { DetailBar, ItemName, Reading, useItemTitle } from "../shell/regions.tsx";
import { installTag } from "../states.ts";
import { Button, Primary } from "../ui/button.tsx";
import { useConfirm } from "../ui/dialog.tsx";
import { Skeleton } from "../ui/empty.tsx";
import { Input } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Menu, type MenuItem } from "../ui/menu.tsx";
import { Notice, Problem } from "../ui/notice.tsx";
import { Section } from "../ui/page.tsx";
import { Status } from "../ui/tag.tsx";
import { sharedEntryParts } from "./shared-entry.tsx";
import { UsageSection } from "./tool-usage.tsx";

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
  usage,
}: {
  path: string;
  name: string;
  usage: string;
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
  const description = frontField(draft.front, "description") ?? "";
  useItemTitle(name);

  useSaveCommand("skill.save", "Save the skill", editable, () => dirty && save(written));

  return (
    <article className="flex h-full min-w-0 flex-col overflow-y-auto" data-verb="save">
      <DetailBar crumb={path}>
        {state}
        {editable && <span className="text-xs text-muted">{dirty ? "Edited" : "Saved"}</span>}
        {actions}
        {editable && (
          <Primary size="sm" keys="mod+enter" busy={saving} disabled={!dirty} onClick={() => save(written)}>
            Save
          </Primary>
        )}
      </DetailBar>
      <Reading>
        <ItemName>{name}</ItemName>
        {editable ? (
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
          <UsageSection query={usage} what="skill" />
        </div>
        <div className="mt-6">
          <MarkdownEditor
            value={draft.body}
            editable={editable}
            label="Instructions, in Markdown"
            onChange={(body) => setDraft((now) => ({ ...now, body }))}
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
      </Reading>
    </article>
  );
}

const WHERE: Record<LocalSkillFull["kind"], string> = {
  own: "",
  linked: "",
  synced: " / Synced",
  plugin: " / Plugins",
};

/** One of the person's own skills, from its agent's skills folder: edited in place when it is their folder. */
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
        path={`Me / ${data.agent}${WHERE[data.kind]} / ${data.name}`}
        name={data.name}
        usage={`skill=${encodeURIComponent(id)}`}
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

  const shared = sharedEntryParts({ entry, admin, action, ask, removed, primary: !admin });

  return (
    <>
      <SkillPage
        key={`${entry.id}:${record.data.version}`}
        path={`Team / ${entry.title}`}
        name={entry.title}
        usage={`shared=${encodeURIComponent(entry.id)}`}
        manifest={files["SKILL.md"] ?? ""}
        files={Object.keys(files).filter((path) => path !== "SKILL.md")}
        editable={admin}
        state={<Status {...installTag(entry.state)} />}
        actions={
          <>
            {shared.buttons}
            {shared.items.length > 0 && <Menu label="More" items={shared.items} />}
          </>
        }
        notice={shared.notice}
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
