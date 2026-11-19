export {
  type AskResult,
  askCodebase,
  type CacheDeps,
  CacheError,
  checkSummary,
  fileSummary,
  type Repo,
  type RepoFiles,
  type RepoMapEntry,
  recordAnswer,
  recordSummary,
  repoMap,
  SIMILAR,
  terms,
} from "./cache.ts";
export { addClient, newClientToken, readerFor, resolveScopes, scopeNames } from "./clients.ts";
export { cosine, type Embedder, readSafetensors, StaticEmbedder } from "./embeddings.ts";
export {
  approveMemory,
  getItem,
  inScope,
  itemRef,
  type PersonalDeps,
  people,
  type Reader,
  type ReadResult,
  type ReturnedItem,
  remember,
  SCOPE_KINDS,
  searchItems,
  timeline,
} from "./personal.ts";
export {
  forgetAnswer,
  type SyncDeps,
  type SyncResult,
  syncOnce,
  type TeamBudget,
  type TeamClient,
  TeamError,
  teamApi,
} from "./sync.ts";
export { type VaultSnapshot, vaultPull, vaultPush } from "./vault.ts";
