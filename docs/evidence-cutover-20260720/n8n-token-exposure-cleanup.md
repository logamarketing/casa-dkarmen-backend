# n8n token-exposure cleanup — 2026-07-20 (~14:45 MZT)

The Twilio auth token had been exposed in plaintext inside n8n execution logs
(Twilio's `Accounts.json` response embeds `auth_token`; see HANDOFF-RESUME §6).
Owner-authorized cleanup, executed via the authenticated n8n cloud UI
(logamarketing.app.n8n.cloud) because the MCP surface has no execution-delete
capability and no n8n API credential exists.

## What was deleted (permanent)

| Item | Kind | Why |
|---|---|---|
| `TEMP-karmen-inbound-proof (delete after use)` | archived workflow | its executions carried the Twilio account probe; named delete-after-use by its author |
| `TEMP-karmen-callproof (delete after use)` | archived workflow | same |
| `TEMP-karmen-twilio-discovery (delete after use)` | archived workflow | same — this is where the `Accounts.json` listing (the token leak) ran |

Deleting an n8n workflow permanently deletes all of its executions — that is the
mechanism that purges the token from execution data.

## Verification

- Workflows list (archived filter ON): total went 123 → 120; zero archived
  workflows remain in the instance.
- Execution **69967** (the one named in the exposure record): direct navigation to
  `/executions/69967` returns **404 Error — "Oops, couldn't find that"**.
- The MCP execution listing already hid archived-workflow executions; the only
  archived workflows in the instance were the three TEMPs above, so 69967 and its
  siblings (the ID gaps 69967/69972/69977 in the listing) belonged to them and are
  gone with them.

## Explicitly NOT done (owner's decision, on purpose)

**The token was NOT rotated.** Rotation invalidates the credential for every
integration that uses it (Karmen, Lucy, Lisa, Mary surfaces) until each is
updated, and nobody is watching the live lines right now. Rotation is queued as a
flagged item with exact steps in HANDOFF-RESUME §6.

Caveat, stated honestly: purging the logs removes the token from n8n execution
data going forward, but anyone who read those logs before 2026-07-20 ~14:45 MZT
would still hold a valid token — which is why rotation remains recommended, at a
moment when someone is watching the lines.
