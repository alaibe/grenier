import init from "../migrations/0000_init.sql";
import recordsFts from "../migrations/0001_records_fts.sql";
import noTraces from "../migrations/0002_no_traces.sql";
import folders from "../migrations/0003_folders.sql";
import tops from "../migrations/0004_tops.sql";
import simpler from "../migrations/0005_simpler.sql";
import noMemberFolders from "../migrations/0006_no_member_folders.sql";
import toolUses from "../migrations/0007_tool_uses.sql";
import noRecordKind from "../migrations/0008_no_record_kind.sql";
import meAndTeam from "../migrations/0009_me_and_team.sql";

export interface Migration {
  /** 1 for the first migration: the schema version a database has once it is applied. */
  version: number;
  name: string;
  sql: string;
}

/** In the order of migrations/meta/_journal.json; a shipped migration never changes. */
export const migrations: readonly Migration[] = [
  { version: 1, name: "0000_init", sql: init },
  { version: 2, name: "0001_records_fts", sql: recordsFts },
  { version: 3, name: "0002_no_traces", sql: noTraces },
  { version: 4, name: "0003_folders", sql: folders },
  { version: 5, name: "0004_tops", sql: tops },
  { version: 6, name: "0005_simpler", sql: simpler },
  { version: 7, name: "0006_no_member_folders", sql: noMemberFolders },
  { version: 8, name: "0007_tool_uses", sql: toolUses },
  { version: 9, name: "0008_no_record_kind", sql: noRecordKind },
  { version: 10, name: "0009_me_and_team", sql: meAndTeam },
];
