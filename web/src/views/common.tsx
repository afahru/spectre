import { MessageBar, MessageBarBody, MessageBarTitle, Spinner, Text, Title2 } from "@fluentui/react-components";
import type { ReactNode } from "react";
import type { Loaded } from "../api";

export function Page({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <Title2 as="h1">{title}</Title2>
        {subtitle && <div><Text size={300}>{subtitle}</Text></div>}
      </div>
      {children}
    </section>
  );
}

/** Shows an error state instead of stale numbers when the service is down. */
export function Await<T>({ state, children }: { state: Loaded<T>; children: (data: T) => ReactNode }) {
  if (state.error) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>The Spectre service is not reachable</MessageBarTitle>
          {state.error}. No figures are shown until it responds.
        </MessageBarBody>
      </MessageBar>
    );
  }
  if (!state.data) return <Spinner label="Loading" />;
  return <>{children(state.data)}</>;
}
