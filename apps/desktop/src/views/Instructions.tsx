import type { InstructionFile, InstructionText } from "@grenier/core/api";
import { FileText, RotateCcw, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { MarkdownEditor } from "../editor/markdown-editor.tsx";
import { type Command, useCommands } from "../shell/commands.tsx";
import { ListDetail, useItemTitle } from "../shell/regions.tsx";
import { Button, Primary } from "../ui/button.tsx";
import { Empty, Skeleton } from "../ui/empty.tsx";
import { SearchField } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Notice, Problem } from "../ui/notice.tsx";
import { Tag } from "../ui/tag.tsx";
import { Tree, type TreeNode } from "../ui/tree.tsx";

const load = () => api<{ workdir: string; files: InstructionFile[] }>("/instructions");

/** Who reads each file, for its bar and its empty page. */
const READ_BY: Record<string, string> = {
  "CLAUDE.md": "Claude Code reads it",
  "AGENTS.md": "Codex and most other agents read it",
  "CLAUDE.local.md": "Claude Code reads it, kept out of git",
};

/** One file in the live-preview editor; a save names the version it started from, so it never writes over an agent's. */
function InstructionEditor({ file, changed }: { file: InstructionFile; changed: () => void }) {
  const loadText = useCallback(
    () => api<InstructionText>(`/instructions/one?id=${encodeURIComponent(file.id)}`),
    [file.id],
  );
  const current = useLoad(loadText);
  const [text, setText] = useState<string | null>(null);
  const action = useAction(() => {
    current.reload();
    changed();
  });
  useItemTitle(file.project ? `${file.project} / ${file.name}` : file.name);
  useEffect(() => {
    if (current.data) setText(current.data.text);
  }, [current.data]);
  const dirty = current.data !== null && text !== null && text !== current.data.text;
  const save = () =>
    void action.run("save", async () => {
      await api(`/instructions/one?id=${encodeURIComponent(file.id)}`, {
        method: "PUT",
        body: { text: text ?? "", hash: current.data?.hash ?? null },
      });
      return file.exists ? `Saved ${file.name}` : `Made ${file.name}`;
    });

  // biome-ignore lint/correctness/useExhaustiveDependencies: save reads the text as it is when it runs
  const commands = useMemo<Command[]>(
    () => [
      {
        id: "instructions.save",
        label: "Save the file",
        keys: "mod+enter",
        also: ["mod+s"],
        hint: { in: "item", says: "save", order: 10 },
        run: () => dirty && save(),
      },
    ],
    [dirty, text],
  );
  useCommands(commands);

  if (current.error) return <Problem error={current.error} />;
  if (!current.data || text === null) return <Skeleton rows={6} shape="text" />;
  return (
    <article className="flex h-full min-w-0 flex-col overflow-y-auto" data-verb="save">
      <header className="sticky top-0 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-bg px-4 font-mono text-sm">
        <p className="min-w-0 flex-1 truncate text-muted" title={file.path}>
          {file.path}
        </p>
        <span className="text-xs text-muted">{dirty ? "Edited" : file.exists ? "Saved" : "Not made yet"}</span>
        <Primary size="sm" keys="mod+enter" busy={action.busy === "save"} disabled={!dirty} onClick={save}>
          {file.exists ? "Save" : "Make the file"}
        </Primary>
      </header>
      <div className="mx-auto w-full max-w-(--layout-reading) px-6 pt-10 pb-24">
        <h1 className="font-mono text-xl leading-tight font-semibold tracking-tight">
          {file.project ? `${file.project} / ${file.name}` : `Every project / ${file.name}`}
        </h1>
        <p className="mt-2 font-mono text-xs text-muted">
          {READ_BY[file.name]}
          {file.project ? ` in ${file.project}` : ", in every project"}.
        </p>
        <div className="mt-4 grid gap-2 empty:hidden">
          {action.problem && (
            <Notice
              kind="err"
              action={
                /changed on disk/.test(action.problem) ? (
                  <Button size="sm" icon={RotateCcw} onClick={() => current.reload()}>
                    Reload it
                  </Button>
                ) : undefined
              }
            >
              {action.problem}
            </Notice>
          )}
        </div>
        <div className="mt-6">
          <MarkdownEditor
            key={`${file.id}:${current.data.hash ?? ""}`}
            value={text}
            editable
            label={`${file.name}, in Markdown`}
            onChange={setText}
            onLink={() => {}}
            open={() => {}}
          />
        </div>
      </div>
    </article>
  );
}

/** The instructions agents read, CLAUDE.md and AGENTS.md: every project's own, and each project's in the work folder. */
export function Instructions({ item, go }: ViewProps) {
  const files = useLoad(load);
  const [words, setWords] = useState("");
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const search = useRef<HTMLInputElement>(null);
  const query = words.trim().toLowerCase();
  const select = useCallback((id: string) => go("instructions", id), [go]);

  const commands = useMemo<Command[]>(
    () => [
      {
        id: "instructions.search",
        label: "Search the projects",
        keys: "/",
        also: ["mod+f"],
        hint: { in: "list", says: "search", order: 30 },
        run: () => search.current?.focus(),
      },
    ],
    [],
  );
  useCommands(commands);

  const all = files.data?.files ?? [];
  const leaf = (file: InstructionFile): TreeNode => ({
    id: file.id,
    name: file.name,
    icon: FileText,
    ...(file.exists ? {} : { meta: <Tag>none</Tag> }),
  });
  const projects = [...new Set(all.flatMap((file) => (file.project ? [file.project] : [])))].filter(
    (project) => !query || project.toLowerCase().includes(query),
  );
  const nodes: TreeNode[] = [
    { id: "every/", name: "Every project", group: true, children: all.filter((file) => !file.project).map(leaf) },
    {
      id: "projects/",
      name: "Projects",
      group: true,
      meta: files.data?.workdir || "no work folder",
      children: projects.map((project) => ({
        id: `projects/${project}`,
        name: project,
        children: all.filter((file) => file.project === project).map(leaf),
      })),
    },
  ];
  // The groups start open and each project's folder closed; opening a file opens its folder, and closes nothing.
  const first = (id: string) => id.endsWith("/");
  const open = (id: string) => Boolean(query) || flipped.has(id) !== first(id);
  useEffect(() => {
    const project = item?.startsWith("project/") ? `projects/${item.split("/")[1]}` : null;
    if (project) setFlipped((now) => (now.has(project) ? now : new Set(now).add(project)));
  }, [item]);

  const list = (
    <>
      <div className="border-b border-line p-3">
        <SearchField
          ref={search}
          label="Search the projects"
          placeholder="Search projects"
          live
          value={words}
          onChange={(event) => setWords(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return;
            event.preventDefault();
            event.currentTarget.closest("[data-region]")?.querySelector<HTMLElement>("[role=tree]")?.focus();
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Problem error={files.error} />
        {files.error ? null : !files.data ? (
          <Skeleton rows={8} />
        ) : (
          <Tree
            label="Instructions"
            nodes={nodes}
            selected={item ?? null}
            open={open}
            onSelect={(node) => node.children === undefined && select(node.id)}
            onToggle={(id, next) =>
              setFlipped((now) => {
                if ((now.has(id) !== first(id)) === next) return now;
                const out = new Set(now);
                if (out.has(id)) out.delete(id);
                else out.add(id);
                return out;
              })
            }
            onOpen={(node) => select(node.id)}
          />
        )}
      </div>
    </>
  );

  const file = all.find((entry) => entry.id === item);
  return (
    <ListDetail title="Instructions" list={list}>
      {file ? (
        <InstructionEditor key={file.id} file={file} changed={files.reload} />
      ) : files.data && !files.data.workdir ? (
        <Empty boot="no work folder">
          Projects come from your work folder, the one that holds them.
          <span className="mt-3 block">
            <Button size="sm" icon={Settings} onClick={() => go("settings", "machine")}>
              Set it in Settings
            </Button>
          </span>
        </Empty>
      ) : (
        <Empty boot="pick a file">
          CLAUDE.md is what Claude Code reads in a project, AGENTS.md what Codex and most other agents read. Every
          project's own apply everywhere.
        </Empty>
      )}
    </ListDetail>
  );
}
