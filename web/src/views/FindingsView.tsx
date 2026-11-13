import { useState } from "react";
import {
  Badge, DrawerBody, DrawerHeader, DrawerHeaderTitle, Field, OverlayDrawer, Select, Table, TableBody, TableCell,
  TableHeader, TableHeaderCell, TableRow, Text, Button, makeStyles, tokens,
} from "@fluentui/react-components";
import type { FindingStatus } from "../../../src/store/types";
import { useFindings, type FindingView } from "../api";
import { GHOST_TYPES, TYPE_LABEL, numberRows, when } from "../format";
import { Await, Page } from "./common";
import { AuditList } from "./AuditView";

const useStyles = makeStyles({
  filters: { display: "flex", gap: tokens.spacingHorizontalL },
  row: { cursor: "pointer" },
  detail: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
});

export const STATUS_LABEL: Record<FindingStatus, string> = {
  open: "Open", actioned: "Actioned", dismissed: "Dismissed", superseded: "Superseded", resolved: "Resolved",
};

export const ownerText = (owner: string | null) => owner ?? "No owner";
const summary = (v: FindingView) =>
  numberRows(v.finding.numbers).map(([k, val]) => `${k}: ${val}`).join(" · ");

export function FindingDetail({ view, onClose }: { view: FindingView | null; onClose: () => void }) {
  const s = useStyles();
  const f = view?.finding;
  return (
    <OverlayDrawer open={!!view} position="end" size="medium" onOpenChange={(_, d) => !d.open && onClose()}>
      <DrawerHeader>
        <DrawerHeaderTitle action={<Button appearance="subtle" onClick={onClose}>Close</Button>}>
          {f ? f.subjectLabel ?? f.subjectId : ""}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        {view && f && (
          <div className={s.detail}>
            <Text>{TYPE_LABEL[f.type]} · {STATUS_LABEL[f.status]}</Text>
            <Text>Owner: {ownerText(f.owner)}</Text>
            <Text>Scan timestamp: {when(f.scanTimestamp)}</Text>
            <Text weight="semibold">Numbers</Text>
            {numberRows(f.numbers).map(([k, v]) => <Text key={k}>{k}: {v}</Text>)}
            <Text weight="semibold">Decision history</Text>
            {view.decision ? (
              <Text>
                {view.decision.action} by {view.decision.owner} on {when(view.decision.decidedAt)}
                {view.decision.acceptedUntil ? `; accepted until ${when(view.decision.acceptedUntil)}` : ""}
              </Text>
            ) : <Text>No decision recorded.</Text>}
            {view.audit.length > 0 && <AuditList entries={view.audit} />}
          </div>
        )}
      </DrawerBody>
    </OverlayDrawer>
  );
}

export function FindingsView() {
  const s = useStyles();
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const state = useFindings(type, status);
  return (
    <Page title="Findings" subtitle="Numbers are quoted as stored. Select a row for the full detail.">
      <div className={s.filters}>
        <Field label="Ghost type">
          <Select value={type} onChange={(_, d) => setType(d.value)}>
            <option value="">All types</option>
            {GHOST_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(_, d) => setStatus(d.value)}>
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABEL) as FindingStatus[]).map((v) => <option key={v} value={v}>{STATUS_LABEL[v]}</option>)}
          </Select>
        </Field>
      </div>
      <Await state={state}>
        {(d) => (
          <>
            <Text size={200}>{d.findings.length} findings</Text>
            <Table aria-label="Findings">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Subject</TableHeaderCell>
                  <TableHeaderCell>Owner</TableHeaderCell>
                  <TableHeaderCell>Numbers</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.findings.map((v) => (
                  <TableRow key={v.finding.id} className={s.row} tabIndex={0}
                    onClick={() => setOpen(v.finding.id)}
                    onKeyDown={(e) => e.key === "Enter" && setOpen(v.finding.id)}>
                    <TableCell>{TYPE_LABEL[v.finding.type]}</TableCell>
                    <TableCell>{v.finding.subjectLabel ?? v.finding.subjectId}</TableCell>
                    <TableCell>{ownerText(v.finding.owner)}</TableCell>
                    <TableCell>{summary(v) || "none recorded"}</TableCell>
                    <TableCell>
                      <Badge appearance="tint" color={v.finding.status === "open" ? "warning" : "informative"}>
                        {STATUS_LABEL[v.finding.status]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <FindingDetail view={d.findings.find((v) => v.finding.id === open) ?? null} onClose={() => setOpen(null)} />
          </>
        )}
      </Await>
    </Page>
  );
}
