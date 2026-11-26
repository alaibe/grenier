import type { InstructionFile, InstructionText } from "@grenier/core/api";
import { FileText, RotateCcw, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { MarkdownEditor } from "../editor/markdown-editor.tsx";
import { type Command, useCommands, useSaveCommand } from "../shell/commands.tsx";
import { DetailBar, ItemMeta, ItemName, ListDetail, Reading, useItemTitle } from "../shell/regions.tsx";
import { Button, Primary } from "../ui/button.tsx";
import { Empty, Skeleton } from "../ui/empty.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Notice, Problem } from "../ui/notice.tsx";
import { Tag } from "../ui/tag.tsx";
import { Tree, type TreeNode, useFolding } from "../ui/tree.tsx";
import { useListSearch } from "./list-search.tsx";

/** The groups start open, each project's folder closed. */
const closedFirst = (id: string) => !id.endsWith("/");

const load = () => api<{ workdir: string; files: InstructionFile[] }>("/instructions");

/** Who reads each file, for its bar and its empty page. */
const READ_BY: Record<string, string> = {
  "CLAUDE.md": "Claude Code reads it",
  "AGENTS.md": "Codex and most other agents read it",
  "CLAUDE.local.md": "Claude Code reads it, kept out of git",
  "MCP server":
    "Every agent connected to Grenier reads it, as the MCP server's instructions; grenier run also adds it to Claude Code's system prompt, in a repository",
  get: "Every agent connected to Grenier reads it, to know when to call get",
  set: "Every agent connected to Grenier reads it, to know when to call set and where its records go",
};

/** A file's title: where it applies, then its name. */
const titleOf = (file: InstructionFile) =>
  file.group === "project"
    ? `${file.project} / ${file.name}`
    : `${file.group === "every" ? "Every project" : "Grenier"} / ${file.name}`;

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
  useItemTitle(titleOf(file));
  const grenier = file.group === "grenier";
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
      return file.exists || grenier ? `Saved ${file.name}` : `Made ${file.name}`;
    });
  const reset = () =>
    void action.run("reset", async () => {
      await api(`/instructions/one?id=${encodeURIComponent(file.id)}`, { method: "DELETE" });
      return `Put back Grenier's ${file.name}`;
    });

  useSaveCommand("instructions.save", "Save the file", true, () => dirty && save());

  if (current.error) return <Problem error={current.error} />;
  if (!current.data || text === null) return <Skeleton rows={6} shape="text" />;
  return (
    <article className="flex h-full min-w-0 flex-col overflow-y-auto" data-verb="save">
      <DetailBar crumb={file.path} title={file.path}>
        <span className="text-xs text-muted">
          {dirty ? "Edited" : grenier ? (file.exists ? "Yours" : "Grenier's") : file.exists ? "Saved" : "Not made yet"}
        </span>
        {grenier && file.exists && (
          <Button size="sm" icon={RotateCcw} busy={action.busy === "reset"} onClick={reset}>
            Reset to default
          </Button>
        )}
        <Primary size="sm" keys="mod+enter" busy={action.busy === "save"} disabled={!dirty} onClick={save}>
          {file.exists || grenier ? "Save" : "Make the file"}
        </Primary>
      </DetailBar>
      <Reading>
        <ItemName>{titleOf(file)}</ItemName>
        <ItemMeta>
          {READ_BY[file.name]}
          {file.group === "project" ? ` in ${file.project}` : file.group === "every" ? ", in every project" : ""}.
        </ItemMeta>
        {grenier && (
          <p className="mt-2 text-sm text-muted">
            Your version applies from the next session that starts: a new grenier run, or the next time an app starts
            Grenier's MCP server.
          </p>
        )}
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
          />
        </div>
      </Reading>
    </article>
  );
}

/** The instructions agents read, CLAUDE.md and AGENTS.md: every project's own, and each project's in the work folder. */
export function Instructions({ item, go }: ViewProps) {
  const files = useLoad(load);
  const [unfolded, fold] = useFolding(closedFirst);
  const select = useCallback((id: string) => go("instructions", id), [go]);

  const { field: searchField, query } = useListSearch("instructions.search", "Search the projects", "Search projects");
  const commands = useMemo<Command[]>(() => [], []);
  useCommands(commands);

  const all = files.data?.files ?? [];
  const leaf = (file: InstructionFile): TreeNode => ({
    id: file.id,
    name: file.name,
    icon: FileText,
    ...(file.exists ? {} : { meta: <Tag>{file.group === "grenier" ? "default" : "none"}</Tag> }),
  });
  const projects = [...new Set(all.flatMap((file) => (file.project ? [file.project] : [])))].filter(
    (project) => !query || project.toLowerCase().includes(query),
  );
  const nodes: TreeNode[] = [
    {
      id: "every/",
      name: "Every project",
      group: true,
      children: all.filter((file) => file.group === "every").map(leaf),
    },
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
    {
      id: "grenier/",
      name: "Grenier",
      group: true,
      meta: "what it tells agents",
      children: all.filter((file) => file.group === "grenier").map(leaf),
    },
  ];
  const open = (id: string) => Boolean(query) || unfolded(id);
  // Opening a file opens its project's folder, and closes nothing.
  useEffect(() => {
    if (item?.startsWith("project/")) fold(`projects/${item.split("/")[1]}`, true);
  }, [item, fold]);

  const list = (
    <>
      {searchField}
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
            onToggle={fold}
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
