import type { FormEvent } from "react";
import type { ViewProps } from "../App.tsx";
import { api, type BudgetsView } from "../api.ts";
import { Button, Field, Input, Loading, money, Notice, Page, useAction, useLoad } from "../ui.tsx";

const load = () => api<BudgetsView>("/budgets");

type Scope = "daily" | "session" | "repo";

export function Budgets(_: ViewProps) {
  const { data, error, reload } = useLoad(load);
  const action = useAction(reload);

  const change = (scope: Scope, key: string, limit: number | null, label: string) =>
    action.run(`${scope}:${key}`, async () => {
      await api("/budgets", { body: { scope, key, limit } });
      return { text: limit === null ? `Removed the limit ${label}.` : `The limit ${label} is now ${money(limit)}.` };
    });

  const save = (scope: Scope, key: string, label: string) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("limit") ?? "").trim();
    void change(scope, key, value === "" ? null : Number(value), label);
  };

  const limited = new Set(data?.repos.map((entry) => entry.name));
  const choices = data?.known.filter((name) => !limited.has(name)) ?? [];

  return (
    <Page
      title="Budgets"
      intro="Grenier stops a request before it goes out once a limit is reached, or when the request would pass it at what the session's last one cost. The agent is told which limit, and does not retry."
    >
      <Notice message={error ?? action.message} />
      {!data && !error && <Loading what="budgets" />}
      {data && (
        <>
          <p className="mb-4 text-muted">Spent today, all agents together: {money(data.spentToday)}.</p>
          <section className="mb-6 rounded-xl border border-line bg-panel px-5 py-1.5">
            <Limit
              title="Every day"
              hint={data.fromConfig.daily ? "All agents together, from config.toml" : "All agents together"}
              value={data.daily}
              removable={!data.fromConfig.daily}
              busy={action.busy !== null}
              onSubmit={save("daily", "", "for every day")}
              onRemove={() => void change("daily", "", null, "for every day")}
            />
            <Limit
              title="Each session"
              hint={data.fromConfig.session ? "One grenier run, from config.toml" : "One grenier run, start to end"}
              value={data.session}
              removable={!data.fromConfig.session}
              busy={action.busy !== null}
              onSubmit={save("session", "", "for each session")}
              onRemove={() => void change("session", "", null, "for each session")}
            />
            {data.repos.map((entry) => (
              <Limit
                key={entry.name}
                title={entry.name}
                hint="A day, in this project"
                value={entry.limit}
                removable
                busy={action.busy !== null}
                onSubmit={save("repo", entry.name, `for ${entry.name}`)}
                onRemove={() => void change("repo", entry.name, null, `for ${entry.name}`)}
              />
            ))}
          </section>
          <form
            className="flex max-w-150 items-end gap-3 rounded-xl border border-line bg-panel px-5 py-4 max-md:flex-wrap"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const name = String(form.get("repo") ?? "").trim();
              const target = event.currentTarget;
              void change("repo", name, Number(form.get("limit")), `for ${name}`).then((done) => {
                if (done) target.reset();
              });
            }}
          >
            <Field>
              A limit for a project
              <Input
                name="repo"
                list="known-repos"
                required
                maxLength={128}
                pattern="[^\s=]+"
                title="The project's folder name, without spaces: its repository's, or the one an agent started in"
                placeholder={choices[0] ?? "its folder name"}
                autoComplete="off"
                spellCheck={false}
              />
              <datalist id="known-repos">
                {choices.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </Field>
            <Field>
              Dollars a day
              <Input name="limit" type="number" min="0" step="0.01" required />
            </Field>
            <Button type="submit" disabled={action.busy !== null}>
              Add
            </Button>
          </form>
        </>
      )}
    </Page>
  );
}

function Limit({
  title,
  hint,
  value,
  removable,
  busy,
  onSubmit,
  onRemove,
}: {
  title: string;
  hint: string;
  value: number | null;
  removable: boolean;
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRemove: () => void;
}) {
  return (
    <form
      key={String(value)}
      className="flex items-center justify-between gap-4 border-t border-line py-3 first:border-t-0 max-md:flex-wrap"
      onSubmit={onSubmit}
    >
      <div>
        <b className="font-semibold">{title}</b>
        <span className="block text-sm text-muted">{hint}</span>
      </div>
      <div className="flex items-center gap-2">
        <label className="w-28">
          <span className="sr-only">Dollars for {title}</span>
          <Input name="limit" type="number" min="0" step="0.01" defaultValue={value ?? ""} placeholder="no limit" />
        </label>
        <Button type="submit" disabled={busy}>
          Save
        </Button>
        <Button
          quiet
          className={value !== null && removable ? "" : "invisible"}
          disabled={busy || value === null || !removable}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
    </form>
  );
}
