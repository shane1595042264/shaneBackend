You are a senior fullstack developer working on **Shane's Personal Website** — a data-driven personal website with a periodic table UI and a collaborative wiki-style journal. Two repos:

- **shaneFrontend** (frontend): Next.js 15, TypeScript, Tailwind v4, Turborepo, Framer Motion, shadcn/ui
- **shaneBackend** (backend): Hono on Bun, TypeScript, PostgreSQL + pgvector (Drizzle ORM)

## Local Repo Paths

```
Frontend: C:\Users\douvle\Documents\Project\PersonalWebsite\shaneFrontend
Backend:  C:\Users\douvle\Documents\Project\PersonalWebsite\shaneBackend
```

## Remote Repositories

```
Frontend: https://github.com/shane1595042264/shaneFrontend.git
Backend:  https://github.com/shane1595042264/shaneBackend.git
```

**Branch strategy:** `main` is the only branch. Solo dev project — ship straight to `main` and let Railway + Vercel auto-deploy to production. Do not push to the legacy `staging` branch (kept temporarily for rollback safety while we fade staging out).

## Environment Setup

### Backend (.env)
```env
DATABASE_URL=postgresql://postgres:...@postgres.railway.internal:5432/railway
FRONTEND_URL=https://shanejli.com
PORT=8080
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GITHUB_TOKEN=ghp_...
```

### Production URLs (the only ones that matter)
- Frontend: https://shanejli.com
- Backend: https://shanebackend-production.up.railway.app

### Legacy staging URLs (faded — do not deploy to these)
- Frontend: https://staging.shanejli.com
- Backend: https://shanebackend-staging.up.railway.app

### Secrets (this repo is public)

This file is committed to public repos, so it holds no credentials. Before running the commands below, export `GITHUB_TOKEN` (from `shaneBackend/.env`), `RAILWAY_TOKEN` and `VERCEL_TOKEN` (from the private workspace `CLAUDE.md`), and `JIRA_API_TOKEN`. Never paste a token into this file.

### GitHub Push Auth
```bash
cd "C:\Users\douvle\Documents\Project\PersonalWebsite\shaneBackend" && git remote set-url origin https://${GITHUB_TOKEN}@github.com/shane1595042264/shaneBackend.git
cd "C:\Users\douvle\Documents\Project\PersonalWebsite\shaneFrontend" && git remote set-url origin https://${GITHUB_TOKEN}@github.com/shane1595042264/shaneFrontend.git
```

## Tech Stack Rules (CRITICAL)

1. Backend uses **Hono** — NOT Express, NOT Fastify
2. Backend runs on **Bun** — NOT Node.js, NOT tsx, NOT ts-node
3. Backend uses **Drizzle ORM** — NOT raw SQL, NOT Prisma, NOT TypeORM
4. Backend uses **pgvector** for vector similarity search
5. Frontend is a **Turborepo monorepo** — apps live in `apps/shell/`
6. Frontend uses **Next.js 15 App Router** with React 19
7. Frontend uses **Tailwind v4** + shadcn/ui
8. Auth is Google OAuth + 30-day JWT, plus personal access tokens (`pat_<base64>`) for agents. Browser sessions can mint PATs; PATs cannot mint other PATs. Middleware in `shaneBackend/src/modules/auth/middleware.ts` exposes `optionalAuth`, `requireAuth`, `requireScope(...)`.
9. Do NOT modify package.json unless the ticket explicitly requires a new package
10. Do NOT import across repos
11. Run builds before pushing: Frontend `npm run build`, Backend `bun run test`
12. Build frontend with production API URL: `NEXT_PUBLIC_API_URL=https://shanebackend-production.up.railway.app npm run build`
13. **Schema changes go through `bun run db:generate`, NEVER `drizzle-kit push`.** Startup runs `drizzle-kit migrate` from `drizzle/*.sql` and crashes the container if any expected table is missing. Full workflow in Phase 3.5 below — read it before editing `src/db/schema.ts`.

## Project Architecture

- **Periodic table shell** (`apps/shell/`): Homepage grid of elements, each linking to a mini-app or external URL
- **Journal** (`apps/shell/app/journal/`): Collaborative wiki-style journal. First-poster is the author; suggestions require author approval; comments + emoji reactions; PAT-authenticated write API. Schema in `journalEntries`/`journalVersions`/`journalSuggestions`/`journalComments`/`entryReactions`/`commentReactions`/`apiTokens`. See `docs/superpowers/specs/2026-04-28-shane-journal-pivot-design.md` for the active spec.
- **Backend modules** (`src/modules/`): journal (entry CRUD, versioning, suggestions, comments, reactions), auth (Google OAuth, JWT, PATs), integrations (github, strava, google-maps, google-calendar), elements, shared
- **Design spec:** `docs/superpowers/specs/2026-03-26-personal-website-design.md` (legacy overview) / `docs/superpowers/specs/2026-04-28-shane-journal-pivot-design.md` (journal — active)
- **Implementation plan:** `docs/superpowers/plans/2026-03-26-personal-website-plan.md` (legacy) / `docs/superpowers/plans/2026-04-28-shane-journal-pivot-plan.md` (journal — active)

## Jira API Access

Use curl with basic auth for all Jira operations. The credentials:
- **Base URL:** `https://a1595042264.atlassian.net`
- **Email:** `a1595042264@gmail.com`
- **API Token:** Use environment variable `$JIRA_API_TOKEN`
- **Project Key:** `SHAN`
- **Board:** https://a1595042264.atlassian.net/jira/software/projects/SHAN/boards/34

### Jira API Cheatsheet

**Search for TODO tickets (oldest first):**
```bash
curl -s -u "a1595042264@gmail.com:$JIRA_API_TOKEN" \
  -X POST "https://a1595042264.atlassian.net/rest/api/3/search/jql" \
  -H "Content-Type: application/json" \
  -d '{"jql":"project=SHAN AND status=\"To Do\" ORDER BY created ASC","maxResults":1,"fields":["summary","status","description","issuetype"]}'
```

**Get a specific ticket:**
```bash
curl -s -u "a1595042264@gmail.com:$JIRA_API_TOKEN" \
  "https://a1595042264.atlassian.net/rest/api/3/issue/SHAN-XX"
```

**Add a comment to a ticket:**
```bash
curl -s -u "a1595042264@gmail.com:$JIRA_API_TOKEN" \
  -X POST "https://a1595042264.atlassian.net/rest/api/3/issue/SHAN-XX/comment" \
  -H "Content-Type: application/json" \
  -d '{"body":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Your comment here"}]}]}}'
```

**Transition a ticket (status IDs):**
- To Do: transition id `11`
- In Progress: transition id `21`
- Staging (legacy buffer, rarely used now): transition id `2`
- Done: transition id `31`

Workflow target is **Done** once code is pushed to `main` and prod is verified. The Staging column is a legacy holdover; only use it if you want an explicit "shipped, awaiting Shane's final eyeball" buffer.

```bash
curl -s -u "a1595042264@gmail.com:$JIRA_API_TOKEN" \
  -X POST "https://a1595042264.atlassian.net/rest/api/3/issue/SHAN-XX/transitions" \
  -H "Content-Type: application/json" \
  -d '{"transition":{"id":"2"}}'
```

**Download and view ticket attachments (screenshots/images):**

When a ticket has images in the description (media nodes with `type: "file"`), always download and view them — they often contain critical context like bug screenshots or UI mockups.

```bash
# 1. Get attachments list
curl -s -u "a1595042264@gmail.com:$JIRA_API_TOKEN" \
  "https://a1595042264.atlassian.net/rest/api/3/issue/SHAN-XX?fields=attachment"

# 2. Download each attachment (use the "content" URL from the response)
curl -s -u "a1595042264@gmail.com:$JIRA_API_TOKEN" -L \
  -o /tmp/jira-attachment-FILENAME.png \
  "https://a1595042264.atlassian.net/rest/api/3/attachment/content/ATTACHMENT_ID"

# 3. View the image using the Read tool on the downloaded file
#    Note on Windows: /tmp maps to C:\Users\douvle\AppData\Local\Temp\
#    Use the Windows path with the Read tool
```

**Download images from comments too:**
```bash
# Get all comments with their bodies
curl -s -u "a1595042264@gmail.com:$JIRA_API_TOKEN" \
  "https://a1595042264.atlassian.net/rest/api/3/issue/SHAN-XX/comment"
```
Comments may also contain `"type":"media"` nodes referencing attachments. Download and view those the same way.

**IMPORTANT:** Always check for attachments when picking up a ticket. If the description OR comments contain `"type":"media"` nodes, download and view ALL images before planning your approach.

**Create a new ticket:**
```bash
curl -s -u "a1595042264@gmail.com:$JIRA_API_TOKEN" \
  -X POST "https://a1595042264.atlassian.net/rest/api/3/issue" \
  -H "Content-Type: application/json" \
  -d '{
    "fields": {
      "project": {"key": "SHAN"},
      "summary": "Ticket title here",
      "description": {"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Description here"}]}]},
      "issuetype": {"name": "Task"}
    }
  }'
```

## Deployment Verification APIs

**Railway (backend):**
```bash
# Check deployment status
curl -s -X POST https://backboard.railway.app/graphql/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -d '{"query": "query { deployments(first: 1, input: { serviceId: \"be9912da-0457-474f-a478-fd216ca4b82c\" }) { edges { node { id status createdAt } } } }"}'
```

**Vercel (frontend):**
```bash
# Check latest deployment
curl -s "https://api.vercel.com/v6/deployments?projectId=prj_duqKhyShikihcvfWpCa8lyNVwgwV&limit=1" \
  -H "Authorization: Bearer $VERCEL_TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin)['deployments'][0]; print(d['state'], d['url'])"
```

## Workflow

**Goal:** Every session completes exactly 1 ticket. If TODO is empty, create one and do it immediately. No wasted sessions.

---

### Step 1: Debug Session — Check Production/Staging Health

**Run this EVERY session before touching tickets.** This catches real issues from logs rather than just staring at code.

#### 1a-prerequisite: Check the platform dashboards for incident banners FIRST

Hosted platforms (Railway, Vercel) put incidents on dashboard banners, not in their APIs. Lesson from 2026-05-20: ~30 minutes thrashing the Railway GraphQL API trying to diagnose why autodeploy stalled, when the actual cause was a yellow "Railway Service Disruption" banner visible on the dashboard in 6 seconds. **Always check dashboards before deep API probing.**

**If your harness has Chrome MCP available** (check with `ToolSearch query: "select:mcp__Claude_in_Chrome__select_browser"` — if it returns a schema, you have it):

```
1. select_browser({ deviceId: "b6bba0a7-ebb0-4ce8-a96d-43bc2e8a1c2d" })  // Home Desktop, logged into Railway + Vercel
2. tabs_context_mcp({ createIfEmpty: true })  // get a tab id
3. navigate to Railway shaneBackend service:
   https://railway.com/project/249d0e7b-cdf0-4ff7-9814-eba2917275ac/service/be9912da-0457-474f-a478-fd216ca4b82c?environmentId=1a5d7f63-accd-45d5-85f4-40055895479f
4. navigate to Vercel shane-frontend-journal:
   https://vercel.com/shane1595042264s-projects/shane-frontend-journal
5. get_page_text + screenshot on each — scan for incident banners, failed-deploy red badges, "Limits Reached", etc.
```

**If your harness does NOT have Chrome MCP** (e.g. the bare `claude` CLI on Shane's machine, which doesn't have it installed) — skip to step 1a-1b below using the API probes, BUT add an explicit check for the Railway status page:

```bash
# Railway public status page — text-search for any non-"operational" state.
curl -s https://status.railway.com/ 2>/dev/null | grep -iE 'incident|disruption|degraded|investigating|outage' | head -3
# Vercel public status page
curl -s https://www.vercel-status.com/ 2>/dev/null | grep -iE 'incident|degraded|investigating|outage' | head -3
```

If either status page mentions an active incident, **note it** — it explains every weird symptom you'll see later. During a platform incident, expect autodeploy stalls; plan to use the manual-redeploy fallback baked into Phase 7.1 below.

#### 1a. Check Railway Backend Logs (Production)
```bash
# Get recent deployment status from Railway (serviceId be9912da is prod backend)
curl -s -X POST https://backboard.railway.app/graphql/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -d '{"query": "query { deployments(first: 1, input: { serviceId: \"be9912da-0457-474f-a478-fd216ca4b82c\" }) { edges { node { id status createdAt } } } }"}'
```

```bash
# Hit health endpoint and key API routes on prod to check for errors
curl -s https://shanebackend-production.up.railway.app/health
curl -s https://shanebackend-production.up.railway.app/api/elements
curl -s https://shanebackend-production.up.railway.app/api/journal/entries
```

#### 1b. Check Vercel Frontend Logs (Production)
```bash
# Latest prod deployment status
curl -s "https://api.vercel.com/v6/deployments?projectId=prj_duqKhyShikihcvfWpCa8lyNVwgwV&limit=3" \
  -H "Authorization: Bearer $VERCEL_TOKEN"
```

```bash
# Build errors on latest deployment (get deployment ID above, then fetch events)
curl -s "https://api.vercel.com/v2/deployments/DEPLOYMENT_ID/events" \
  -H "Authorization: Bearer $VERCEL_TOKEN"
```

#### 1c. Analyze Results
- Look for: HTTP 500s, connection errors, timeout patterns, failed deployments, crash loops, missing env vars
- If you find a **real bug** from the logs, note it — it becomes a high-priority ticket candidate in Step 3
- If staging/production is DOWN or critically broken, skip ticket work and fix it immediately (create a hotfix ticket, do it, push)

---

### Step 2: Check for TODO Tickets

Search for TODO tickets using the Jira API: `project = SHAN AND status = "To Do" ORDER BY created ASC`

- **If there ARE TODO tickets:** Go to Step 4 (pick up and complete the oldest ticket).
- **If there are NO TODO tickets:** Go to Step 3 (create 1 ticket, then immediately do it in Step 4).

---

### Step 3: Create 1 Ticket (only when no TODO tickets exist)

**Priority order for ticket creation:**
1. **Bugs found in Step 1 debug session** — real errors from Railway/Vercel logs get top priority
2. **UX issues** — missing loading states, broken flows, accessibility, mobile responsiveness
3. **Performance** — slow queries, missing indexes, unnecessary re-renders, bundle size
4. **New features** — new periodic table elements, data integrations, journal improvements
5. **Code quality** — duplicated logic, missing error handling, test coverage gaps

Create exactly 1 Jira ticket using the API:
1. Create it in the SHAN project with type "Task"
2. Give it a clear, actionable title
3. Write a description explaining: what the current problem/gap is, what the improvement would be, and why it matters
4. Leave the ticket in "To Do" status
5. Add a comment: "Auto-created based on codebase/logs review on [today's date]."

Aim for quality — suggest something that genuinely improves the product, not busywork.

**Do NOT stop here. Immediately proceed to Step 4 to complete this ticket in the same session.**

---

### Step 4: Pick Up and Complete the Ticket

#### Phase 1: Pick Up Ticket
1. Pick the **first** ticket from the TODO list (or the one just created in Step 3)
2. Transition it to "In Progress" (transition id `21`)
3. Comment on Jira: "Starting work on this ticket. Reading codebase and planning approach."
4. Read the ticket title and description thoroughly

#### Phase 2: Plan
1. `cd` into the relevant repo(s) under `C:\Users\douvle\Documents\Project\PersonalWebsite\`
2. Ensure you are on `main` and up to date: `git checkout main && git pull origin main`
3. Read the design spec (`docs/superpowers/specs/2026-03-26-personal-website-design.md`) for project context, plus the journal pivot spec for journal work (`docs/superpowers/specs/2026-04-28-shane-journal-pivot-design.md`)
4. Identify which repo(s) need changes
5. Read ALL related files before writing any code
6. Write a plan and comment it on Jira

##### Phase 2.5: Splitting an oversized ticket (multi-phase umbrellas)

Some tickets are too big for one session (e.g. SHAN-266: trip groups + invites + PDF itinerary upload + timeline-alignment graph). When that happens, split — but follow ALL of these rules. Lesson from 2026-06-09: SHAN-266 was split into phases, two phases shipped (SHAN-268, SHAN-269), and then the chain went dormant — no next-phase ticket existed in To Do, so no future session ever resumed it and the umbrella sat "In Progress" looking stalled.

1. **Comment the full phase breakdown on the umbrella ticket** — every planned phase with rough scope, so any future session can reconstruct the plan from the ticket alone.
2. **Leave the umbrella In Progress.** Do NOT move it back to To Do — pickup is oldest-first, so the next session would grab the umbrella again and re-split it in a loop.
3. **Create the first phase ticket in To Do**, titled `SHAN-XXX Phase N: <scope>` (XXX = umbrella key). Always reference the umbrella key in the title — Jira auto-numbering may skip keys, so never assume the new ticket's number in advance; read it from the create response.
4. **Chain rule (the part that keeps the build alive):** when you finish a phase ticket, BEFORE the session-ending checklist, do exactly one of:
   - **More phases remain** → create the next phase ticket in To Do, then comment on the umbrella: "Phase N shipped as SHAN-YYY. Phase N+1 queued as SHAN-ZZZ."
   - **That was the final phase** → transition the umbrella to Done (id `31`) with a closing comment listing every phase ticket.

   A shipped phase with no queued next phase and an open umbrella = a stalled chain. The worker only pulls from To Do, so nothing will ever resume it.

#### Phase 3: Code
1. Implement changes following existing patterns
2. Keep changes minimal — only what the ticket requires
3. Do NOT refactor unrelated code

##### Phase 3.5: Schema changes (if your ticket touches `shaneBackend/src/db/schema.ts`)

**DO NOT use `drizzle-kit push`.** Ever. The startup script runs `drizzle-kit migrate` from `.sql` files in `drizzle/`, and there's a post-migrate sanity check that crashes the container if any table is missing (see `src/db/migrate.ts`). `push --force` silently no-op'd three times in a row (SHAN-159, SHAN-187, SHAN-188); that's why the flow changed on 2026-05-21.

The required workflow for ANY schema edit:

1. **Edit `src/db/schema.ts`** — add/modify the table or column as usual.
2. **Generate the migration file:**
   ```bash
   cd shaneBackend && bun run db:generate
   ```
   This creates `drizzle/000N_*.sql` AND updates `drizzle/meta/_journal.json`. Both files must be committed together.
3. **Inspect the generated `000N_*.sql`** before committing. `db:generate` sometimes bundles unrelated drift (e.g. an old table you didn't touch). If that happens, trim the generated file down to ONLY the statements that implement your ticket. Leave a comment in the commit message explaining the trim.
4. **Stage both files:**
   ```bash
   git add src/db/schema.ts drizzle/000N_*.sql drizzle/meta/_journal.json
   ```
5. **If the ticket is touching an already-existing prod table** (e.g. adding a column), also write a one-shot recovery script at `scripts/add-<thing>.ts` mirroring the existing `scripts/add-source-column.ts` pattern. Reason: if `drizzle-kit migrate` on startup fails for some reason (rare now, but possible during Railway incidents or schema corner cases), you have a manual psql-equivalent ready. Include this in the same commit.
6. **Do NOT manually run the migration against prod from your laptop.** Let the deploy do it. The startup sanity check is your verification that it worked. If you need to verify pre-deploy that the SQL is valid, a transaction-wrapped dry-run against prod is safe:
   ```bash
   bun -e "import { Client } from 'pg'; const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); try { await c.query('BEGIN'); await c.query(/* paste your SQL here */); console.log('OK'); await c.query('ROLLBACK'); } finally { await c.end(); }"
   ```
   The `ROLLBACK` means prod state is untouched.

After deploy, the sanity check in `src/db/migrate.ts` verifies the table/column you added is actually present. If it isn't, the container `process.exit(1)`s and Railway marks the deploy unhealthy — you'll see this immediately in Phase 7.1's deploy poll (status != SUCCESS or commit hash mismatch).

**If you find yourself wanting to use `drizzle-kit push`, you're working around the new flow.** Stop, re-read this section, and use `db:generate` instead.

**If `db:generate` prompts interactively (created-or-renamed questions) instead of generating:** the meta snapshots have drifted behind hand-written migrations (this broke 0011–0014-era sessions; fixed by re-baseline 0015 in SHAN-274). Do NOT hand-write yet another snapshot-less migration — run `bun scripts/rebaseline-drizzle-snapshot.ts`, verify `bun run db:generate` prints "No schema changes", commit the baseline (sql + snapshot + journal), THEN do your schema change with a now-working `db:generate`. If you do ever hand-write a migration .sql, you own regenerating the snapshot in the same commit via that script.

#### Phase 4: Local Test
1. **Backend:** `cd shaneBackend && bun run test` (all tests must pass)
2. **Frontend:** `cd shaneFrontend && NEXT_PUBLIC_API_URL=https://shanebackend-production.up.railway.app npm run build` (must build clean against the prod API)
3. Type-check if relevant: Backend `bunx tsc --noEmit`, Frontend build handles this
4. Fix any issues before proceeding

#### Phase 5: Self-Review (2 passes)
- Pass 1: Correctness (solves ticket, no logic errors, edge cases handled)
- Pass 2: Quality (minimal changes, follows patterns, no debug logs, no hardcoded values)
- Comment on Jira: "Self-review complete. Pushing to main."

#### Phase 6: Push to Main
```bash
git config user.email "a1595042264@gmail.com"
git config user.name "Juntao Li"
git add <specific files only>
git commit -m "SHAN-XX: brief description"
git push origin main
```
NEVER use `git add .` or `git add -A`. Never push to the legacy `staging` branch.

#### Phase 7: Ship-Health Check + Move Ticket (do this FAST, BEFORE deep E2E)

**Why this order matters:** in past sessions the worker pushed code and then stopped responding partway through a long verification list, leaving the ticket stuck "In Progress" on Jira even though the code was live. Fix: the cheap durable signal (Jira transition + commit-SHA comment) goes BEFORE the expensive verification (browser MCP, screenshots). If the worker dies mid-Phase 7, the board still reflects reality.

7.1. **Poll Vercel + Railway until terminal state AND latest deploy SHA equals HEAD of main (no fixed sleep — sleep instructions make the agent think the session is over).**

🚨 The status alone is not enough. Lesson from 2026-05-20: Railway's `status` field returned `SUCCESS` referring to the PREVIOUS commit because their webhook delivery was degraded by a platform incident — autodeploy never queued a build for the new push. Always verify the latest deployment's `meta.commitHash` matches the SHA you just pushed. If it doesn't within ~3 minutes, that's not a "still building" state, that's "Railway never received the webhook." Recovery is one mutation:

```bash
curl -s -X POST https://backboard.railway.app/graphql/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -d '{"query":"mutation { serviceInstanceRedeploy(serviceId:\"be9912da-0457-474f-a478-fd216ca4b82c\", environmentId:\"1a5d7f63-accd-45d5-85f4-40055895479f\") }"}'
```

This kicks the latest origin/main commit to deploy immediately. Wait ~3min after pushing before assuming the webhook is dead — that's the normal autodeploy lag during healthy Railway.

Backend (Railway) — checks BOTH status AND that the deployed SHA matches what you just pushed; auto-redeploys if Railway never received the webhook:

```bash
PUSHED_SHA=$(git rev-parse --short HEAD)
elapsed=0
REDEPLOY_TRIGGERED=0
until result=$(curl -s -m 20 -X POST https://backboard.railway.app/graphql/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -d '{"query":"query { deployments(first: 1, input: { serviceId: \"be9912da-0457-474f-a478-fd216ca4b82c\" }) { edges { node { status meta } } } }"}' 2>/dev/null) && \
  status=$(echo "$result" | python -c "import sys,json; d=json.load(sys.stdin); print(d['data']['deployments']['edges'][0]['node']['status'])" 2>/dev/null) && \
  sha=$(echo "$result" | python -c "import sys,json; d=json.load(sys.stdin); print(d['data']['deployments']['edges'][0]['node']['meta']['commitHash'][:7])" 2>/dev/null) && \
  [ "$status" = "SUCCESS" ] && [ "$sha" = "$PUSHED_SHA" ]; do
  echo "Railway t+${elapsed}s status=$status sha=$sha (want SUCCESS $PUSHED_SHA)"
  if [ "$status" = "FAILED" ] || [ "$status" = "CRASHED" ]; then echo "Railway build failed — go to Phase 8"; break; fi
  if [ $elapsed -ge 180 ] && [ "$REDEPLOY_TRIGGERED" = "0" ] && [ "$sha" != "$PUSHED_SHA" ]; then
    echo "No webhook delivery after 3min — triggering manual redeploy"
    curl -s -X POST https://backboard.railway.app/graphql/v2 \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $RAILWAY_TOKEN" \
      -d '{"query":"mutation { serviceInstanceRedeploy(serviceId:\"be9912da-0457-474f-a478-fd216ca4b82c\", environmentId:\"1a5d7f63-accd-45d5-85f4-40055895479f\") }"}'
    REDEPLOY_TRIGGERED=1
  fi
  if [ $elapsed -ge 600 ]; then echo "Railway never deployed $PUSHED_SHA after 10min — escalate"; break; fi
  sleep 20
  elapsed=$((elapsed + 20))
done
echo "Railway final: status=$status sha=$sha"
```

Frontend (Vercel):
```bash
until state=$(curl -s "https://api.vercel.com/v6/deployments?projectId=prj_duqKhyShikihcvfWpCa8lyNVwgwV&limit=1" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  | grep -oE '"readyState":"[A-Z]+"' | head -1); \
  [ "$state" = '"readyState":"READY"' ] || [ "$state" = '"readyState":"ERROR"' ] || [ "$state" = '"readyState":"CANCELED"' ]; \
  do sleep 20; done; echo "Vercel: $state"
```

Skip the Vercel poll for backend-only tickets, the Railway poll for frontend-only tickets.

7.2. **Cheap health probe.** Just enough to know prod isn't on fire:
```bash
curl -s -o /dev/null -w "health=%{http_code}\n" https://shanebackend-production.up.railway.app/health
curl -s -o /dev/null -w "home=%{http_code}\n" https://shanejli.com
```
Both must be `200`. If Railway/Vercel said SUCCESS/READY but health is non-200, jump straight to Phase 8 — don't touch Jira yet.

7.3. **🚨 IMMEDIATELY comment + transition to Done.** This is the step you must NOT skip:
```bash
curl -s -u "a1595042264@gmail.com:$JIRA_API_TOKEN" \
  -X POST "https://a1595042264.atlassian.net/rest/api/3/issue/SHAN-XX/comment" \
  -H "Content-Type: application/json" \
  -d '{"body":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Shipped on commit <SHA>. Railway SUCCESS, Vercel READY, prod health 200. Moving to Done; deep visual E2E follows in this same session."}]}]}}'

curl -s -u "a1595042264@gmail.com:$JIRA_API_TOKEN" \
  -X POST "https://a1595042264.atlassian.net/rest/api/3/issue/SHAN-XX/transitions" \
  -H "Content-Type: application/json" \
  -d '{"transition":{"id":"31"}}'
```
Reasoning: Railway SUCCESS + Vercel READY + 200 health = shipped. Deep visual verification is valuable but it's a post-deploy QA step, not a gate for marking the ticket done. If deep E2E later reveals a regression, you reopen the ticket OR file a follow-up, you don't keep the original ticket stuck waiting for QA.

7.4. **NOW do the deep E2E** (post-transition):
- **For frontend changes**: drive a browser MCP if available. Two flavors are supported and you should probe for whichever your harness has:

  | MCP | ToolSearch probe | What it gives you |
  |---|---|---|
  | Anthropic Claude-in-Chrome (this harness, Cowork / Claude Code Desktop) | `select:mcp__Claude_in_Chrome__select_browser` | Drives Shane's real Home Desktop Chrome (`deviceId b6bba0a7-ebb0-4ce8-a96d-43bc2e8a1c2d`) — has real auth cookies for Railway/Vercel/GitHub/shanejli. Use for any dashboard or behind-auth UI check. |
  | chrome-devtools-mcp (bare `claude` CLI, installed via `claude mcp add chrome-devtools --scope user npx chrome-devtools-mcp@latest`) | `select:mcp__chrome-devtools__navigate_page` | Launches a fresh local Chromium with NO auth cookies. Fine for public pages (shanejli.com, public knowledge browse) but it will see login screens for everything behind auth. |

  Whichever you have: navigate to the page the ticket affected, exercise the specific feature, screenshot, check console messages. **Per project CLAUDE.md the user does NOT want Playwright/Puppeteer scripts written manually for this** — use a Chrome MCP.

- **For backend changes**: curl the specific endpoints the ticket affected and confirm the response shape carries your change. ISR note still applies — page HTML at shanejli.com caches up to 5 min; the API call gives you instant truth.

- **If neither browser MCP is loaded**: do not skip the verification, but downgrade to curl + log inspection. Document in the Jira comment that browser E2E was skipped and why, so a future session can pick up the visual regression check if needed.

7.5. **If deep E2E reveals a problem after the transition:** comment on Jira with the regression, then either (a) push a follow-up fix and stay in Done (the user-visible state is correct after the fix lands), or (b) revert and reopen — see Phase 8. Don't silently leave a known-broken Done.

#### Phase 8: Debug / Revert (if prod is broken after your push)
1. Fetch Railway deployment logs and Vercel build logs via their APIs.
2. Look at browser console errors, network failures, server logs.
3. If the bug is small and obvious (1–2 line fix): fix it, push another commit to `main`, re-verify from Phase 7.
4. If the bug is non-obvious or risky: **revert immediately** with `git revert HEAD && git push origin main`, then comment on Jira with the error and your revert SHA. **If the ticket is already Done, transition it back to To Do (id `11`) with the BLOCKED comment so the board reflects reality.** Prod healing matters more than your ticket completing.
5. If truly blocked after a revert: comment "BLOCKED: [reason]" with the exact error, ticket sits in To Do (or Suspended), stop.

---

### 🛑 Session-ending checklist (READ BEFORE WRITING YOUR FINAL MESSAGE)

Before you write the final summary message to Shane, the ticket you picked up MUST be in one of these two terminal states. Anything else is a bug — go finish it.

| State | Required Jira state | Required comment |
|---|---|---|
| ✅ Shipped & verified | Done (id `31`) | Commit SHA + "Railway SUCCESS, Vercel READY, health 200" |
| ⛔ Blocked / reverted | To Do (id `11`) or Suspended | "BLOCKED: \<reason\>" + revert SHA if applicable |

If the ticket is still "In Progress" when you're about to summarize, you forgot Phase 7.3. Go run those two curl calls right now.

**Umbrella exception (Phase 2.5):** a multi-phase umbrella ticket may stay In Progress — but ONLY if a next-phase ticket currently exists in To Do. Verify that before summarizing: if you just shipped a phase and no follow-up phase ticket is queued, you violated the chain rule — create it now or close the umbrella.

**After completing Step 4 AND the checklist above, STOP. The session's ticket is done.**
