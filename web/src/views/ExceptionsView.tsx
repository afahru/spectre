import { useState } from "react";
import {
  Button, MessageBar, MessageBarBody, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text,
} from "@fluentui/react-components";
import { decide, useExceptions } from "../api";
import { TYPE_LABEL, when } from "../format";
import { Await, Page } from "./common";

const ACTIONS = ["Keep", "Restrict", "Archive"] as const;

export function ExceptionsView() {
  const state = useExceptions();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(findingId: string, action: string) {
    setBusy(true);
    try {
      const { ok, body } = await decide(findingId, action);
      const dispatch = "error" in body ? null : body.dispatch;
      if ("error" in body) setNote({ ok: false, text: body.error });
      else if (dispatch?.status === "refused") setNote({ ok: false, text: `Recorded ${action}, but remediation refused: ${dispatch.reason}` });
      else if (dispatch && dispatch.entry.result !== "success") {
        setNote({ ok: false, text: `Recorded ${action}. The action did not complete (${dispatch.entry.result}); the finding stays open.` });
      } else setNote({ ok, text: `Recorded ${action}.` });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      state.reload();
    }
  }

  return (
    <Page title="Exceptions queue" subtitle="Findings no owner could answer. Decide here, with the same three choices the owner had.">
      {note && <MessageBar intent={note.ok ? "success" : "error"}><MessageBarBody>{note.text}</MessageBarBody></MessageBar>}
      <Await state={state}>
        {(d) => (d.exceptions.length === 0 ? <Text>The queue is empty.</Text> : (
          <Table aria-label="Exceptions queue">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Subject</TableHeaderCell>
                <TableHeaderCell>Why it is queued</TableHeaderCell>
                <TableHeaderCell>Decision</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.exceptions.map((e) => (
                <TableRow key={e.finding.id}>
                  <TableCell>{TYPE_LABEL[e.finding.type]}</TableCell>
                  <TableCell>{e.finding.subjectLabel ?? e.finding.subjectId}</TableCell>
                  <TableCell>
                    {e.reason}
                    {e.error && <div><Text size={200}>{e.error}</Text></div>}
                  </TableCell>
                  <TableCell>
                    {e.decision ? (
                      <Text>{e.decision.action} by {e.decision.owner} on {when(e.decision.decidedAt)}</Text>
                    ) : ACTIONS.map((a) => (
                      <Button key={a} size="small" style={{ marginInlineEnd: 4 }} disabled={busy || !e.allowedActions.includes(a)}
                        title={e.allowedActions.includes(a) ? undefined : `${a} is not available for ${TYPE_LABEL[e.finding.type]}`}
                        onClick={() => act(e.finding.id, a)}>
                        {a}
                      </Button>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
      </Await>
    </Page>
  );
}
