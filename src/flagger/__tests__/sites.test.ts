/**
 * flagger/__tests__/sites.test.ts
 *
 * Unit tests for flagOrphanedSites. Only a group-connected site whose group
 * has zero owners (ownerStatus 'orphaned') may be flagged.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SiteRecord } from "../../collector/types.js";
import { flagOrphanedSites } from "../sites.js";

function site(
  id: string,
  owner: string | null,
  ownerStatus: SiteRecord["ownerStatus"]
): SiteRecord {
  return {
    id,
    displayName: id,
    webUrl: null,
    createdDateTime: null,
    lastModifiedDateTime: null,
    owner,
    ownerStatus,
    sharingCapability: null,
    storageUsedBytes: null,
  };
}

describe("flagOrphanedSites", () => {
  it("flags a group-connected site whose group has no owners", () => {
    const result = flagOrphanedSites([site("group-no-owners", null, "orphaned")]);
    assert.equal(result.length, 1);
    assert.equal(result[0].siteId, "group-no-owners");
    assert.equal(result[0].type, "orphaned-site");
    assert.equal(result[0].owner, null);
  });

  it("does not flag a communication site with no drive", () => {
    assert.deepEqual(flagOrphanedSites([site("comm-site", null, "not-applicable")]), []);
  });

  it("does not flag a drive without a backing group", () => {
    assert.deepEqual(flagOrphanedSites([site("personal-drive", null, "not-applicable")]), []);
  });

  it("does not flag a site whose enrichment failed or never ran", () => {
    assert.deepEqual(flagOrphanedSites([site("unknown-site", null, "unknown")]), []);
  });

  it("does not flag an owned site", () => {
    assert.deepEqual(flagOrphanedSites([site("owned", "a@contoso.com", "owned")]), []);
  });

  it("flags only the orphaned sites in a mixed list", () => {
    const result = flagOrphanedSites([
      site("or1", null, "orphaned"),
      site("comm", null, "not-applicable"),
      site("ok", "a@contoso.com", "owned"),
      site("or2", null, "orphaned"),
      site("err", null, "unknown"),
    ]);
    assert.deepEqual(result.map((c) => c.siteId), ["or1", "or2"]);
  });
});
