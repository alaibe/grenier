import { setTimeout as sleep } from "node:timers/promises";
import type {
  Deployed,
  Invite,
  InviteMade,
  Joining,
  Machine,
  MadeLink,
  Member,
  Overview,
  Synced,
  TeamMe,
  TeamUsage,
} from "@grenier/core/api";
import { inviteLink } from "@grenier/core/team";
import { Refusal, UsageError } from "../io.ts";
import { type Admin, type Group, pick, q, table, textFrom, when } from "./client.ts";

const dollars = (cost: number) => `$${cost.toFixed(2)}`;

const teamUrl = async (admin: Admin) => {
  const { team } = await admin<Overview>("GET", "/overview");
  if (!team) throw new Refusal("this machine is in no team: grenier team join <link>, or grenier team deploy");
  return team.url;
};

const spaced = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

export const TEAM: Group = {
  summary: "The team: its members, their machines and invites, and the sync with its store.",
  commands: {
    show: {
      usage: "show",
      summary: "Who you are in the team, on which machine",
      call: async ({ admin }) => ({ url: await teamUrl(admin), ...(await admin<TeamMe>("GET", "/team/me")) }),
      show: (me: TeamMe & { url: string }) =>
        table([
          ["team", me.url],
          ["member", `${me.name}, ${me.role}`],
          ["machine", me.device],
        ]),
    },
    join: {
      usage: "join <invite link>",
      summary: "Join a team from the link an admin made, then wait for them to confirm",
      takes: [1, 1],
      call: async ({ admin, args, io }) => {
        let state = await admin<Joining>("POST", "/join", { link: args[0] });
        io.err(`Read this code to your admin, who confirms it: ${spaced(state.code ?? "")}`);
        while (state.state === "waiting") {
          await sleep(2000);
          state = await admin<Joining>("GET", "/join");
        }
        if (state.state === "failed") throw new Refusal(state.error ?? "joining failed");
        return state;
      },
      show: (state: Joining) => `Joined ${state.url} as ${state.member}`,
    },
    deploy: {
      usage: "deploy --member <your name> [--name <worker>]",
      summary: "Start a team store on Cloudflare, or update yours; the token comes from $CLOUDFLARE_API_TOKEN or stdin",
      options: { member: { type: "string" }, name: { type: "string" } },
      call: ({ admin, flags, io }) => {
        const token = io.env.CLOUDFLARE_API_TOKEN ?? textFrom("-").trim();
        return admin<Deployed>("POST", "/deploy", {
          token,
          member: flags.member ?? "",
          name: flags.name ?? "grenier-team",
        });
      },
      show: (deployed: Deployed) =>
        deployed.created ? `Started ${deployed.url}: you are its first admin` : `Updated ${deployed.url}`,
    },
    sync: {
      usage: "sync",
      summary: "Sync with the team store now",
      call: ({ admin }) => admin<Synced>("POST", "/sync"),
      show: (synced: Synced) =>
        [
          `Sent ${synced.pushed}, took ${synced.pulled}`,
          ...synced.refused.map((entry) => `refused ${entry.recordId}: ${entry.reason}`),
          ...(synced.unopened > 0 ? [`${synced.unopened} Me pages need your key: grenier key set`] : []),
        ].join("\n"),
    },
    members: {
      usage: "members",
      summary: "List the members and their machines",
      call: async ({ admin }) => (await admin<{ members: Member[] }>("GET", "/team/members")).members,
      show: (members: Member[]) =>
        table(
          members.map((member) => [
            member.name,
            member.role,
            member.devices.map((device) => `${device.name} (${device.state})`).join(", "),
          ]),
        ),
    },
    invite: {
      usage: "invite <name> [--role member|admin]",
      summary: "Make an invite link for a new member, or a new machine of one (admins)",
      options: { role: { type: "string" } },
      takes: [1, 1],
      call: async ({ admin, args, flags }) => {
        const url = await teamUrl(admin);
        const made = await admin<InviteMade>("POST", "/team/invites", { name: args[0], role: flags.role ?? "member" });
        return { ...made, link: inviteLink(url, made.id, made.secret) };
      },
      show: (made: InviteMade & { link: string }) =>
        `Send ${made.member} this link, then confirm the code they read you with grenier team confirm:\n${made.link}`,
    },
    invites: {
      usage: "invites",
      summary: "List the open invites, with the code of each machine waiting (admins)",
      call: async ({ admin }) => (await admin<{ invites: Invite[] }>("GET", "/team/invites")).invites,
      show: (invites: Invite[]) =>
        table(
          invites.map((invite) => [
            invite.member,
            invite.role,
            invite.code ? `${invite.device} waits, code ${spaced(invite.code)}` : `until ${when(invite.expiresAt)}`,
          ]),
        ) || "no open invites",
    },
    confirm: {
      usage: "confirm <code>",
      summary: "Let in the machine that read you this code (admins)",
      takes: [1, 2],
      call: ({ admin, args }) => admin("POST", "/team/invites/confirm", { code: args.join("") }),
      show: () => "Confirmed: the machine is in the team",
    },
    role: {
      usage: "role <member> member|admin",
      summary: "Make a member an admin, or not (admins)",
      takes: [2, 2],
      call: async ({ admin, args }) => {
        if (args[1] !== "admin" && args[1] !== "member") throw new UsageError("a role is admin or member");
        await admin("PUT", `/team/members/${q(args[0] as string)}/role`, { role: args[1] });
        return { member: args[0], role: args[1] };
      },
      show: (answer: { member: string; role: string }) =>
        `${answer.member} is ${answer.role === "admin" ? "an admin" : "a member"} now`,
    },
    remove: {
      usage: "remove <member>",
      summary: "Remove a member and their machines from the team (admins)",
      takes: [1, 1],
      call: ({ admin, args }) => admin("DELETE", `/team/members/${q(args[0] as string)}`),
      show: () => "Removed",
    },
    machines: {
      usage: "machines",
      summary: "List the team's machines",
      call: async ({ admin }) => (await admin<{ machines: Machine[] }>("GET", "/team/machines")).machines,
      show: (machines: Machine[]) =>
        table(
          machines.map((machine) => [
            machine.id,
            machine.name,
            machine.member,
            machine.state,
            `seen ${when(machine.lastSeen)}`,
            `${machine.runs} runs`,
          ]),
        ),
    },
    forget: {
      usage: "forget <machine>",
      summary: "Take a machine out of the team: its key stops working",
      takes: [1, 1],
      call: async ({ admin, args }) => {
        const machines = (await admin<{ machines: Machine[] }>("GET", "/team/machines")).machines;
        const machine = pick(machines, args[0] as string, "machine", (entry) => entry.name);
        await admin("DELETE", `/team/devices/${q(machine.id)}`);
        return { forgotten: machine.name };
      },
      show: (answer: { forgotten: string }) => `${answer.forgotten} is out of the team`,
    },
    usage: {
      usage: "usage",
      summary: "What the team spent, per day, project, member and machine",
      call: async ({ admin }) => (await admin<{ usage: TeamUsage[] }>("GET", "/team/usage")).usage,
      show: (usage: TeamUsage[]) =>
        table(usage.map((row) => [row.day, dollars(row.cost), row.member, row.machine, row.repo])) || "no usage yet",
    },
    weblink: {
      usage: "weblink",
      summary: "Make a link to read the team's pages in a browser",
      call: async ({ admin }) => {
        const url = await teamUrl(admin);
        return { link: `${url}${(await admin<MadeLink>("POST", "/team/weblinks")).path}` };
      },
      show: (answer: { link: string }) => answer.link,
    },
  },
};
