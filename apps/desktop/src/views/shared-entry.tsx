import type { SharedState } from "@grenier/core/api";
import { Check, Download, type LucideIcon, Trash2, Undo2 } from "lucide-react";
import { type ReactNode, useCallback } from "react";
import { api } from "../api.ts";
import { installTag } from "../states.ts";
import { Button, Primary } from "../ui/button.tsx";
import { Dialog, type useConfirm } from "../ui/dialog.tsx";
import { Field, Input } from "../ui/field.tsx";
import { type useAction, useLoad } from "../ui/load.ts";
import type { MenuItem } from "../ui/menu.tsx";
import { Notice, Problem } from "../ui/notice.tsx";
import { Status } from "../ui/tag.tsx";
import type { TreeNode } from "../ui/tree.tsx";

/** The team's skills or servers and how this machine stands with each; none outside a team. */
export function useShared(type: SharedState["type"], inTeam: boolean) {
  const load = useCallback(
    () =>
      inTeam
        ? api<{ shared: SharedState[] }>("/installs").then((answer) =>
            answer.shared.filter((entry) => entry.type === type),
          )
        : Promise.resolve([]),
    [type, inTeam],
  );
  return useLoad(load);
}

/** The Team group of a list: its entries, each with whether it is installed here; an admin's adds beside it. */
export function teamGroup(entries: SharedState[], icon: LucideIcon, actions: ReactNode | undefined): TreeNode {
  return {
    id: "team/",
    name: "Team",
    group: true,
    meta: "shared",
    ...(actions ? { actions } : {}),
    children: entries.map((entry) => ({
      id: `team:${entry.id}`,
      name: entry.title,
      icon,
      meta: <Status {...installTag(entry.state)} />,
    })),
  };
}

/**
 * What a team skill's or server's page offers this machine: install it or approve its update, uninstall it, roll it
 * back, and, for an admin, remove it from the team. `askKeys` asks for the keys a server needs before it installs.
 */
export function sharedEntryParts({
  entry,
  admin,
  action,
  ask,
  removed,
  primary,
  askKeys,
}: {
  entry: SharedState;
  admin: boolean;
  action: ReturnType<typeof useAction>;
  ask: ReturnType<typeof useConfirm>["ask"];
  /** After an admin removed it from the team. */
  removed: () => void;
  /** Install is the page's Primary; not when the page's own Save is. */
  primary: boolean;
  askKeys?: () => void;
}) {
  const install = (keys?: Record<string, string>) =>
    void action.run("install", async () => {
      await api(`/installs/${entry.id}`, { body: keys ? { keys } : {} });
      return `${entry.state === "update" ? "Approved the update of" : "Installed"} ${entry.title}: restart your agents to load it`;
    });
  const uninstall = () =>
    void action.run("remove", async () => {
      await api(`/installs/${entry.id}`, { method: "DELETE" });
      const text = `Uninstalled ${entry.title} from this machine`;
      // A server's keys went with it: installing it again asks for them.
      return entry.credentials.length === 0 ? { text, undo: () => install() } : text;
    });
  const items: MenuItem[] = [
    ...(entry.canRollBack
      ? [
          {
            label: "Roll back",
            icon: Undo2,
            run: () =>
              void action.run("rollback", async () => {
                await api(`/installs/${entry.id}/rollback`, { method: "POST" });
                return `Rolled ${entry.title} back to the version before`;
              }),
          },
        ]
      : []),
    ...(admin
      ? [
          {
            label: "Remove from the team",
            icon: Trash2,
            danger: true,
            run: () =>
              ask({
                title: `Remove ${entry.title} from the team?`,
                body: "It leaves every teammate's list, and each machine that installed it uninstalls it at its next sync. Its history stays.",
                action: "Remove from the team",
                run: () =>
                  void action.run("retire", async () => {
                    await api(`/records/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
                    removed();
                    return `Removed ${entry.title} from the team`;
                  }),
              }),
          },
        ]
      : []),
  ];
  const Install = primary ? Primary : Button;
  const needsKeys = entry.state === "available" && entry.credentials.length > 0 && askKeys;
  const buttons = (
    <>
      {entry.state !== "installed" && (
        <Install
          size="sm"
          icon={entry.state === "update" ? Check : Download}
          busy={action.busy === "install"}
          onClick={() => (needsKeys ? askKeys() : install())}
        >
          {entry.state === "update" ? "Approve the update" : "Install"}
        </Install>
      )}
      {entry.state !== "available" && (
        <Button size="sm" icon={Trash2} busy={action.busy === "remove"} onClick={uninstall}>
          Uninstall
        </Button>
      )}
    </>
  );
  const notice = entry.state === "update" && (
    <Notice kind="warn">Changed since you installed it: nothing changes here until you approve the update.</Notice>
  );
  return { install, buttons, items, notice };
}

/** Asks for the keys a server needs, one password field each; they go only into this person's agents' configs. */
export function KeysDialog({
  title,
  action,
  names,
  busy,
  problem,
  onCancel,
  onKeys,
}: {
  title: string;
  action: string;
  names: string[];
  busy: boolean;
  problem: string | null;
  onCancel: () => void;
  onKeys: (keys: Record<string, string>) => void;
}) {
  return (
    <Dialog
      title={title}
      action={action}
      busy={busy}
      onCancel={onCancel}
      onAction={(form) => onKeys(Object.fromEntries(names.map((name) => [name, String(form.get(name) ?? "")])))}
    >
      <p>Your keys go only into its entry in your own agents' configs: never to the team, a log or a store.</p>
      <Problem error={problem} />
      {names.map((name) => (
        <Field key={name} label={name}>
          <Input name={name} type="password" mono required autoComplete="off" />
        </Field>
      ))}
    </Dialog>
  );
}
