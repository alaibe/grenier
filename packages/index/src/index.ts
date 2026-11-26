export { addClient, readerFor, resolveScopes } from "./clients.ts";
export { cosine, type Embedder, readSafetensors, StaticEmbedder } from "./embeddings.ts";
export {
  type Checked,
  check,
  deliver,
  type Found,
  type QueryResult,
  query,
  type RecallResult,
  recall,
  type Status,
} from "./reads.ts";
export {
  ensureRepoTop,
  type Identity,
  newId,
  newRecord,
  type Reader,
  type Repo,
  type RepoFiles,
  readable,
  resolveFolderPath,
  type StoreDeps,
  StoreUseError,
  typeOf,
} from "./records.ts";
export {
  rekeyed,
  type SyncDeps,
  type SyncResult,
  syncOnce,
  type TeamClient,
  TeamError,
  teamApi,
  teamChange,
  unopenedCount,
} from "./sync.ts";
export {
  changedFields,
  embedding,
  type RememberInput,
  refusal,
  remember,
  retire,
  write,
} from "./writes.ts";
