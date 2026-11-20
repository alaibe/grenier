import type { ViewProps } from "../App.tsx";
import { setUsageEnabled, usageEnabled } from "../api.ts";
import { Loading, Notice, Page, useAction, useLoad } from "../ui.tsx";

export function Settings(_: ViewProps) {
  const { data: on, error, reload } = useLoad(usageEnabled);
  const action = useAction(reload);

  const turn = (enabled: boolean) =>
    void action.run("usage", async () => {
      await setUsageEnabled(enabled);
      return {
        text: enabled
          ? "Usage statistics are on."
          : "Usage statistics are off, and the random id they were counted by is deleted.",
      };
    });

  return (
    <Page title="Settings" intro="How this app behaves on this computer.">
      <Notice message={error ?? action.message} />
      {on === null && !error && <Loading what="settings" />}
      {on !== null && (
        <section className="rounded-xl border border-line bg-panel px-5 py-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 accent-accent"
              checked={on}
              disabled={action.busy !== null}
              onChange={(event) => turn(event.currentTarget.checked)}
            />
            <span>
              <span className="font-medium">Share anonymous usage statistics</span>
              <span className="mt-0.5 block text-md text-muted">
                Sends which screens you open, Grenier's version and your system to stats.laibe.cc, to count how Grenier
                is used. Nothing you write or read.
              </span>
            </span>
          </label>
        </section>
      )}
    </Page>
  );
}
