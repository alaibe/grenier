import type { FoundSkill, LocalSkill, SharedState } from "@grenier/core/api";
import { FilePlus, Link2, Search, Sparkles } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { count } from "../format.ts";
import { type Command, useCommands } from "../shell/commands.tsx";
import { ListDetail } from "../shell/regions.tsx";
import { installTag } from "../states.ts";
import { Button, IconButton } from "../ui/button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Empty, Skeleton } from "../ui/empty.tsx";
import { Field, Input, SearchField, Textarea } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Problem } from "../ui/notice.tsx";
import { Status, Tag } from "../ui/tag.tsx";
import { Tree, type TreeNode, toTree, useFolding } from "../ui/tree.tsx";
import { LocalSkillView, TeamSkillView } from "./SkillDetail.tsx";

const loadLocal = () => api<{ skills: LocalSkill[] }>("/skills").then((answer) => answer.skills);
const loadTeam = () =>
  api<{ shared: SharedState[] }>("/installs").then((answer) => answer.shared.filter((entry) => entry.type === "Skill"));

/** Where a new skill goes: the person's own skills, or the team's. */
type Group = "me" | "team";
interface Adding {
  to: Group;
  how: "find" | "write";
}

/** skills.sh's skills that match some words: Add puts one in the person's skills, or shares it with the team. */
function FindSkill({ to, added, cancel }: { to: Group; added: (id: string) => void; cancel: () => void }) {
  const [found, setFound] = useState<{ words: string; skills: FoundSkill[] } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const action = useAction();
  const add = (skill: FoundSkill) =>
    void action.run(`add:${skill.id}`, async () => {
      const body = { source: skill.source, name: skill.name };
      if (to === "me") {
        const done = await api<{ id: string }>("/skills/found", { body });
        added(`me:${done.id}`);
        return `Added ${skill.name} to your skills`;
      }
      const done = await api<{ id: string; title: string }>("/installs/share", { body });
      added(`team:${done.id}`);
      return `Shared ${done.title} with the team: each teammate installs it, or not`;
    });
  return (
    <Dialog
      wide
      title={to === "me" ? "Find a skill for you" : "Find a skill for the team"}
      action="Search"
      cancel="Close"
      busy={action.busy === "search"}
      onCancel={cancel}
      onAction={() => {
        const words = field.current?.value.trim() ?? "";
        if (!words) return;
        void action.run("search", async () => {
          const answer = await api<{ skills: FoundSkill[] }>(`/installs/search?q=${encodeURIComponent(words)}`);
          setFound({ words, skills: answer.skills });
          return undefined;
        });
      }}
    >
      <p className="text-muted">
        Searches skills.sh with the words you type, and nothing else. Add fetches the skill from GitHub
        {to === "me"
          ? " into your skills folder."
          : " into the team, where each teammate reads it before installing it."}
      </p>
      <SearchField ref={field} label="Words to search skills.sh for" placeholder="release notes, react, testing…" />
      <Problem error={action.problem} />
      {found && found.skills.length === 0 && <p className="text-muted">No skill on skills.sh holds “{found.words}”.</p>}
      {found && found.skills.length > 0 && (
        <ul className="grid max-h-80 overflow-y-auto border-y border-line">
          {found.skills.map((skill) => (
            <li key={skill.id} className="flex items-center gap-3 border-b border-line py-2 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{skill.name}</p>
                <p className="truncate font-mono text-xs text-muted">
                  {skill.source} · {count(skill.installs)} installs
                </p>
              </div>
              <Button
                size="sm"
                busy={action.busy === `add:${skill.id}`}
                disabled={action.busy !== null}
                onClick={() => add(skill)}
              >
                Add
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** A skill written from scratch: its SKILL.md from a name, a one-line description and the instructions. */
function WriteSkill({ to, added, cancel }: { to: Group; added: (id: string) => void; cancel: () => void }) {
  const action = useAction();
  return (
    <Dialog
      wide
      title={to === "me" ? "New skill" : "New skill for the team"}
      action={to === "me" ? "Add the skill" : "Share with the team"}
      busy={action.busy !== null}
      onCancel={cancel}
      onAction={(form) =>
        void action.run("write", async () => {
          const body = {
            name: String(form.get("name") ?? ""),
            description: String(form.get("description") ?? ""),
            instructions: String(form.get("instructions") ?? ""),
          };
          if (to === "me") {
            const done = await api<{ id: string }>("/skills", { body });
            added(`me:${done.id}`);
            return `Added ${body.name} to your skills`;
          }
          const done = await api<{ id: string }>("/installs/skill", { body });
          added(`team:${done.id}`);
          return `Shared ${body.name}: each teammate installs it, or not`;
        })
      }
    >
      <Problem error={action.problem} />
      <Field label="Name" help="Lowercase, with dashes.">
        <Input name="name" mono placeholder="release-notes" required pattern="[a-z0-9][a-z0-9\-]*" />
      </Field>
      <Field label="When to use it" help="One line: an agent reads it to decide.">
        <Input
          name="description"
          placeholder="Writes release notes from the pull requests merged since the last tag."
          required
        />
      </Field>
      <Field label="Instructions" help="In Markdown.">
        <Textarea name="instructions" mono rows={8} required />
      </Field>
    </Dialog>
  );
}

/** Folders start open, except Synced and Plugins. Kept in this window only. */
const closedFirst = (id: string) => id === "me/synced" || id === "me/plugins";

export function Skills({ item, go, member, team }: ViewProps) {
  const local = useLoad(loadLocal);
  const loadShared = useCallback(() => (team ? loadTeam() : Promise.resolve([])), [team]);
  const shared = useLoad(loadShared);
  const [open, setOpen] = useFolding(closedFirst);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [words, setWords] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const query = words.trim().toLowerCase();
  const matches = (name: string, description: string) =>
    !query || name.toLowerCase().includes(query) || description.toLowerCase().includes(query);
  const admin = Boolean(team) && !member;
  const reload = () => {
    local.reload();
    shared.reload();
  };
  const select = useCallback((id: string) => go("skills", id), [go]);

  const commands = useMemo<Command[]>(
    () => [
      {
        id: "new-skill",
        label: "New skill",
        icon: FilePlus,
        keys: "n",
        also: ["mod+n"],
        hint: { in: "list", says: "new", order: 20 },
        run: () => setAdding({ to: "me", how: "write" }),
      },
      {
        id: "skills.search",
        label: "Search the skills",
        keys: "/",
        also: ["mod+f"],
        hint: { in: "list", says: "search", order: 30 },
        run: () => search.current?.focus(),
      },
      {
        id: "skills.find",
        label: "Find a skill on skills.sh",
        icon: Search,
        run: () => setAdding({ to: "me", how: "find" }),
      },
    ],
    [],
  );
  useCommands(commands);

  const adds = (to: Group) => (
    <>
      <IconButton label="Find on skills.sh" icon={Search} size="sm" onClick={() => setAdding({ to, how: "find" })} />
      <IconButton label="Write a new skill" icon={FilePlus} size="sm" onClick={() => setAdding({ to, how: "write" })} />
    </>
  );
  const skills = local.data ?? [];
  const shown = skills.filter((skill) => matches(skill.name, `${skill.agent} ${skill.description}`));
  const leaf = (skill: LocalSkill): TreeNode => ({
    id: `me:${skill.id}`,
    name: skill.name,
    icon: skill.kind === "linked" ? Link2 : Sparkles,
    meta: skill.kind === "linked" && <Tag>linked</Tag>,
  });
  const agents = [...new Set(shown.map((skill) => skill.agent))];
  const ofAgent = (agent: string): TreeNode => {
    const mine = shown.filter((skill) => skill.agent === agent);
    const synced = mine.filter((skill) => skill.kind === "synced");
    const plugins = mine.filter((skill) => skill.kind === "plugin");
    return {
      id: `me/${agent}/`,
      name: agent,
      children: [
        ...mine.filter((skill) => skill.kind === "own" || skill.kind === "linked").map(leaf),
        ...(synced.length > 0 ? [{ id: `me/${agent}/synced`, name: "Synced", children: synced.map(leaf) }] : []),
        ...(plugins.length > 0 ? [{ id: `me/${agent}/plugins`, name: "Plugins", children: plugins.map(leaf) }] : []),
      ],
    };
  };
  const nodes: TreeNode[] = [
    {
      id: "me/",
      name: "Me",
      group: true,
      meta: "this machine",
      actions: adds("me"),
      children: agents.map(ofAgent),
    },
    ...(team
      ? [
          {
            id: "team/",
            name: "Team",
            group: true,
            meta: "shared",
            ...(admin ? { actions: adds("team") } : {}),
            children: (shared.data ?? [])
              .filter((entry) => matches(entry.title, entry.description))
              .map((entry) => ({
                id: `team:${entry.id}`,
                name: entry.title,
                icon: Sparkles,
                meta: <Status {...installTag(entry.state)} />,
              })),
          },
        ]
      : []),
  ];

  const list = (
    <>
      <div className="border-b border-line p-3">
        <SearchField
          ref={search}
          label="Search the skills"
          placeholder="Search skills"
          live
          value={words}
          onChange={(event) => setWords(event.currentTarget.value)}
          onKeyDown={toTree}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Problem error={local.error ?? shared.error} />
        {local.error ? null : !local.data ? (
          <Skeleton rows={8} />
        ) : (
          <Tree
            label="Skills"
            nodes={nodes}
            selected={item ?? null}
            open={query ? () => true : open}
            onSelect={(node) => node.children === undefined && select(node.id)}
            onToggle={setOpen}
            onOpen={(node) => select(node.id)}
          />
        )}
        {query &&
          local.data &&
          shown.length === 0 &&
          !shared.data?.some((entry) => matches(entry.title, entry.description)) && (
            <Empty boot="no match" match>
              No skill holds “{words.trim()}”. Find one with Find on skills.sh, beside Me.
            </Empty>
          )}
      </div>
    </>
  );

  const entry = item?.startsWith("team:") ? shared.data?.find((one) => `team:${one.id}` === item) : undefined;
  const detail = item?.startsWith("me:") ? (
    <LocalSkillView
      key={item}
      id={item.slice(3)}
      share={admin}
      changed={reload}
      removed={() => go("skills")}
      open={(id) => go("knowledge", id)}
    />
  ) : entry ? (
    <TeamSkillView
      key={item}
      entry={entry}
      admin={admin}
      changed={reload}
      removed={() => {
        reload();
        go("skills");
      }}
      open={(id) => go("knowledge", id)}
    />
  ) : local.error ? null : (
    <Empty boot={local.data && skills.length === 0 && !shared.data?.length ? "no skills yet" : "pick a skill"}>
      Your skills are the ones Claude Code and Codex load from their skills folders; a new one goes to both.
      {team ? " The team's install here once you approve them." : ""} Find one on skills.sh, or write one.
    </Empty>
  );

  return (
    <ListDetail title="Skills" list={list}>
      {detail}
      {adding?.how === "find" && (
        <FindSkill
          to={adding.to}
          added={(id) => {
            setAdding(null);
            reload();
            select(id);
          }}
          cancel={() => setAdding(null)}
        />
      )}
      {adding?.how === "write" && (
        <WriteSkill
          to={adding.to}
          added={(id) => {
            setAdding(null);
            reload();
            select(id);
          }}
          cancel={() => setAdding(null)}
        />
      )}
    </ListDetail>
  );
}
