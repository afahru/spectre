import { useState } from "react";
import { Tab, TabList, Text, makeStyles, tokens } from "@fluentui/react-components";
import { Ghost } from "./Ghost";
import { ScoreView } from "./views/ScoreView";
import { FindingsView } from "./views/FindingsView";
import { ExceptionsView } from "./views/ExceptionsView";
import { AuditView } from "./views/AuditView";

const useStyles = makeStyles({
  shell: { display: "grid", gridTemplateRows: "48px 1fr", height: "100vh", backgroundColor: tokens.colorNeutralBackground2 },
  header: {
    display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, paddingInline: tokens.spacingHorizontalL,
    backgroundColor: tokens.colorNeutralBackground1, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  body: { display: "grid", gridTemplateColumns: "220px 1fr", minHeight: 0 },
  nav: {
    backgroundColor: tokens.colorNeutralBackground1, borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingBlock: tokens.spacingVerticalM, paddingInline: tokens.spacingHorizontalS,
  },
  main: { overflow: "auto", padding: tokens.spacingHorizontalXXL },
});

const PAGES = {
  score: { label: "Readiness score", view: <ScoreView /> },
  findings: { label: "Findings", view: <FindingsView /> },
  exceptions: { label: "Exceptions queue", view: <ExceptionsView /> },
  audit: { label: "Audit log", view: <AuditView /> },
};
type PageId = keyof typeof PAGES;

export function App() {
  const s = useStyles();
  const [page, setPage] = useState<PageId>("score");
  return (
    <div className={s.shell}>
      <header className={s.header}>
        <Ghost size={24} />
        <Text weight="semibold" size={400}>Spectre</Text>
        <Text size={300} style={{ color: tokens.colorNeutralForeground3 }}>Admin console</Text>
      </header>
      <div className={s.body}>
        <nav className={s.nav} aria-label="Main">
          <TabList vertical selectedValue={page} onTabSelect={(_, d) => setPage(d.value as PageId)}>
            {(Object.keys(PAGES) as PageId[]).map((id) => (
              <Tab key={id} value={id}>{PAGES[id].label}</Tab>
            ))}
          </TabList>
        </nav>
        <main className={s.main}>{PAGES[page].view}</main>
      </div>
    </div>
  );
}
