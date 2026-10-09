# Demo video script (3 minutes)

**Setup before recording**

- Browser: https://contractor-ops.houghworks.com/agent/ with the production key
  connected, zoomed to 125%. Second tab: the QuickBooks sandbox estimates list.
- Use a customer **without** a pending agent-drafted estimate for the approval
  scene (e.g. Ellen Park), or the agent will rightly warn about a duplicate.
- Terminal ready with `docs/eval-report.md` open (or the repo on GitHub).
- Do one throwaway question first so caches are warm; then click "New conversation".
- Record at 1080p; keep the cursor still while the agent works.

| Time | Screen | Say |
|---|---|---|
| 0:00 | Web chat, empty | "Contractors run their business out of QuickBooks, and getting a simple answer out of it, like who owes me money, or what should I charge for this bathroom, takes clicking through reports. This is an AI office manager that answers from their real books and drafts estimates from their own past jobs." |
| 0:15 | Architecture diagram (README) | "Two agents. The Office Manager talks to the contractor. It reaches data only through an MCP server I built over a Postgres mirror of QuickBooks, kept current by webhooks. For estimating it delegates to a separate Estimator agent over A2A. Every call carries the customer's API key, so tenant isolation holds across both agents." |
| 0:40 | Chat: click "Which customers owe me more than 60 days?" | "A lookup. It's routed to the small model, makes one tool call, and answers from the mirror." Point at the trace strip: "Route, model, the tool it used, and the cost: a twentieth of a cent." Point at the list: "Westside's invoice at 61 days is in; the one at exactly 60 isn't." |
| 1:05 | Type: "Draft an estimate for a standard bathroom remodel for Ellen Park" | While it works: "This goes to the larger model, which hands the job to the Estimator agent." When it returns, point at the highlighted chip: "That's the A2A delegation. The Estimator pulled comparable past jobs and sized this one, and it states its assumptions instead of asking me twenty questions. It can't invent a line item or a price: its output is checked in code against the jobs it actually retrieved, and the math is done in code." |
| 1:40 | Scroll the preview | "Nothing has been written yet. This is a preview with a one-time confirmation token." |
| 1:50 | Type: "What's the subtotal again?" | "A question isn't approval." Point at the trace: "No write." |
| 2:00 | Type: "Yes, create it." then switch to the QuickBooks tab and refresh | "Now it writes, exactly once." Point at "saved to QuickBooks", then at the new estimate in QuickBooks. "Each draft carries one fixed request id, so a timeout and a retry can't create a duplicate. That's tested with injected outages." |
| 2:20 | `docs/eval-report.md` | "I evaluated it with 36 cases, three runs each, against the real models: lookups, refusals, ambiguity, estimate quality, write safety, including instructions planted in QuickBooks data, and fault injection like a revoked token mid-write. The first run scored 87%; most failures were my own checker, and one was a real behavior I fixed. It's 108 out of 108 now, and the report says what that number doesn't prove." |
| 2:45 | Chat: "This month's usage" | "Every model call and every QuickBooks call is metered per customer, with a hard monthly cap that holds under concurrent requests. An estimate costs about nine cents across both agents." |
| 2:55 | README "Production vs. prototype" | "The README is explicit about what's production-grade and what isn't yet. Thanks for watching." |

**Fallbacks**

- If an estimate takes longer than ~30 seconds on camera, cut while it works.
- If the agent warns about a duplicate, say "it noticed an existing draft; I'll tell it to go ahead" and approve. That behavior is itself an eval case (W05).
