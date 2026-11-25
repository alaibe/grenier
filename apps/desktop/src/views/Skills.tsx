import type { FoundSkill, SharedNow } from "@grenier/core/api";
import { Share2 } from "lucide-react";
import { useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import {
  Actions,
  Button,
  Empty,
  Field,
  FormCard,
  Input,
  Notice,
  Page,
  SearchBox,
  Section,
  Table,
  Textarea,
  useAction,
  useAdding,
} from "../ui.tsx";
import { Shared } from "./Shared.tsx";

/** Skills found on skills.sh, which a click shares with the team from GitHub; each teammate still approves it. */
function FindSkills({ shared }: { shared: () => void }) {
  const [found, setFound] = useState<FoundSkill[] | null>(null);
  const action = useAction(shared);

  const search = (words: string) =>
    void action.run("search", async () => {
      setFound((await api<{ skills: FoundSkill[] }>(`/installs/search?q=${encodeURIComponent(words)}`)).skills);
      return undefined;
    });

  const add = (skill: FoundSkill) =>
    void action.run(`share:${skill.id}`, async () => {
      const done = await api<SharedNow>("/installs/share", {
        body: { source: skill.source, name: skill.name },
      });
      return {
        text: `${done.updated ? "Shared a new version of" : "Shared"} ${done.title} with the team. Install it above to use it here.`,
      };
    });

  return (
    <Section
      title="Find a skill"
      intro="Searches skills.sh with the words you type, and nothing else. Share fetches the skill from GitHub into the team, where each teammate reads it before installing it."
    >
      <SearchBox
        className="mb-3"
        label="Words to search for"
        placeholder="release notes, react, testing…"
        busy={action.busy === "search"}
        disabled={action.busy !== null}
        onSearch={search}
      />
      <Notice message={action.message} />
      {found && found.length === 0 && <Empty>No skill on skills.sh matches those words.</Empty>}
      {found && found.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th>Skill</th>
              <th className="text-right tabular-nums">Installs</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {found.map((skill) => (
              <tr key={skill.id}>
                <td className="whitespace-normal">
                  <span className="font-medium">{skill.name}</span>
                  <span className="block text-sm text-muted">{skill.source}</span>
                </td>
                <td className="text-right tabular-nums">{skill.installs.toLocaleString()}</td>
                <td>
                  <div className="flex justify-end">
                    <Button quiet icon={Share2} disabled={action.busy !== null} onClick={() => add(skill)}>
                      {action.busy === `share:${skill.id}` ? "Sharing…" : "Share with the team"}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Section>
  );
}

/** A skill written in the app: its SKILL.md, from a name, a one-line description and the instructions. */
function NewSkill({ added }: { added: () => void }) {
  const action = useAction(added);
  const adding = useAdding("New skill");
  if (!adding.open) return adding.button;
  return (
    <FormCard
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void action
          .run("skill", async () => {
            await api("/installs/skill", {
              body: {
                name: String(form.get("name") ?? ""),
                description: String(form.get("description") ?? ""),
                instructions: String(form.get("instructions") ?? ""),
              },
            });
            return { text: "Shared with the team. Each person installs it, or not." };
          })
          .then((ok) => ok && adding.done());
      }}
    >
      <Notice message={action.message} />
      <Field>
        Name, in lowercase with dashes
        <Input name="name" placeholder="release-notes" required pattern="[a-z0-9][a-z0-9\-]*" />
      </Field>
      <Field>
        When an agent should use it, in one line
        <Input
          name="description"
          placeholder="Writes release notes from the pull requests merged since the last tag."
          required
        />
      </Field>
      <Field>
        Instructions, in Markdown
        <Textarea name="instructions" mono className="min-h-32" required />
      </Field>
      <Actions>
        <Button type="submit" disabled={action.busy !== null}>
          Share with the team
        </Button>
        <Button quiet onClick={adding.done}>
          Cancel
        </Button>
      </Actions>
    </FormCard>
  );
}

export function Skills({ go, member }: ViewProps) {
  const [round, setRound] = useState(0);
  const again = () => setRound((n) => n + 1);
  return (
    <Page
      title="Skills"
      intro="What the team shares for its agents. An admin adds a skill; you install it or not. Installing one approves it as it is now: a later change waits for your approval again."
    >
      <Shared
        key={round}
        type="Skill"
        go={go}
        none={
          <p>{member ? "No skill shared yet." : "No skill shared yet. Write one, or find one on skills.sh below."}</p>
        }
      />
      {!member && (
        <div className="mb-7">
          <NewSkill added={again} />
        </div>
      )}
      {!member && <FindSkills shared={again} />}
    </Page>
  );
}
