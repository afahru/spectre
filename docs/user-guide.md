# Spectre User Guide

This guide is for the two people who use Spectre: the **tenant admin**, who runs it and sees the console, and the **site owner**, who receives a card in Teams and makes a decision. It is written in plain English, the same language the product uses. No technical background is needed to follow it.

## 1. What Spectre does

Spectre looks for the five exposures in your Microsoft 365 tenant that block a safe Copilot rollout, and it asks the person responsible for each one what to do about it. It does not dump a report on the admin and stop. It messages the owner, the owner taps one button, and the approved fix happens, with a record of who approved it and what was done.

The flow is:

1. Spectre scans the tenant once a day.
2. For each exposure it finds, it sends the owner one card in Teams.
3. The owner taps Keep, Restrict, or Archive.
4. Spectre records the decision and, for Restrict and Archive, carries out the approved fix.
5. The admin sees the readiness score, every open exposure, the items nobody could answer, and a log of every fix, in the admin console.

This works in practice, not only in design. On the demo tenant, one owner action moved the readiness score from 73 to 76, and the link removal and guest removal behind that move were verified live against Microsoft Graph. The score moves because real exposures are really gone, not because a report was filed.

## 2. The five ghosts

Spectre calls each exposure type a ghost. The five are:

| Ghost | What it means | Why it matters |
|---|---|---|
| **Overshared site** | A site can be opened by anyone with the link, even people outside your company. No sign-in is needed. | Anyone who gets the link can read the content. Copilot can surface it too. |
| **Orphaned site** | A site has no owner. Nobody is responsible for what happens to it. | No one decides who can see it, and no one cleans it up. |
| **Stale guest** | A guest user still has access but has not signed in for 90 days or more, or has never signed in. | Dormant external access that nobody is watching. |
| **Idle licence** | A licence is assigned to someone who has not used Microsoft 365 in 90 days. | You are paying for a licence nobody uses. The card states the monthly cost when it is known. |
| **Cold storage** | A site has not been changed in a year or more. | Old content keeps costing storage. Archiving it stops the cost. |

Three of these definitions are Spectre's own choices, not Microsoft rules. Heuristic: "stale guest" has no fixed Microsoft definition; Microsoft's closest concept is the inactive-guest report, whose 90-day threshold is the configurable default, and guests who never signed in are measured from their creation date. Heuristic: Microsoft publishes no unused-licence threshold, so Spectre flags 90 days of no activity. Heuristic: Microsoft leaves the inactivity period to the admin's inactive-site policy, so Spectre uses one year. ([Microsoft Learn: stale guests](https://learn.microsoft.com/en-us/entra/identity/users/clean-up-stale-guest-accounts), [activity reports](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/active-users-ww), [inactive-site policies](https://learn.microsoft.com/en-us/sharepoint/inactive-site-policy)) Anyone links need no sign-in and can be passed on; Microsoft documents the four sharing levels and the Anyone-link controls here: [Microsoft Learn](https://learn.microsoft.com/en-us/sharepoint/turn-external-sharing-on-or-off).

The admin console shows one score from 0 to 100 for the whole tenant: 100 means no open exposures, 0 means the tenant is severely exposed. The score is computed from the counts and a fixed weight per ghost type, and the console shows the counts and weights beside the score so you can see why the tenant scores what it scores. Unknown costs are shown as "unknown", never as zero and never as a guess. Heuristic: the 0 to 100 score is Spectre's own design. Microsoft publishes no Copilot readiness score; its readiness report shows counts only, such as eligible users and assigned licences. ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-readiness))

## 3. The card: what you receive

If you own a site, a guest, or a licence that Spectre flagged, you receive one card in Teams from Spectre. The card says, in one sentence, what is exposed and who can see it. Under that, it explains the three choices in plain words. It has exactly three buttons.

An overshared site card reads like this:

> The site "Marketing Plans" can be opened by anyone with the link, even people outside your company. No sign-in is needed.
>
> Keep: leave it as it is. Restrict: remove the public link so only your team can open it. Archive: archive this site, it is no longer used.

The buttons are labelled **Keep it shared**, **Remove the public link**, and **Archive this site**.

A few things to know about the card:

- You receive at most **two messages** about one exposure: the first card and, if you do not answer in 7 days, one reminder. You are never messaged a third time about the same item. If you still do not answer 7 days after the reminder, the item goes to your admin to decide.
- The card shows only the exposure and the choice. The full detail lives in the admin console, not on the card.
- Every number on the card comes from the tenant data. If Spectre could not confirm a figure, the card says so instead of guessing.
- The card never claims a legal or compliance verdict. It states the exposure and asks for your decision.

## 4. The three buttons: what each one does

### 4.1 Keep it shared (Keep)

Choose this when the sharing is intentional and should stay as it is.

What happens: the finding is closed as accepted risk. Spectre will not ask you about this item again for **30 days**. After 30 days, if the exposure still exists on the next scan, Spectre may ask again. Nothing is changed, nothing is deleted, and no one else is affected.

### 4.2 Remove the public link (Restrict)

Choose this when the content should not be open to anyone with the link.

What happens: Spectre removes the anonymous sharing link, so the content can no longer be opened by anyone with the link. People who already had access through the team or the site keep their access; only the public link is removed. The finding is marked fixed and the action is written to the audit log with your name, the time, and the link that was removed.

Important: **removing a public link cannot be undone.** The link is gone and must be recreated by the owner if it is needed again. Spectre does not recreate links. Choose Restrict only when you are sure the public link should go.

### 4.3 Archive this site (Archive)

Choose this when the site is no longer used and should be archived.

What happens: the site is archived through the SharePoint admin surface. Archiving is reversible: an archived site can be reactivated from the SharePoint admin center. Archived content is not used to train Copilot, and files that are reactivated cannot be archived again for 120 days. ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/archive/archive-overview?view=o365-worldwide)) The finding is marked fixed and the action is written to the audit log with your name, the time, and the site that was archived.

Note: in the current build, archiving needs a delegated admin session, because the service cannot archive a site with its own credentials. If no delegated session is available, your Archive decision is recorded and queued for the admin with the exact command to run. The finding stays open until the admin runs it. You will not be asked again about the same item while it is queued.

## 5. After you tap

- Teams shows "Your response was sent to the app". The button becomes disabled so the same card cannot be tapped twice.
- Your decision is recorded once. Tapping again, or tapping a second card for the same item, returns the decision already on record; it does not create a second one.
- For Keep, nothing else happens. For Restrict and Archive, Spectre carries out the fix and records it. If the fix fails, the finding stays open, the error is recorded, and your admin is notified through the exceptions queue. A failed fix is never shown as fixed.
- If you tap a button on a card for an item that has no owner recorded, the tap is ignored and the item stays open. This is a safety rule: a decision must belong to a recorded owner. Tell your admin, who can set the owner and send a fresh card.

## 6. The admin console: what the admin sees

The admin console is the one screen where the tenant admin sees everything. It has four views:

- **Score.** The live readiness score from 0 to 100, with the ghost counts and weights beside it, and the cost rollup (idle licences and cold storage). Two scores are shown side by side and labelled: the tenant-wide score, computed over all open findings, and the fixture score, computed over the demo fixture objects only. They are different numbers by design; do not confuse them.
- **Findings.** Every open finding in one list, with its type, owner, numbers, and status. The admin can filter by ghost type and by status, and open a row to see the full detail: numbers, owner, scan timestamp, and decision history.
- **Exceptions.** The items no owner could answer, each with the reason it is there: `ownerless` (no owner on record), `owner unreachable` (the bot has no conversation with the owner), or `no response` (the owner did not answer the card and the reminder). The admin decides these with the same three actions the owner would have had. For orphaned sites and idle licences, only Keep is offered, because no remediation action is mapped for those types.
- **Audit.** One row per remediation action: finding, action, target, approver, timestamp, result, and restore path where one exists. A failed action is shown as failed with the error attached; it is never shown as fixed.

The console is read-only except for the decide action on queued findings. It never calls Microsoft Graph directly and it never executes a fix except through a recorded approval and the remediation dispatcher.

## 7. Frequently asked questions

**Why did I get this card?**
Because you are recorded as the owner of the site, guest, or licence in the finding, and Spectre found an exposure on it. If you are not the owner, tell your admin; do not tap a button for an item that is not yours, because the decision is recorded under the owner on the finding.

**What if I do nothing?**
You get one reminder after 7 days. If you still do not answer 7 days after the reminder, the item goes to your admin to decide. Nothing is changed without a decision.

**Can I change my answer?**
No. A decision is recorded once per finding and cannot be overwritten from the card. If you tapped the wrong button, tell your admin, who can see the recorded decision in the console and advise on the next step.

**Does Keep mean the exposure is safe?**
No. Keep means you accept the exposure as it is, for 30 days. It does not make the content safer; it records that you decided the sharing is intentional.

**Who sees my decision?**
Your admin sees it in the console, attached to the finding, with your name and the time. Restrict and Archive decisions also appear in the audit log with the action that was carried out.

**Is my data shared outside the company?**
No. Spectre runs in your tenant, reads your tenant through Microsoft Graph, and messages you in Teams. It does not send tenant data anywhere else.

## 8. References

Microsoft Learn links first. All links below appear in the research report of 13 November 2026; pages marked (live) were opened live that day.

- Microsoft Learn (live): Monitor and clean up stale guest accounts: https://learn.microsoft.com/en-us/entra/identity/users/clean-up-stale-guest-accounts
- Microsoft Learn (live): Microsoft 365 admin centre active users report: https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/active-users-ww
- Microsoft Learn (live): Inactive site policies: https://learn.microsoft.com/en-us/sharepoint/inactive-site-policy
- Microsoft Learn (live): Turn external sharing on or off (Anyone links): https://learn.microsoft.com/en-us/sharepoint/turn-external-sharing-on-or-off
- Microsoft Learn (live): Microsoft 365 Archive overview: https://learn.microsoft.com/en-us/microsoft-365/archive/archive-overview?view=o365-worldwide
- Microsoft Learn (live): Copilot readiness report (counts, no score): https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-readiness
- Microsoft Learn (live): Copilot privacy, Copilot only surfaces data the user has at least view permission to: https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-privacy

Heuristics in this guide: "stale guest" at 90 days, "idle licence" at 90 days, and "cold storage" at one year are Spectre's choices, not Microsoft definitions; the 0 to 100 readiness score is Spectre's own design, not a Microsoft score; licence cost figures are unknown unless the operator supplies prices, because Microsoft publishes no guidance on licence cost waste.
