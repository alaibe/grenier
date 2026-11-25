import type { FoundSkill, SharedNow } from "@grenier/core/api";
import { Plus, Share2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { count } from "../format.ts";
import { type Command, useCommands } from "../shell/commands.tsx";
import { Detail } from "../shell/regions.tsx";
import { Button, Primary } from "../ui/button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Empty } from "../ui/empty.tsx";
import { Field, Input, SearchField, Textarea } from "../ui/field.tsx";
import { useAction } from "../ui/load.ts";
import { Problem } from "../ui/notice.tsx";
import { Page, Section } from "../ui/page.tsx";
import { Table } from "../ui/table.tsx";
import { Shared } from "./Shared.tsx";

/** Skills found on skills.sh, which a click shares with the team from GitHub; each teammate still approves it. */
function FindSkills({ shared }: { shared: () => void }) {
  const [found, setFound] = useState<{ words: string; skills: FoundSkill[] } | null>(null);
  const action = useAction(shared);
  const field = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(
    () => [
      {
        id: "skills.search",
        label: "Search skills.sh",
        keys: "/",
        also: ["mod+f"],
        hint: { in: "list", says: "search", order: 30 },
        run: () => field.current?.focus(),
      },
    ],
    [],
  );
  useCommands(commands);

  const add = (skill: FoundSkill) =>
    void action.run(`share:${skill.id}`, async () => {
      const done = await api<SharedNow>("/installs/share", { body: { source: skill.source, name: skill.name } });
      return `${done.updated ? "Shared a new version of" : "Shared"} ${done.title} with the team`;
    });

  return (
    <Section
      heading
      title="Find a skill"
      description="Searches skills.sh with the words you type, and nothing else. Share fetches the skill from GitHub into the team, where each teammate reads it before installing it."
    >
      <div className="grid gap-3">
        <form
          className="max-w-(--layout-reading)"
          onSubmit={(event) => {
            event.preventDefault();
            const words = field.current?.value.trim() ?? "";
            if (!words) return;
            void action.run(
              "search",
              async () => {
                const answer = await api<{ skills: FoundSkill[] }>(`/installs/search?q=${encodeURIComponent(words)}`);
                setFound({ words, skills: answer.skills });
                return undefined;
              },
              "Searching",
            );
          }}
        >
          <SearchField ref={field} label="Words to search skills.sh for" placeholder="release notes, react, testing…" />
        </form>
        <Problem error={action.problem} />
        {found && found.skills.length === 0 && (
          <Empty boot="no match" match>
            No skill on skills.sh holds “{found.words}”. Try fewer words.
          </Empty>
        )}
        {found && found.skills.length > 0 && (
          <Table
            label="Skills found"
            head={
              <>
                <th>Skill</th>
                <th className="num">Installs</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </>
            }
          >
            {found.skills.map((skill) => (
              <tr key={skill.id}>
                <td className="py-1.5 whitespace-normal">
                  <span className="block font-semibold">{skill.name}</span>
                  <span className="block font-mono text-xs text-muted">{skill.source}</span>
                </td>
                <td className="num mono">{count(skill.installs)}</td>
                <td className="num">
                  <Button
                    size="sm"
                    icon={Share2}
                    busy={action.busy === `share:${skill.id}`}
                    disabled={action.busy !== null}
                    onClick={() => add(skill)}
                  >
                    Share with the team
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </Section>
  );
}

/** A skill written in the app: its SKILL.md, from a name, a one-line description and the instructions. */
function NewSkill({ added, cancel }: { added: () => void; cancel: () => void }) {
  const action = useAction(added);
  return (
    <Dialog
      wide
      title="New skill"
      action="Share with the team"
      busy={action.busy !== null}
      onCancel={cancel}
      onAction={(form) =>
        void action.run("skill", async () => {
          await api("/installs/skill", {
            body: {
              name: String(form.get("name") ?? ""),
              description: String(form.get("description") ?? ""),
              instructions: String(form.get("instructions") ?? ""),
            },
          });
          return `Shared ${String(form.get("name"))}: each person installs it, or not`;
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

export function Skills({ item, go, member }: ViewProps) {
  const [round, setRound] = useState(0);
  const again = () => setRound((n) => n + 1);
  const close = () => go("skills");
  const commands = useMemo<Command[]>(
    () =>
      member
        ? []
        : [
            {
              id: "new-skill",
              label: "New skill",
              icon: Plus,
              keys: "n",
              also: ["mod+n"],
              hint: { in: "list", says: "new", order: 20 },
              run: () => go("skills", "new"),
            },
          ],
    [member, go],
  );
  useCommands(commands);
  return (
    <Detail title="Skills">
      <Page
        title="Skills"
        intro="What the team shares for its agents. An admin adds a skill; you install it or not. Installing approves it as it is now: a later change waits for your approval again."
        primary={
          !member && (
            <Primary keys="n" onClick={() => go("skills", "new")}>
              New skill…
            </Primary>
          )
        }
      >
        <Section heading title="Shared">
          <Shared
            key={round}
            type="Skill"
            go={go}
            none={member ? "No skill shared yet." : "No skill shared yet. Write one, or find one on skills.sh below."}
          />
        </Section>
        {!member && <FindSkills shared={again} />}
      </Page>
      {!member && item === "new" && (
        <NewSkill
          added={() => {
            again();
            close();
          }}
          cancel={close}
        />
      )}
    </Detail>
  );
}
