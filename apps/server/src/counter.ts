import { DurableObject } from "cloudflare:workers";

export interface DaySpend {
  total: number;
  members: Record<string, number>;
}

/**
 * The team's spending today, one object per team, so concurrent requests from every member add up exactly. Days are
 * UTC dates; only the last 7 are kept.
 */
export class TeamCounter extends DurableObject {
  async add(day: string, memberId: string, cost: number): Promise<DaySpend> {
    const spend = (await this.ctx.storage.get<DaySpend>(day)) ?? { total: 0, members: {} };
    spend.total += cost;
    spend.members[memberId] = (spend.members[memberId] ?? 0) + cost;
    await this.ctx.storage.put(day, spend);
    const days = [...(await this.ctx.storage.list<DaySpend>()).keys()].sort();
    for (const old of days.slice(0, Math.max(0, days.length - 7))) await this.ctx.storage.delete(old);
    return spend;
  }

  async spent(day: string): Promise<DaySpend> {
    return (await this.ctx.storage.get<DaySpend>(day)) ?? { total: 0, members: {} };
  }
}
