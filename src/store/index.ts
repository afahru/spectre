/**
 * store/index.ts
 *
 * Re-exports the store interface and the default SQLite implementation.
 * Import from here, not from the individual files, so the import path is
 * stable if the layout changes.
 */

export type { FindingStore } from "./FindingStore.js";
export type { Finding, FindingNumbers, FindingStatus, GhostType, NewFinding } from "./types.js";
export { supersedePreviousFindings } from "./supersede.js";
export { SqliteFindingStore } from "./SqliteFindingStore.js";
