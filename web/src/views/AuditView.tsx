import { Badge, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text } from "@fluentui/react-components";
import type { AuditEntry, AuditResult } from "../../../src/remediation/types";
import { useAudit } from "../api";
import { when } from "../format";
import { Await, Page } from "./common";

/** Failed and queued actions are never shown as fixed. */
const RESULT: Record<AuditResult, { label: string; color: "success" | "danger" | "warning" }> = {
  success: { label: "Succeeded", color: "success" },
  failure: { label: "Failed", color: "danger" },
  queued: { label: "Queued, not executed", color: "warning" },
};

export function AuditList({ entries }: { entries: AuditEntry[] }) {
  return (
    <Table aria-label="Audit entries">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Time</TableHeaderCell>
          <TableHeaderCell>Finding</TableHeaderCell>
          <TableHeaderCell>Action</TableHeaderCell>
          <TableHeaderCell>Target</TableHeaderCell>
          <TableHeaderCell>Approver</TableHeaderCell>
          <TableHeaderCell>Result</TableHeaderCell>
          <TableHeaderCell>Restore path</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((e) => (
          <TableRow key={e.id}>
            <TableCell>{when(e.timestamp)}</TableCell>
            <TableCell>{e.findingId}</TableCell>
            <TableCell>{e.action}</TableCell>
            <TableCell>{e.target}</TableCell>
            <TableCell>{e.owner ?? "unknown"}</TableCell>
            <TableCell>
              <Badge appearance="filled" color={RESULT[e.result].color}>{RESULT[e.result].label}</Badge>
              {e.error && <div><Text size={200}>{e.error}</Text></div>}
            </TableCell>
            <TableCell>{e.restorePath ?? "None"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function AuditView() {
  const state = useAudit();
  return (
    <Page title="Audit log" subtitle="One entry per remediation action, newest first.">
      <Await state={state}>
        {(d) => (d.entries.length === 0 ? <Text>No remediation actions recorded yet.</Text> : <AuditList entries={d.entries} />)}
      </Await>
    </Page>
  );
}
