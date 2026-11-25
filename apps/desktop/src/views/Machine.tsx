import type { MachineRules, MachineState } from "@grenier/core/api";
import { type FormEvent, useEffect } from "react";
import { api } from "../api.ts";
import {
  Actions,
  Button,
  Card,
  Checkbox,
  Field,
  FormCard,
  Input,
  Loading,
  Notice,
  Part,
  Select,
  useAction,
  useLoad,
} from "../ui.tsx";

const load = () => api<MachineState>("/machine");

const SAYS = {
  available: "Available: it takes a routine's run when the team has one for it.",
  busy: "Busy: a run is going.",
  away: "Not available",
};

/** For Settings: when this machine takes the team's routine runs. */
export function Machine() {
  const { data, error, reload } = useLoad(load);
  const action = useAction(reload);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) reload();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const save = (rules: Partial<MachineRules>, done: string) =>
    void action.run("save", async () => {
      await api("/machine", { method: "PUT", body: { rules } });
      return { text: done };
    });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const from = String(form.get("from") ?? "0");
    const to = String(form.get("to") ?? "24");
    save(
      {
        ...(String(form.get("name") ?? "").trim() ? { name: String(form.get("name")).trim() } : {}),
        plugged_in: form.get("plugged_in") === "on",
        idle_minutes: Number(form.get("idle_minutes")),
        cpu_max: Number(form.get("cpu_max")) / 100,
        memory_max: Number(form.get("memory_max")) / 100,
        hours: `${from}-${to}`,
        agent: String(form.get("agent")) as MachineRules["agent"],
      },
      "Saved. The team sees this machine's new state at once.",
    );
  };

  const [from, to] = (data?.rules.hours ?? "0-24").split("-");
  return (
    <Part
      title="This machine"
      intro="Routines run here only while every rule holds, at the lowest priority. When you come back, a run waits for you to leave again, or goes to another machine."
    >
      <Notice message={error ?? action.message} />
      {!data && !error && <Loading what="this machine" />}
      {data && (
        <>
          <FormCard
            key={`workdir:${data.rules.workdir}`}
            onSubmit={(event) => {
              event.preventDefault();
              const workdir = String(new FormData(event.currentTarget).get("workdir") ?? "").trim();
              save({ workdir }, "Saved. Every routine on this machine runs in this folder.");
            }}
          >
            <Field>
              Work folder: the folder that holds your projects, where every routine runs
              <Input
                name="workdir"
                defaultValue={data.rules.workdir}
                placeholder="/home/me/Work"
                required
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Actions>
              <Button type="submit" disabled={action.busy !== null}>
                Save the folder
              </Button>
            </Actions>
          </FormCard>
          <Card>
            <Checkbox
              label="Take the team's routine runs"
              hint={
                data.rules.routines
                  ? data.state === "away"
                    ? `${SAYS.away}: ${data.reasons.join("; ")}.`
                    : SAYS[data.state]
                  : "Off: this machine runs nothing for the team."
              }
              checked={data.rules.routines}
              disabled={action.busy !== null}
              onChange={(event) =>
                save(
                  { routines: event.currentTarget.checked },
                  event.currentTarget.checked
                    ? "This machine takes the team's routine runs when its rules hold."
                    : "This machine takes no routine runs.",
                )
              }
            />
          </Card>

          <FormCard key={JSON.stringify(data.rules)} className="grid-cols-2 max-md:grid-cols-1" onSubmit={submit}>
            <Field>
              Name the team sees
              <Input name="name" defaultValue={data.rules.name ?? ""} placeholder="This computer's name" />
            </Field>
            <Field>
              Agent
              <Select name="agent" defaultValue={data.rules.agent}>
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
              </Select>
            </Field>
            <Field>
              Idle for, in minutes (0 for always on)
              <Input name="idle_minutes" type="number" min={0} defaultValue={data.rules.idle_minutes} />
            </Field>
            <Field>
              Hours
              <span className="flex items-center gap-2">
                <Input name="from" type="number" min={0} max={23} defaultValue={from} aria-label="From" />
                to
                <Input name="to" type="number" min={0} max={24} defaultValue={to} aria-label="To" />
              </span>
            </Field>
            <Field>
              CPU below, in %
              <Input
                name="cpu_max"
                type="number"
                min={1}
                max={100}
                defaultValue={Math.round(data.rules.cpu_max * 100)}
              />
            </Field>
            <Field>
              Memory below, in %
              <Input
                name="memory_max"
                type="number"
                min={1}
                max={100}
                defaultValue={Math.round(data.rules.memory_max * 100)}
              />
            </Field>
            <Checkbox
              className="col-span-full"
              label="Only on mains power"
              name="plugged_in"
              defaultChecked={data.rules.plugged_in}
            />
            <Actions className="col-span-full">
              <Button type="submit" disabled={action.busy !== null}>
                Save the rules
              </Button>
            </Actions>
          </FormCard>
        </>
      )}
    </Part>
  );
}
