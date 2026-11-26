import type { MachineRules, MachineState } from "@grenier/core/api";
import { isTauri } from "@tauri-apps/api/core";
import type { FocusEvent } from "react";
import { useSaved } from "../activity.tsx";
import { api, pickFolder } from "../api.ts";
import { stateTag } from "../states.ts";
import { Button } from "../ui/button.tsx";
import { Toggle } from "../ui/choice.tsx";
import { Skeleton } from "../ui/empty.tsx";
import { Field, Input, Select } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Problem } from "../ui/notice.tsx";
import { Section } from "../ui/page.tsx";
import { Status } from "../ui/tag.tsx";
import { usePolling } from "./polling.ts";

const load = () => api<MachineState>("/machine");

const SAYS = {
  available: "It takes a routine's run when the team has one for it.",
  busy: "A run is going.",
  away: "Not available",
};

/** For Settings: when this machine takes the team's routine runs. Each rule saves as it changes (patterns/forms.md). */
export function MachineSettings() {
  const { data, error, reload } = useLoad(load);
  const flash = useSaved();
  const action = useAction(() => {
    reload();
    flash();
  });
  usePolling(reload, 15_000);

  const save = (rules: Partial<MachineRules>) =>
    void action.run("save", async () => {
      await api("/machine", { method: "PUT", body: { rules } });
      return undefined;
    });
  /** Saves a field when it is left changed. */
  const leave =
    (rule: (value: string) => Partial<MachineRules>, was: string) => (event: FocusEvent<HTMLInputElement>) => {
      const value = event.currentTarget.value.trim();
      if (value !== was && event.currentTarget.checkValidity()) save(rule(value));
    };

  const choose = () =>
    pickFolder(data?.rules.workdir ?? "").then(
      (workdir) => {
        if (workdir && workdir !== data?.rules.workdir) save({ workdir });
      },
      (reason: unknown) => void action.run("save", () => Promise.reject(reason)),
    );

  const [from = "0", to = "24"] = (data?.rules.hours ?? "0-24").split("-");
  return (
    <Section
      heading
      title="This machine"
      description="Routines run here only while every rule holds, at the lowest priority. When you come back, a run waits for you to leave again, or goes to another machine."
    >
      <Problem error={error ?? action.problem} />
      {!data && !error && <Skeleton rows={4} shape="text" />}
      {data && (
        <div key={JSON.stringify(data.rules)} className="grid gap-4">
          <div className="section-row">
            <div className="flex-1">
              <Toggle
                label="Take the team's routine runs"
                description={
                  data.rules.routines
                    ? data.state === "away"
                      ? `${SAYS.away}: ${data.reasons.join("; ")}.`
                      : SAYS[data.state]
                    : "Off: this machine runs nothing for the team."
                }
                checked={data.rules.routines}
                disabled={action.busy !== null}
                onChange={(event) => save({ routines: event.currentTarget.checked })}
              />
            </div>
            {data.rules.routines && <Status {...stateTag(data.state)} />}
          </div>
          <div className="grid max-w-(--layout-reading) gap-4">
            <Field label="Work folder" help="The folder that holds your projects: every routine runs in it.">
              <div className="flex gap-2">
                <div className="flex-1">
                  <Input
                    mono
                    defaultValue={data.rules.workdir}
                    placeholder="/home/me/Work"
                    required
                    autoComplete="off"
                    spellCheck={false}
                    onBlur={leave((workdir) => ({ workdir }), data.rules.workdir)}
                  />
                </div>
                {isTauri() && (
                  <Button disabled={action.busy !== null} onClick={choose}>
                    Choose…
                  </Button>
                )}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Name" help="What the team sees.">
                <Input
                  defaultValue={data.rules.name ?? ""}
                  placeholder="This computer's name"
                  onBlur={leave((name) => (name ? { name } : {}), data.rules.name ?? "")}
                />
              </Field>
              <Field label="Agent">
                <Select
                  defaultValue={data.rules.agent}
                  onChange={(event) => save({ agent: event.currentTarget.value as MachineRules["agent"] })}
                >
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                </Select>
              </Field>
              <Field label="Idle for, in minutes" help="0 for always on.">
                <Input
                  type="number"
                  mono
                  min={0}
                  defaultValue={data.rules.idle_minutes}
                  onBlur={leave((value) => ({ idle_minutes: Number(value) }), String(data.rules.idle_minutes))}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="From hour">
                  <Input
                    type="number"
                    mono
                    min={0}
                    max={23}
                    defaultValue={from}
                    onBlur={leave((value) => ({ hours: `${value}-${to}` }), from)}
                  />
                </Field>
                <Field label="To hour">
                  <Input
                    type="number"
                    mono
                    min={0}
                    max={24}
                    defaultValue={to}
                    onBlur={leave((value) => ({ hours: `${from}-${value}` }), to)}
                  />
                </Field>
              </div>
              <Field label="CPU below, in %">
                <Input
                  type="number"
                  mono
                  min={1}
                  max={100}
                  defaultValue={Math.round(data.rules.cpu_max * 100)}
                  onBlur={leave(
                    (value) => ({ cpu_max: Number(value) / 100 }),
                    String(Math.round(data.rules.cpu_max * 100)),
                  )}
                />
              </Field>
              <Field label="Memory below, in %">
                <Input
                  type="number"
                  mono
                  min={1}
                  max={100}
                  defaultValue={Math.round(data.rules.memory_max * 100)}
                  onBlur={leave(
                    (value) => ({ memory_max: Number(value) / 100 }),
                    String(Math.round(data.rules.memory_max * 100)),
                  )}
                />
              </Field>
            </div>
          </div>
          <div className="section-row">
            <div className="flex-1">
              <Toggle
                label="Only on mains power"
                checked={data.rules.plugged_in}
                disabled={action.busy !== null}
                onChange={(event) => save({ plugged_in: event.currentTarget.checked })}
              />
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}
