import {
  Card, CardHeader, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, tokens,
} from "@fluentui/react-components";
import type { ScorerResult } from "../../../src/scorer/types";
import { useScore } from "../api";
import { TYPE_LABEL, UNKNOWN, usd, when } from "../format";
import { Await, Page } from "./common";

const useStyles = makeStyles({
  pair: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: tokens.spacingHorizontalL },
  hero: { display: "flex", alignItems: "baseline", gap: tokens.spacingHorizontalXS },
  cost: { display: "flex", gap: tokens.spacingHorizontalL, flexWrap: "wrap" },
  costCard: { minWidth: "220px" },
});

function ScoreCard({ title, caption, result }: { title: string; caption: string; result: ScorerResult | null }) {
  const s = useStyles();
  return (
    <Card>
      <CardHeader header={<Text weight="semibold">{title}</Text>} description={<Text size={200}>{caption}</Text>} />
      <div className={s.hero}>
        <Text size={1000} weight="semibold" style={{ fontSize: 56, lineHeight: 1 }}>{result ? result.score : UNKNOWN}</Text>
        {result && <Text size={500}>/ 100</Text>}
      </div>
      {result && (
        <>
          <Table size="small" aria-label={`${title} inputs`}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Ghost type</TableHeaderCell>
                <TableHeaderCell>Count</TableHeaderCell>
                <TableHeaderCell>Weight</TableHeaderCell>
                <TableHeaderCell>Penalty</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.inputs.breakdown.map((b) => (
                <TableRow key={b.type}>
                  <TableCell>{TYPE_LABEL[b.type]}</TableCell>
                  <TableCell>{b.count}</TableCell>
                  <TableCell>{b.weight}</TableCell>
                  <TableCell>{b.penalty}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Text size={200}>
            Total penalty {result.inputs.totalPenalty} of {result.inputs.maxPenalty}; the score reaches 0 at the maximum.
          </Text>
        </>
      )}
    </Card>
  );
}

export function ScoreView() {
  const s = useStyles();
  const state = useScore();
  return (
    <Page title="Copilot readiness" subtitle="Computed by the scorer from the latest scan. Open findings only.">
      <Await state={state}>
        {(d) => (
          <>
            <Text size={200}>Latest scan: {when(d.scanTimestamp)}</Text>
            <div className={s.pair}>
              <ScoreCard title="Tenant-wide score" caption="All open findings in the latest scan" result={d.tenant} />
              <ScoreCard title="Fixture score" caption="Spectre fixture objects only (the verifier's scope)" result={d.fixture} />
            </div>
            <Text weight="semibold">Monthly cost rollup (tenant-wide)</Text>
            <div className={s.cost}>
              <Card className={s.costCard}>
                <Text size={200}>Idle licences</Text>
                <Text size={700} weight="semibold">{usd(d.cost?.idleLicencesUsd)}</Text>
              </Card>
              <Card className={s.costCard}>
                <Text size={200}>Cold storage overage</Text>
                <Text size={700} weight="semibold">{usd(d.cost?.coldStorageUsd)}</Text>
              </Card>
            </div>
            <Text size={200}>"unknown" means a price is not on file for at least one finding. It is never counted as zero.</Text>
          </>
        )}
      </Await>
    </Page>
  );
}
