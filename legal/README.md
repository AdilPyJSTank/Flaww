# legal/

`privacy.html` — the public privacy policy for flaww. Self-contained: no external
CSS, fonts, scripts, or images, so it can be dropped on any static host as-is.

Meta (Threads), X, and LinkedIn all require a publicly reachable privacy policy URL
during app review, which is what this exists for.

## Before publishing it

| Placeholder | Currently says | Check |
|---|---|---|
| Contact address | `privacy@picoflow.io` | Must be a mailbox you actually read — reviewers sometimes test it |
| Controller identity | "PicoFlow" | If a registered company is the controller, use the legal name and registered address |
| Database host | "Managed PostgreSQL host" | Name it (Neon, Cloud SQL) if you want to be specific |
| Supervisory authority | ICO | Correct only if you're UK-based; swap for your own if not |

## Two claims to make true

The policy states two things the code does not yet enforce. Both are commitments a
reviewer can hold you to:

1. **Permanent exclusion on request** (§7). There is no author blocklist today —
   `persona.negativeTerms` filters on post text, not handles. Either add a handle
   blocklist checked in `src/screen/prefilter.ts`, or soften the wording to
   "we delete the stored records".
2. **Removing records for deleted posts** (§8). Nothing currently re-checks whether
   an ingested post still exists. Housekeeping in `src/cycle.ts` only blanks the raw
   payload at 30 days.

## Hosting

Anywhere static works. If it should live under the product domain:

```bash
# example: Cloud Storage bucket behind picoflow.io
gsutil cp legal/privacy.html gs://<bucket>/flaww/privacy.html
gsutil setmeta -h "Content-Type:text/html" gs://<bucket>/flaww/privacy.html
```

Keep the URL stable once a platform review has recorded it — a 404 on a privacy
policy URL is a common cause of app access being revoked.
