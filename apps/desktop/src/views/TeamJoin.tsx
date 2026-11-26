import type { Deployed, Joining } from "@grenier/core/api";
import { ArrowRight } from "lucide-react";
import { useCallback, useState } from "react";
import { api } from "../api.ts";
import { Button, Primary } from "../ui/button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Field, Input } from "../ui/field.tsx";
import { useAction } from "../ui/load.ts";
import { Notice, Problem } from "../ui/notice.tsx";
import { Page, Section } from "../ui/page.tsx";
import { Stat, Stats } from "../ui/stat.tsx";
import { usePolling } from "./polling.ts";

/** The six digits a joining machine shows, read as "123 456". */
export const spaced = (code: string | null | undefined) => code?.replace(/^(\d{3})(\d{3})$/, "$1 $2") ?? "";

/** Updates the team store with the token the last deploy kept; `reload` follows either way, as a refused token is forgotten. */
export function useStoreUpdate(reload: () => void) {
  const action = useAction();
  const run = () =>
    void action
      .run(
        "deploy",
        () => api<Deployed>("/deploy", { body: {} }).then((made) => `Updated the team store at ${made.url}`),
        "Updating the team store",
      )
      .finally(reload);
  return { run, busy: action.busy !== null, problem: action.problem };
}

/** The team store put in a Cloudflare account, or updated there; the token that worked is kept for the next update. */
export function Deploy({
  name,
  me,
  title,
  action: verb,
  done,
  cancel,
}: {
  name: string;
  me: string;
  title: string;
  action: string;
  done: () => void;
  cancel: () => void;
}) {
  const action = useAction(done);
  return (
    <Dialog
      wide
      title={title}
      action={verb}
      busy={action.busy !== null}
      onCancel={cancel}
      onAction={(form) =>
        void action.run(
          "deploy",
          async () => {
            const made = await api<Deployed>("/deploy", {
              body: {
                token: String(form.get("token") ?? ""),
                name: String(form.get("name") ?? name),
                member: String(form.get("member") ?? me),
              },
            });
            return made.created
              ? `The team store is at ${made.url}, and you are its admin`
              : `Updated the team store at ${made.url}`;
          },
          "Deploying",
        )
      }
    >
      <p>
        In Cloudflare, under My Profile › API Tokens, create a token from the template{" "}
        <strong>Edit Cloudflare Workers</strong> for your account, and paste it here. Grenier keeps it on this machine,
        readable by you only, so the next update is one click; it never goes to the team store or a log.
      </p>
      <Problem error={action.problem} />
      <Field label="Cloudflare API token">
        <Input name="token" type="password" mono autoComplete="off" required />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Your name">
          <Input name="member" defaultValue={me} required />
        </Field>
        <Field label="Store name" help="Its name in Cloudflare.">
          <Input name="name" mono defaultValue={name} required pattern="[a-z0-9\-]+" />
        </Field>
      </div>
    </Dialog>
  );
}

export function Join({
  joined,
  me,
  creating,
  setCreating,
}: {
  joined: () => void;
  me: string;
  creating: boolean;
  setCreating: (open: boolean) => void;
}) {
  const [state, setState] = useState<Joining | null>(null);
  const action = useAction();
  const poll = useCallback(() => {
    api<Joining>("/join")
      .then((next) => {
        setState(next);
        if (next.state === "joined") joined();
      })
      .catch(() => {});
  }, [joined]);
  usePolling(poll, state?.state === "waiting" ? 2000 : null);

  return (
    <Page
      title="Team"
      intro="A team shares one store: what each person and their agents learn, its skills, MCP servers and routines. It lives in the team's own Cloudflare account."
    >
      <Problem error={action.problem ?? (state?.state === "failed" ? (state.error ?? "Joining failed.") : null)} />
      {state?.state === "waiting" ? (
        <>
          <Notice kind="accent" tag="WAITING" more="Waiting for the confirmation, up to 10 minutes.">
            Read this code to the admin who invited you. They confirm it on their screen.
          </Notice>
          <div className="max-w-80">
            <Stats columns={2}>
              <Stat label="Your code" value={spaced(state.code)} lit />
              <Stat label="Admin confirms" value="…" />
            </Stats>
          </div>
        </>
      ) : (
        <>
          <form
            className="flex max-w-(--layout-reading) items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const link = String(new FormData(event.currentTarget).get("link") ?? "");
              void action.run(
                "join",
                async () => {
                  setState(await api<Joining>("/join", { body: { link } }));
                  return undefined;
                },
                "Joining",
              );
            }}
          >
            <div className="flex-1">
              <Field label="Invite link">
                <Input name="link" mono placeholder="grenier://join/…" required autoComplete="off" spellCheck={false} />
              </Field>
            </div>
            <Primary type="submit" busy={action.busy !== null}>
              Join
            </Primary>
          </form>
          <Section
            heading
            title="Or start a team"
            description="Its store goes in your own Cloudflare account, and you become its admin."
            actions={
              <Button trailing={ArrowRight} onClick={() => setCreating(true)}>
                Create a team…
              </Button>
            }
          />
        </>
      )}
      {creating && (
        <Deploy
          name="grenier-team"
          me={me}
          title="Create a team"
          action="Create the team"
          done={joined}
          cancel={() => setCreating(false)}
        />
      )}
    </Page>
  );
}
