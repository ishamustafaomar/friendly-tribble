# o_typefully

A local, single-process composer and scheduler for X (Twitter) threads, in the
spirit of Typefully. Write posts as a stack of cards, put them into a queue of
posting slots you define in `config.json`, and either let the app publish them
through the X API at the right time or have it remind you to post them yourself.
One Node process, one SQLite file, no build step, no native modules.

- Thread editor: post cards, `---` splitting, drag to reorder, live 280-character
  counter using the same weighting X uses (twitter-text)
- Images: PNG, JPEG, GIF, WebP; up to 4 per post; alt text
- Autosave to `data/app.db`; every draft survives a reload or a restart
- Slot queue from `config.json`: timezone-aware, DST-safe, "next free slot",
  custom times, calendar view
- Two ways to publish: the X API (OAuth 1.0a, resumable threads, retry) or
  reminder mode (browser notification at slot time, copy stepper, mark as
  posted), which costs nothing
- Live updates in every open tab over Server-Sent Events
- Light and dark theme, focus mode, keyboard-first, optional password

Contents: [Quick start](#quick-start) · [Writing](#writing) · [Queue](#queue) ·
[Publishing via the X API](#publishing-via-the-x-api) ·
[What X charges](#the-honest-part-what-x-charges-for-posting) ·
[Reminder mode](#free-fallback-reminder-mode) · [Running on a VPS](#running-on-a-vps) ·
[Architecture](#architecture) · [HTTP API](#http-api) · [Tests](#tests) ·
[Limitations](#limitations) · [Troubleshooting](#troubleshooting) · [License](#license)

## Quick start

Requires Node 22.16 or newer: it uses the built-in `node:sqlite` (so there is
nothing to compile), including the database `isOpen` and `isTransaction`
accessors that only arrived in 22.15 and 22.16.

```sh
git clone <repository-url> o_typefully
cd o_typefully
npm install
cp .env.example .env     # optional: only needed for X API keys, a password, or a different port
npm start
```

Open http://localhost:3000. Without X keys the app runs in reminder mode and
says so in the sidebar footer. `npm run dev` does the same with restart on file
changes.

The start script passes `--disable-warning=ExperimentalWarning` because
`node:sqlite` still prints an experimental-feature notice on Node 22, and
`--disable-warning=DEP0040` because twitter-text pulls in the deprecated
`punycode` module, which prints a deprecation notice on load. Both flags only
hide warnings; nothing breaks without them.

### Environment variables (`.env`)

`.env` is read at start with `process.loadEnvFile`; variables already set in the
environment win over the file, and a missing file is fine.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port (0 to 65535) |
| `HOST` | `127.0.0.1` | Bind address; keep loopback unless a proxy or `APP_PASSWORD` is in front |
| `ALLOWED_HOSTS` | empty | Comma-separated `host` or `host:port` entries the server answers to besides the local names (checked against the request's `Host` header; other names get 421). `localhost`, `127.0.0.1` and `[::1]` always work. Empty means: a server bound to a loopback address answers only to those local names, any other bind address answers to any name. Needed behind a reverse proxy that passes the public name through; see [Running on a VPS](#running-on-a-vps) |
| `DATA_DIR` | `./data` | Holds `app.db` (plus its `-wal`/`-shm` files) and `uploads/`; created on start |
| `CONFIG_PATH` | `./config.json` | Slot configuration, see [Queue](#queue) |
| `APP_PASSWORD` | empty | When set, HTTP Basic auth (any username, this password) is required on every route, including `/media/*`, `/api/events` and the static files |
| `X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | empty | OAuth 1.0a user-context credentials. Publishing is available only when all four are non-blank |
| `X_HANDLE` | empty | Display only ("connected as @handle"); a leading `@` is stripped |

Relative paths are resolved against the working directory the process starts in.

## Writing

The editor shows one draft as a vertical stack of post cards joined by a thread
line. Each card has a textarea that grows with its content, a drag handle and
up/down buttons for reordering, an "Add image" button, the counter, and a
"1/3"-style index. "Remove post" appears once the thread has more than one card;
"+ Add post" sits under the last one.

**Splitting.** Type `---` on a line of its own and the card splits there, with
the caret in the new card. Pasting a whole thread that uses `---` separators
explodes it into cards. "Copy thread" produces the same format (posts joined by
a blank line, `---`, blank line), so a copied thread pastes back into cards.
Backspace in an empty card (other than the first) removes it and puts the caret
at the end of the previous one. Enter is just a newline.

**Trailing empty cards.** The empty card that `---` leaves for the caret is
scaffolding, not a post: cards at the end of the thread with no text, no image
and no upload in progress are dropped by the editor before Schedule,
Ctrl/Cmd+Enter, Publish now and Retry (the thread is saved without them), and
left out of "Copy thread" and its post count. The server applies the same
rule: `/schedule`, `/publish` and `/retry` drop trailing empty posts (never
the only one) and store the thread without them before validating it, so a
thread sent straight to the HTTP API behaves the same way. An empty card in
the middle is still an error ("Post 2 is empty."), in the editor and in the
API alike.

**Images.** Attach with the button, by pasting an image from the clipboard, or by
dropping a file on a card. Files upload immediately (`POST /api/media`), show a
spinner thumbnail meanwhile, and are checked on the server by size and by magic
bytes, not just by extension. Each thumbnail has an "ALT" button for a
description (up to 1000 characters; sent to X as alt text) and a remove button.

| Limit | Value |
|---|---|
| Formats | `image/png`, `image/jpeg`, `image/gif`, `image/webp` |
| Size | 5 MiB for PNG/JPEG/WebP, 15 MiB for GIF |
| Per post | 4 images, or 1 GIF on its own |
| Posts per thread | 25 |
| Text per post | 280 weighted characters |

**Counter.** The ring and the "n / 280" label use twitter-text's weighted length,
which is what X enforces: any URL counts as 23, most emoji and CJK characters
count as 2, other characters count as 1. Neutral below 260, amber from 260 to
280, red above 280 (the card border turns red too) or when the text contains a
character X rejects. The server re-validates with the same library before
anything is queued or published.

**Autosave.** 600 ms after the last change the draft is saved (`PUT
/api/drafts/:id`); the action bar shows "Saving…", then "Saved just now" with a
relative time. A brand-new draft is created on the first edit or immediately by
"New draft". Leaving the page with a save still pending triggers the browser's
"unsaved changes" prompt. Everything lives in `data/app.db`; images live in
`data/uploads/`. When the server refuses a save because the draft changed
underneath the editor — it was posted (or is being posted) from another tab,
or its first posts went out to X in a publish that failed part-way — the editor
fetches the server's copy, restores the posts that can no longer change, keeps
your edits to the rest and says so in a toast, then saves again; it never sits
on "Not saved" for good. Two tabs editing the same draft at once are not
reconciled: the last save wins (see [Limitations](#limitations)).

**Focus mode** hides the sidebar and all chrome except the cards and a small
floating save indicator. It is remembered across reloads.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl/Cmd+Enter` | Add the draft to the queue at the next free slot, keeping its mode (API when keys are configured and the draft is not already in reminder mode) |
| `Ctrl/Cmd+S` | Save now |
| `Ctrl/Cmd+Shift+F` | Toggle focus mode |
| `Esc` | Close the open popover; otherwise leave focus mode |
| `---` on its own line | Split the card at that line |
| `Backspace` in an empty card | Remove the card and go to the end of the previous one |
| `Enter`/`Space` on a "Move post up/down" or "Remove post" button | Moves or removes the post; focus stays on that button (not in the textarea), so pressing it again keeps moving |

Every action is reachable with the keyboard; buttons have labels for screen
readers and the counter announces itself only once a post is over the limit.
On a touch screen the hints that name keys change or go: the focus-mode
indicator says "Tap to exit" instead of "Esc to exit", the Ctrl/Cmd+Enter hint
under the cards is hidden, and the "Remove post" ✕ and image tools are always
visible instead of appearing on hover.

## Queue

### `config.json`

```json
{
  "timezone": "America/New_York",
  "slots": [
    { "days": ["mon", "tue", "wed", "thu", "fri"], "time": "09:00" },
    { "days": ["mon", "tue", "wed", "thu", "fri"], "time": "16:00" }
  ],
  "schedulerIntervalSeconds": 30,
  "missedGraceMinutes": 180,
  "queueDaysAhead": 14
}
```

| Key | Default | Meaning |
|---|---|---|
| `timezone` | the system zone | IANA name the slots are expressed in; must be accepted by `Intl.DateTimeFormat` |
| `slots[].days` | | Day names, case-insensitive: `mon`..`sun` or `monday`..`sunday`; the shortcuts `weekdays`, `weekends`, `daily`/`everyday`; or numbers 0 to 6 (0 = Sunday). A single string works too |
| `slots[].time` | | 24-hour `HH:MM` |
| `schedulerIntervalSeconds` | `30` | How often the publish loop runs: a number of seconds from 1 to 2147483 (fractions allowed) |
| `missedGraceMinutes` | `180` | An API item more than this late that has never been attempted is marked failed instead of being posted late. A number >= 0; `0` or `null` disables the check |
| `queueDaysAhead` | `14` | How many days the calendar shows by default: a whole number from 1 to 400 (the longest range `GET /api/queue` serves) |

A missing file means the defaults above (with the system timezone) and a notice
in the log. Invalid JSON or a value outside the ranges above stops the server
with a message naming the field, such as `Config file ./config.json:
schedulerIntervalSeconds must be a number of seconds between 1 and 2147483 (got
0.5)`. The file is read once at start: edit it, then restart. An empty `slots`
array is allowed; then only custom times can be used.

### How slots work

- **Next free slot** is the earliest slot occurrence at least one minute in the
  future that no queued item (scheduled, publishing or due) already occupies,
  searching up to a year ahead. If there is none, scheduling answers
  `409 No free slot found — add slots to config.json`.
- **Custom time**: "Pick a time" in the Schedule popover accepts any moment no
  more than a minute in the past; it opens pre-filled with the top of the hour
  after next in the browser's zone. The time is stored floored to the whole
  minute (seconds and milliseconds dropped), so it lines up with the slots and
  the calendar. Such items show a "Custom time" badge in the calendar. Two
  items may share a moment; the queue lists both.
- The Schedule popover also chooses the mode: "Publish via X API" (disabled with
  the reason when keys are missing) or "Remind me (I'll post it myself)".
- **Reschedule** (in the banner or the calendar) reopens the same popover;
  **Unschedule** moves the item back to Drafts and frees its time. Neither
  forgets posts that are already on X: a thread that was published part-way
  keeps that record through Unschedule, Reschedule and "Back to drafts" (see
  [Partially published threads](#partially-published-threads)).
- An empty or over-limit thread is refused before the popover opens ("Write
  something first." or the same "Fix these first" list the server would
  answer), and "Schedule a draft here…" in the calendar lists such drafts
  greyed out with the reason.
- **Changing `config.json` moves nothing.** Every queued item keeps the absolute
  time it was given. If a slot no longer exists, the item simply shows as a
  custom-time entry.

### Calendar view

The Queue tab lists days from today for `queueDaysAhead` days in the configured
timezone, with times displayed in the browser's zone (the footer says "shown in
…" when the two differ). Day headers read "Today · Mon, Sep 7", "Tomorrow · …",
then plain dates. Each slot is either a card (first line, post count, up to four
thumbnails, `API`/`Reminder` badge, status badge) with Open · Reschedule ·
Unschedule · Publish now (API mode, keys configured) · Copy · Delete, or an
"Empty slot" row whose "Schedule a draft here…" button picks one of the current
drafts. Overdue and due items are pulled out of their day and listed once, at
the top, under "Needs attention" (with their date, since they are shown outside
their day); they do not appear in the day list as well. A due reminder's card
there also carries "Mark as posted", so it can be finished without opening it.
Past days appear only when they still hold something; past empty slots are
hidden. Items outside the window (overdue, or far ahead) are still listed, in
that box or after the last day. The view refreshes itself on every server
event.

### Statuses

| Status | Meaning |
|---|---|
| `draft` | Not queued. After "Back to drafts" on a thread that was published part-way it still carries the ids of the posts on X, which stay locked |
| `scheduled` | In the queue, waiting for its time |
| `publishing` | API mode, being posted right now; read-only, cannot be deleted |
| `due` | Reminder mode, the time has come; waiting for you to post and mark it. Switching it to API mode (`PUT {"mode":"api"}`) puts it back to `scheduled` at its time so the loop posts it |
| `posted` | Done, via the API or marked by hand; read-only, duplicate it to reuse |
| `failed` | An API publish failed; the error is on the draft. The posts that went out (`result.tweetIds`) are locked and "Retry from post k+1" continues after them |

Transitions: draft → scheduled (Schedule); scheduled → publishing → posted or
failed (API); scheduled → due → posted (reminder, via Mark as posted); failed →
scheduled (Retry, Reschedule); due → scheduled (Snooze, Reschedule, or a mode
change to API); anything except posted and publishing → draft (Unschedule,
"Back to drafts"). Whatever the transition, a draft that carries
`result.tweetIds` keeps them, and the next API attempt continues after the
last of those posts; only Duplicate starts a fresh thread.

## Publishing via the X API

### Keys

1. In the [X developer portal](https://developer.x.com/en/portal/dashboard)
   create a project and an app (or open an existing one).
2. In the app's **User authentication settings** set **App permissions** to
   **Read and write** and save.
3. Only then open **Keys and tokens**: copy the **API Key and Secret** (the
   OAuth 1.0a consumer pair) and generate the **Access Token and Secret** for
   your own account. Tokens generated before step 2 are read-only and every post
   fails with 401 or 403; regenerate them after changing permissions.
4. Put the four values in `.env` as `X_API_KEY`, `X_API_KEY_SECRET`,
   `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` (`X_HANDLE` is optional) and
   restart. The startup banner in the terminal then prints
   `X API: configured (@handle)`, and the sidebar footer changes from
   `X API: not configured — reminder mode` to `X API: connected as @handle`.
5. Make sure the developer account is enrolled in a plan that allows writes
   (see [the pricing section](#the-honest-part-what-x-charges-for-posting)).

To check the keys without posting anything:

```sh
curl http://127.0.0.1:3000/api/x/verify        # add -u user:$APP_PASSWORD when a password is set
```

It calls `GET /2/users/me` and answers `{ ok: true, user, note }` or
`{ ok: false, error, hint, note }` with HTTP 200 either way (400 when no keys
are configured); `note` repeats that this is a read call, which pay-per-use
bills as one read. The web UI never calls it, and the app never reads your
timeline, analytics or anything else from X. Apart from this check, the only
`GET` requests it makes are the media-processing status polls during an
upload (`GET /2/media/upload?command=STATUS`, at most 20 per image; GIFs in
particular are processed asynchronously), whose billing X does not document.

### What the loop does

`src/scheduler.js` runs a tick right after the port is open and then every
`schedulerIntervalSeconds`. The first tick runs in the background: the banner
prints and Ctrl-C works immediately, however many drafts are due. A tick:

1. Puts rows left in `publishing` by a crashed process back to `scheduled`
   (start only), keeping their partial result so they resume.
2. Marks reminder-mode items whose time has come as `due` and emits a
   `reminder` event.
3. Claims every due API item in one transaction (`scheduled` → `publishing`),
   then for each one:
   - no keys configured → `failed` with "X API keys are not configured…";
   - more than `missedGraceMinutes` late and never attempted → `failed` with
     "Missed its slot: the server was not running at … Retry or reschedule it";
   - otherwise publishes the thread in order: upload the post's images (chunked
     v2 media upload, sent with the MIME type the upload verified from the
     file's bytes — a GIF goes as `tweet_gif`, everything else as
     `tweet_image` — alt text best effort), `POST /2/tweets` replying to the
     previous post, and write the ids so far to the draft after every post.
     Success → `posted` with `result.url = https://x.com/i/status/<first id>`
     and a `posted` event. Any error → `failed` with the message and hint in
     `result.error`, the ids already posted in `result.tweetIds`,
     `result.failedIndex` and `result.attempts`, and a `failed` event.
4. Once an hour deletes uploaded images that no draft references and that are
   older than an hour.

Every request to X has a 60-second deadline (connecting, headers and body
together). A stalled one fails the item with `X API request timed out after
60s on POST /2/tweets` (status 0, no hint) instead of holding the loop — and
with it reminders, Publish now, Retry and shutdown — for as long as the
network stack allows; the thread resumes from that post on Retry. Other
network failures name their cause, e.g. `X API request failed on POST
/2/tweets: fetch failed: getaddrinfo ENOTFOUND api.x.com` (Node's `fetch`
ignores `HTTPS_PROXY`, so a proxy-only network fails this way). A 2xx from a
media endpoint that carries only an `errors[]` array is treated as the error
it is, with X's own detail, rather than as a finished upload.

On SIGINT/SIGTERM the loop finishes only the draft it is posting; the other
drafts that tick had already claimed go back to `scheduled` with their time
and any partial result, so they are neither cut off mid-thread nor left in
`publishing` (the log says how many were handed back).

**Retry** (banner, Posted tab, `POST /api/drafts/:id/retry`) re-queues a failed
item for right now and runs a tick immediately. Because progress is persisted
after each post, a retry continues from the first unposted post, replying to the
last one that went out (the button reads "Retry from post k+1"); nothing is
posted twice, even after a crash mid-thread. A missing image file fails the
item with a clear message instead of posting a broken thread. Retry validates
the thread first, so it can answer `400 Fix these first` like Schedule does.

#### Partially published threads

A thread whose `result.tweetIds` is non-empty has its first k posts on X.
Those posts are **locked**: in the editor they are read-only, with a small
"Posted" badge that links to `https://x.com/i/status/<id>`, no reorder handle
or tools, and nothing can be moved ahead of them; the server refuses any
change to them with `409 Post 1 is already on X and cannot be changed —
duplicate the draft to rewrite them.` (or `Posts 1–k are …`). The banner
says: "Posts 1–k are already on X and are locked. Publishing continues from
post k+1. Duplicate the thread to start over."

The record survives every transition. "Back to drafts" / Unschedule and
Reschedule keep `result.tweetIds`, `failedIndex` and `url`; the status may
become `draft` or `scheduled` (in either mode) but the next Schedule, Publish
now or Retry continues after the last posted id, replying to it, and so does a
reminder draft that comes due carrying such a result and is switched back to
API mode. **Duplicate is the only way to post everything again**: it creates
a fresh draft with the same posts and images and no result. The failed
banner offers "Retry from post k+1", "Copy thread" and "Back to drafts"; the
action bar of a failed draft only adds "Schedule retry ▾" (queue the same
retry for later), not a second Publish now. The Publish now confirmation
names the posts that are already on X when it resumes a thread.

**Publish now** (action bar, calendar, `POST /api/drafts/:id/publish`) checks
the thread in the browser first (an empty or over-limit thread gets the "Fix
these first" list before any dialog opens or a draft is created), asks for
confirmation, schedules the draft for the current moment in API mode and runs a
tick; the response carries the final status.

**Where results show:** the editor banner (green with the link, or red with the
error text), the Posted tab (newest first, with "View on X" or the error), a
toast and a browser notification in every open tab, and the `result` field of
the draft in the API.

## The honest part: what X charges for posting

Everything in this section is **as of September 2026** and comes from
third-party write-ups, because X's own developer documentation was not
reachable from the network this was written on. Prices change; verify on the
official page, [developer.x.com/en/products/x-api](https://developer.x.com/en/products/x-api),
before relying on any number below.

**There is no free tier for new developers.** On 6 February 2026 X made
pay-per-use the default and discontinued the free tier for new sign-ups.
Existing free-tier apps were migrated. The legacy Basic ($200/month) and Pro
($5,000/month) subscriptions stayed only for people already on them; Enterprise
is roughly $42,000/month. Before February 2026 the free tier allowed a small
write-only monthly quota, which is how many "post from a script for free"
tutorials still assume things work; that is gone for new accounts.

**Pay-per-use** means you add a payment method or credits in the developer
console and are billed per call:

| Action | Price |
|---|---|
| Post created, no link in the text | $0.015 |
| Post created that contains a link | $0.20 |
| Post read | $0.005 |
| Media upload | Not clearly documented. Assume it is included with the post, and verify on your first bill |

Worked examples, using the prices above:

| Usage | Cost |
|---|---|
| 40 posts a month, no links | about $0.60 |
| 40 posts a month, each with a link | about $8.00 |
| One 5-post thread, no links | about $0.075 |
| One 5-post thread with a link in one post | about $0.26 (4 × $0.015 + $0.20) |
| One `GET /api/x/verify` | $0.005 |

For comparison, Typefully's plans in 2026 are roughly $12.50, $19 and $39 per
month billed yearly, with a free plan limited to about 15 posts a month. Under
that cap Typefully costs nothing, so the API is never cheaper there. Above it,
someone who posts a few dozen times a month and rarely links pays the API far
less than the cheapest $12.50 plan; a heavy poster who links in most posts
(about 63 linked posts a month at $0.20 each) can pay more.

**You do not have to pay X anything to use this app.** In reminder mode the app
notifies you in the browser when a slot arrives, gives you a copy button per
post, and records the thread as posted when you say so. Automatic publishing is
there if you enroll.

Sources (third party, read in September 2026):
[blotato.com](https://www.blotato.com/blog/twitter-api-pricing),
[postproxy.dev](https://postproxy.dev/blog/x-api-pricing-2026/),
[socialcrawl.dev](https://www.socialcrawl.dev/blog/x-twitter-api-2026),
[opentweet.io](https://opentweet.io/how-to/x-api-pay-per-use-explained),
[api.sorsa.io](https://api.sorsa.io/blog/twitter-api-pricing-2026),
[socialrails.com on Typefully pricing](https://socialrails.com/blog/typefully-pricing),
[efficient.app on Typefully](https://efficient.app/apps/typefully).
Official: [X API products](https://developer.x.com/en/products/x-api) and the
[chunked media upload guide](https://docs.x.com/x-api/media/quickstart/media-upload-chunked).

## Free fallback: reminder mode

Reminder mode is the default whenever no X keys are configured, and can be
chosen per item in the Schedule popover otherwise.

1. Schedule the thread with "Remind me (I'll post it myself)".
2. When the time comes the scheduler marks it `due` and every open tab shows a
   toast plus, if you allowed notifications, a browser notification titled
   "Time to post" that stays until you dismiss it. Clicking it focuses the
   window and opens the draft.
3. The draft shows a highlighted banner: "Copy post 1 of N" copies the first
   post and advances to the next; each card also has its own Copy button. Paste
   on X.
4. "Mark as posted" (optionally paste the post's URL) moves it to Posted;
   "Snooze to next free slot" pushes it to the next free slot instead. "Mark
   as posted" is also on the card in the Queue view's "Needs attention" box,
   and both save an edit made while the thread was due before they act, so a
   typo fixed just before pasting is in the record too.

Notifications come from the browser tab, not from a push server: **a tab with
the app must be open** (it can be in the background). Click "Enable
notifications" once — in the sidebar footer, or on the banner of a scheduled
reminder, which carries the same button and explains what happens without
permission. The button is hidden once permission is granted or denied; when it
is denied the footer shows "Notifications are blocked for this site, so
reminders only show while a tab is open. Allow them in the browser settings to
be alerted." (and a browser without the API gets a similar note). Browsers
only allow notifications on a secure origin, so this works on `localhost` and
over HTTPS, not on a plain `http://` address of a remote server. If the live
event stream drops, the page polls `/api/drafts?status=due` every 60 seconds
so a reminder is not lost, and when the stream reconnects it re-fetches the
open draft and the due reminders it may have missed; anything due while no
tab was open shows up as "Needs attention" as soon as one is.

## Deploying

The app is one long-running Node process with its SQLite database and uploaded
images on a disk. It needs a host that keeps a process alive and gives it a
persistent volume. **Vercel, Netlify and similar function platforms do not fit:**
there is no persistent disk, so every drafts database and every uploaded
image would vanish on the next cold start, and there is no process running
between requests, so nothing would be published and no reminder would fire at
slot time (their cron features fire a request, not a loop, and on the free
plans at most once a day). Hosts that do fit: a container platform with
volumes (Fly.io, Railway, Render), or any VPS.

The repository ships the pieces:

| File | What it is for |
|---|---|
| `Dockerfile` | Production image: Node 22 Alpine, runtime dependencies only, the app under `/app`, data under `/data`, runs as the `node` user, health check on `/healthz` |
| `.dockerignore` | Keeps `node_modules`, `data`, `.env` and the tests out of the image |
| `docker-compose.yml` | Any VPS with Docker: `./data` on the host, `.env` for secrets, port published on loopback only |
| `fly.toml` | Fly.io: one always-on machine, a volume mounted at `/data`, HTTPS forced |
| `railway.toml` | Railway: build from the Dockerfile, one replica, `/healthz` probe; attach a volume at `/data` |
| `render.yaml` | Render Blueprint: Docker web service with a 1 GB disk at `/data` and a generated `APP_PASSWORD` |

Three rules hold on every host:

1. **Exactly one instance.** The scheduler runs inside the process, so a second
   replica would publish everything twice. All the configs pin one instance.
2. **Never let the platform stop the process.** `fly.toml` sets
   `auto_stop_machines = "off"` and `min_machines_running = 1` for that reason;
   on Render and Railway keep the service on a plan that does not sleep.
3. **Set `APP_PASSWORD`.** The container binds `0.0.0.0`; without a password
   the API and your X keys are open to anyone who finds the URL (the app prints
   a warning at startup in that case). Leave `ALLOWED_HOSTS` empty on these
   platforms: their proxies already route only your own host names, and the
   local names always pass, which is what the health checks use.

`GET /healthz` answers `200 { "ok": true }` with no password and no Host check
and reveals nothing else; point platform health checks at it.

### Docker (any host)

```bash
docker build -t o_typefully .
docker run -d --name o_typefully -p 127.0.0.1:3000:3000 \
  -v otf_data:/data -e APP_PASSWORD='choose-a-long-password' o_typefully
```

Add `-e X_API_KEY=… -e X_API_KEY_SECRET=… -e X_ACCESS_TOKEN=… -e X_ACCESS_TOKEN_SECRET=…`
to publish via the X API. `config.json` is baked into the image: edit it and
rebuild, or mount your own with `-v $PWD/config.json:/app/config.json:ro`.
With `docker compose up -d` the same happens from `docker-compose.yml`, with
secrets read from `.env` and data in `./data`.

### Fly.io

```bash
fly launch --copy-config --no-deploy     # creates the app from fly.toml; pick a region
fly volumes create data --size 1          # in that region
fly secrets set APP_PASSWORD='choose-a-long-password'
fly secrets set X_API_KEY=… X_API_KEY_SECRET=… X_ACCESS_TOKEN=… X_ACCESS_TOKEN_SECRET=…   # optional
fly deploy
```

Open `https://<app>.fly.dev` and enter any username with that password. The
always-on `shared-cpu-1x` machine with a 1 GB volume is a few dollars a month.

### Railway

Create a service from this repository (it picks up `railway.toml` and the
Dockerfile), add a volume mounted at `/data` (Service → Volumes, or
`railway volume add --mount-path /data`), set `APP_PASSWORD` and the `X_*`
variables, and generate a public domain for the service.

### Render

New → Blueprint → this repository. `render.yaml` creates a Docker web service
on the Starter plan (persistent disks are not available on the free tier)
with a 1 GB disk at `/data` and a generated `APP_PASSWORD` you can read under
Environment. Add the `X_*` variables there to publish via the API.

## Running on a VPS

- Keep `HOST=127.0.0.1` and put a reverse proxy with TLS in front, or set
  `HOST=0.0.0.0` together with `APP_PASSWORD`. Do not expose the port without
  a password; the app has no other authentication.
- `APP_PASSWORD` enables HTTP Basic auth on everything (any username). Basic
  auth sends the password with every request, so use it over HTTPS only.
- Set `ALLOWED_HOSTS` to the public name (`ALLOWED_HOSTS=posts.example.com`,
  several separated by commas, `host:port` to pin a port). A server bound to
  `127.0.0.1` otherwise answers only to `localhost`, `127.0.0.1` and `[::1]`,
  so a proxy that passes the public name through (`proxy_set_header Host
  $host`, as below) gets `421 This server does not answer to the host name
  "posts.example.com"; set ALLOWED_HOSTS=posts.example.com in .env to serve
  it` on every `/api/*` and `/media/*` request. With `HOST=0.0.0.0` and no
  `ALLOWED_HOSTS` any name is served; setting it there restricts them too.
  The local names keep working whatever `ALLOWED_HOSTS` says, so `curl
  http://127.0.0.1:3000/api/status` on the box itself never gets 421.
- Set `timezone` in `config.json` explicitly; a server's system zone is
  usually UTC.
- `.env`, `config.json` and `./data` are resolved from the working directory,
  so set `WorkingDirectory` in the unit.

systemd unit (`/etc/systemd/system/o_typefully.service`):

```ini
[Unit]
Description=o_typefully
After=network.target

[Service]
Type=simple
User=otf
WorkingDirectory=/opt/o_typefully
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning --disable-warning=DEP0040 src/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

The app stops cleanly on SIGTERM (scheduler stopped — the thread being posted
finishes, other claimed drafts go back to the queue — event streams closed,
database closed) and waits at most five seconds.

nginx in front, with the app's own password prompt handling authentication
(and `ALLOWED_HOSTS=posts.example.com` in `.env`, because of the `Host` line):

```nginx
server {
    listen 443 ssl;
    server_name posts.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;   # the app checks it: list this name in ALLOWED_HOSTS
        proxy_buffering off;        # keep /api/events streaming (the app also sends X-Accel-Buffering: no)
        proxy_read_timeout 1h;      # the stream sends a heartbeat every 25 s; do not cut idle connections
        client_max_body_size 16m;   # GIF uploads are allowed up to 15 MiB
    }
}
```

**Backups:** everything is in `DATA_DIR` (`./data` by default): `app.db` with
its `app.db-wal` and `app.db-shm` companions, and `uploads/`. Stop the service
and copy the directory, or use `sqlite3 data/app.db ".backup /path/backup.db"`
while it runs and copy `uploads/` separately.

## Architecture

| File | Role |
|---|---|
| `src/server.js` | Entry point: loads `.env` and `config.json` (parses `ALLOWED_HOSTS`), opens the database, wires everything, prints the banner, handles SIGINT/SIGTERM. Exports `startServer()` for tests |
| `src/api.js` | Express 5 app: security headers, the Host and cross-site guard, optional Basic auth, JSON routes, media upload/serving, SSE endpoint, static files, JSON error handler |
| `src/scheduler.js` | The publish loop described above |
| `src/x.js` | X API v2 client: `POST /2/tweets`, chunked media upload (with the command-style fallback), resumable `publishThread`, a 60 s deadline per request, error messages and hints |
| `src/oauth1.js` | OAuth 1.0a HMAC-SHA1 signing |
| `src/db.js` | `node:sqlite` data layer (drafts, media, migrations) |
| `src/events.js` | Server-Sent Events hub |
| `src/slots.js` | Timezone math (via `Intl`) and slot generation |
| `src/tweet.js` | `---` splitting, twitter-text measuring, thread validation, sanitising untrusted JSON |
| `src/config.js` | `config.json` loading, validation and defaults |
| `public/index.html`, `public/app.js`, `public/styles.css` | Vanilla ES-module front end, no framework, no build step |
| `public/vendor/twitter-text.js` | twitter-text bundled for the browser (`window.twttr`) |
| `scripts/build-vendor.mjs` | Rebuilds that bundle with esbuild |

**Data flow.** The browser talks JSON to `/api/*`; every request body goes
through `normalizeTweets` before it reaches the database, and every state change
is broadcast on `/api/events` so other tabs stay in sync. The scheduler is the
only code that talks to X; it reads due rows from SQLite, publishes through
`src/x.js`, writes the result back and emits an event. All timestamps are epoch
milliseconds in UTC; ids are UUIDs.

**Security headers** on every response: `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer` and a Content Security Policy that limits
scripts and connections to the app's own origin, allows styles from the app
plus inline styles (`style-src 'self' 'unsafe-inline'`), allows `data:` and
`blob:` images for upload previews, and forbids framing. The front end never
uses `innerHTML`.

**Host and cross-site checks** on every `/api/*` and `/media/*` request, before
authentication. The `Host` header must be acceptable: the local names
`localhost`, `127.0.0.1` and `[::1]` always are, on any port; when
`ALLOWED_HOSTS` is set any other name must match an entry (by host name; when
the entry has a port, that too); otherwise, when the server is bound to a
loopback address (`127.x`, `localhost`, `::1`), only the local names are
served; on any other bind address there is no Host check. A mismatch is
`421 { "error": "This server does not answer to the host name \"…\"; set
ALLOWED_HOSTS=… in .env to serve it" }`. This stops DNS rebinding, where a web
page's own host name is re-pointed at 127.0.0.1 to reach the API from the
browser. For methods other than GET, HEAD and OPTIONS a request is also
refused with `403 { "error": "Cross-site requests are not allowed" }` when it
carries a `Sec-Fetch-Site` header that is neither `same-origin` nor `none`,
and with `403 { "error": "Requests from the origin … are not allowed" }` when
its `Origin` header names a different host (name and port) than the request
was sent to. That stops cross-site form posts against the body-less routes
(`/publish`, `/retry`, `/unschedule`, `/duplicate`). `curl` sends neither
header and the app's own same-origin `fetch` passes both checks, so nothing
else changes.

**SQLite schema** (WAL mode, `schema_version` kept in `meta`):

```sql
drafts (id TEXT PK, tweets TEXT /* JSON [{text, media:[...]}] */,
        status TEXT, mode TEXT /* api|manual */,
        scheduled_at, posted_at, reminded_at INTEGER,
        result TEXT /* JSON or NULL */, created_at, updated_at INTEGER)
media  (id TEXT PK, filename, original_name, mime TEXT, size, width, height,
        created_at INTEGER)
meta   (key TEXT PK, value TEXT)
```

`result` is `{ tweetIds, url, error, failedIndex, attempts }` for API items and
`{ manual: true, url }` for items marked by hand. A draft in any status, in
either mode, may carry an API result with a non-empty `tweetIds`: those posts
are on X, stay locked, and the next API attempt continues after them.

**Server-Sent Events** (`GET /api/events`): the server sends `retry: 3000`, a
`hello` event, then `draft.updated { draft }`, `draft.deleted { id }`,
`reminder { draft }`, `posted { draft }` and `failed { draft }` as they happen,
with a `: ping` comment every 25 seconds to keep proxies from closing the
stream.

### HTTP API

All routes are JSON unless noted; errors are `{ error, details? }` with 400 for
validation, 401 when `APP_PASSWORD` is set and the credentials are missing or
wrong, 403 for a cross-site request (see above), 404, 409 for state
conflicts, 413/415 for uploads, 415 `Send the body as application/json` for a
JSON route given a body with another Content-Type (what `curl -d` sends
without `-H 'content-type: application/json'`), 421 for a `Host` the server
does not answer to, and 500 without a stack trace. Unknown `/api/*` paths
answer 404 JSON.

| Route | Body / query | Notes |
|---|---|---|
| `GET /api/status` | | `configured`, `handle`, `timezone`, `slots`, `now`, `schedulerIntervalSeconds`, `missedGraceMinutes`, per-status `counts`, `version` |
| `GET /api/drafts` | `?status=a,b` | `{ drafts }`; queued items by time, then others newest first |
| `POST /api/drafts` | `{ tweets?, mode? }` | 201 `{ draft }`; mode defaults to `api` when configured, else `manual` |
| `GET /api/drafts/:id` | | `{ draft }` or 404 |
| `PUT /api/drafts/:id` | `{ tweets?, mode? }` | 409 when `posted` or `publishing`; 409 `Post 1 is already on X and cannot be changed — duplicate the draft to rewrite them.` (or `Posts 1–k are …`) when the edit changes, removes, reorders or re-images a post that a partial publish already put on X; 400 `Fix these first` with `details[]` when the draft is queued (`scheduled`, `publishing`, `due`) and the new thread is invalid; `mode: "api"` needs keys (400) and on a `due` draft moves it back to `scheduled` at its time. Media references are re-read from the library (`type`, `size`, `url` come from the upload, not the request) |
| `DELETE /api/drafts/:id` | | 204; 409 while `publishing`; removes images only this draft used |
| `POST /api/drafts/:id/duplicate` | | 201 `{ draft }` (new draft, same posts and images, `result` null — the only way to post a partially published thread from the start) |
| `POST /api/drafts/:id/schedule` | `{ at }` (epoch ms, or ISO-8601 — a string without a zone designator is read in `config.timezone`, and only ISO forms are accepted) or `{ nextFree: true }`, `mode?` | Trailing empty posts are dropped (and the thread stored without them) before validation. The time is floored to the whole minute. 400 `Fix these first` with `details[]` when the thread is invalid; 400 `That time is in the past`; 400 `"at" is too far in the future` beyond what `Date` represents; 400 for an impossible date (`2026-02-30`) or a non-ISO string; 409 when no free slot or the status does not allow it. Keeps `result.tweetIds` of a partially published thread |
| `POST /api/drafts/:id/unschedule` | | Back to `draft` (`scheduledAt` cleared); keeps `result.tweetIds`, `failedIndex` and `url` of a partially published thread, so the posts on X stay locked and the next publish continues after them |
| `POST /api/drafts/:id/publish` | | Drops trailing empty posts, validates, needs keys (400), publishes now (continuing after any posts already on X); 200 with the final draft |
| `POST /api/drafts/:id/retry` | | Only `failed` (409 otherwise); drops trailing empty posts, then validates (400 `Fix these first`); resumes from the first unposted post |
| `POST /api/drafts/:id/mark-posted` | `{ url? }` | Only `due`, `scheduled` or `failed` |
| `GET /api/queue` | `?from=ms&to=ms` | Days with `entries: [{ at, kind: "slot" or "custom", draft }]`; range at most 400 days |
| `GET /api/slots/next` | `?exclude=id` | `{ at, taken }` |
| `POST /api/media` | raw image body, `Content-Type`, optional `X-Filename` (URL-encoded) | 201 `{ media: { id, url, name, type, size, width, height } }`; 415 for other types or wrong magic bytes; 413 over the size limit |
| `GET /media/:id` | | The file, `Cache-Control: private, max-age=31536000, immutable` |
| `DELETE /api/media/:id` | | 204; 404 for an unknown id; 409 `A draft still uses this image; remove it from the post first.` while any draft references it (duplicates share images) — such files are removed by the hourly cleanup once nothing references them, up to about two hours later |
| `GET /api/events` | | Server-Sent Events, see above |
| `GET /api/x/verify` | | `{ ok: true, user, note }` or `{ ok: false, error, hint, note }`; 400 without keys; costs one read |

A draft looks like `{ id, tweets: [{ text, media: [{ id, url, name, type, size,
alt? }] }], status, mode, scheduledAt, postedAt, remindedAt, result, createdAt,
updatedAt }`. JSON bodies are limited to 2 MB. `POST /api/drafts` and `PUT`
store posts as sent (a plain draft may hold empty cards); `/schedule`,
`/publish` and `/retry` drop trailing empty posts and save the thread without
them before validating, so only an empty post in the middle (or a thread with
nothing but empty posts) is refused with `Fix these first`.

## Tests

```sh
npm test                                   # every test/*.test.js with node:test
npm run test:e2e                           # Playwright browser flow (see below)
node --disable-warning=ExperimentalWarning --disable-warning=DEP0040 --test test/slots.test.js   # one file
```

Tests use temporary directories or `:memory:` databases and never touch
`./data`; the X client is exercised with an injected `fetch`, so nothing talks to
the network.

`npm run test:e2e` drives the real app in headless Chromium (`test/e2e/browser.test.js`):
it types a thread with `---` separators, checks the counters, reorders posts,
uploads an image, reloads to prove autosave, schedules into the queue, copies to
the clipboard, toggles focus mode, fires a reminder and marks the thread as
posted, and fails on any console error. A second suite runs the app with a
fake X client, on a desktop-sized and a phone-sized page: publishing, a thread
that fails part-way and its locked posts, the trailing-empty-card and
pre-publish checks, keyboard reordering, touch-screen hints and the queue's
"Needs attention" box. It needs the `playwright` package,
which is deliberately not a dependency of this project (it downloads browsers);
without it the suite prints a hint and reports itself as skipped. Either
`npm install --no-save playwright && npx playwright install chromium`, or point
`NODE_PATH` at a global install: `NODE_PATH=$(npm root -g) npm run test:e2e`.
Set `E2E_SHOTS_DIR=/some/dir` to also save screenshots of each view.
`npm run build:vendor` regenerates `public/vendor/twitter-text.js` with esbuild;
the output is committed, so run it only when upgrading twitter-text.

## Limitations

- Images only: no video, polls, quote posts or community posts.
- Single user, single process; one password at most. Not a multi-tenant service.
- Two browser tabs (or two clients) editing the same draft at the same time
  are not reconciled: the last save wins and the other tab quietly adopts it
  ("Saved just now"). There is no version check or merge; keep one editor per
  draft open at a time.
- No analytics, timeline reading or replies; the only reads from X are the
  optional `GET /api/x/verify` check (one billed read) and the
  media-processing status polls during an upload.
- Reminders and the "posted"/"failed" notifications need a browser tab with the
  app open and a secure origin (localhost or HTTPS).
- The X API, its endpoints, permissions and prices change often; the media
  upload flow in particular has changed several times. When something breaks,
  check the error text and hint on the failed item first.
- Times shown in the browser use the browser's zone while slots are defined in
  the configured zone; the footer tells you when they differ.

## Troubleshooting

Errors from X are stored on the failed item as `X API <status> on <METHOD path>:
<detail> — <hint>` and shown in the red banner and the Posted tab.

| Status | Meaning | What to do |
|---|---|---|
| 401 | X rejected the signature or the token | Check the four `X_*` keys in `.env`. The access token must be generated after the app's permissions are set to Read and Write |
| 403 | The app or account may not post | Make sure the app has Read and Write permission and that the developer account is enrolled in a plan that allows writes (pay-per-use or a paid tier). Regenerate the access token after changing permissions |
| 403 with `duplicate content` in the detail | X already has a post with this exact text — a previous attempt went through but its response never arrived | The hint reads `X rejected this post as a duplicate of one you already published. Change the text, or mark the thread as posted.` Check your profile; if the post is there, mark the thread as posted (or change the text) instead of retrying |
| 402 | X is asking for payment | Enroll in pay-per-use or add credits in the developer console |
| 429 | Rate limited | Try again later; the hint gives the reset time from `x-rate-limit-reset`, or, when X's 24-hour post cap for your account or app is used up (`x-user-limit-24hour-remaining` / `x-app-limit-24hour-remaining: 0`), that cap's own reset time, which can be up to a day later |
| 0 | No response from X | `X API request timed out after 60s on POST /2/tweets`: the connection stalled; Retry continues from that post. `X API request failed on …: fetch failed: getaddrinfo ENOTFOUND api.x.com` (or `ECONNREFUSED`, a certificate error): DNS, firewall or proxy — Node's `fetch` does not use `HTTPS_PROXY` |

Other messages you may see:

- `X API keys are not configured. Switch this post to reminder mode or add keys to .env.`
  — an API-mode item came due on a server without keys. Reschedule it in
  reminder mode, or add the keys and retry.
- `Missed its slot: the server was not running at … more than N minutes late.`
  — the process was down when the slot passed. Retry publishes it now;
  Reschedule picks a new time; set `missedGraceMinutes` to `0` to post late
  items automatically.
- `Post 2: image "…" is missing on disk` — the file under `data/uploads/` is
  gone. Remove the image from the post (or attach it again) and retry.
- `Fix these first` with a list — the thread is invalid: an empty post, over
  280, more than 4 images, a GIF with company, more than 25 posts. The editor
  shows the same list before a Schedule or Publish now dialog opens; an empty
  card at the end of the thread is dropped, not reported.
- `Already posted — duplicate it to edit.` — posted items are read-only.
- `Post 1 is already on X and cannot be changed — duplicate the draft to
  rewrite them.` (409) — the first posts of this thread went out in a publish
  that failed part-way; they are locked. The editor restores their text and
  keeps your other edits; rewrite them in a duplicate. The banner says `Posts
  1–k are already on X and are locked. Publishing continues from post k+1.
  Duplicate the thread to start over.`
- `Only failed posts can be retried (this one is scheduled)` (409) — Retry is
  for `failed` items; a queued one is already on its way.
- `A draft still uses this image; remove it from the post first.` (409) —
  `DELETE /api/media/:id` while a draft (a duplicate, say) still shows it.
- `Send the body as application/json` (415) — a JSON route got a body with
  another Content-Type; with curl add `-H 'content-type: application/json'`.
- `This server does not answer to the host name "…"; set ALLOWED_HOSTS=… in
  .env to serve it` (421) — the request's `Host` is not one the server
  serves: list it in `ALLOWED_HOSTS`, or open the app as `localhost` /
  `127.0.0.1` (those always work). Also what a DNS-rebinding page gets.
- `Cross-site requests are not allowed` or `Requests from the origin … are
  not allowed` (403) — a state-changing request came from another site
  (`Sec-Fetch-Site` or `Origin` says so). The app's own pages never trigger
  it; a script of yours should send no `Origin`, or the app's own.
- `Images must be 5 MB or smaller; GIFs 15 MB` (413) or `The file content is not
  a valid PNG image` (415) — the upload was refused before touching disk.
- `No free slot found — add slots to config.json` — no slot is free in the next
  year, or `slots` is empty.
- `"at" is too far in the future` (400) — `POST /schedule` got a time beyond
  what `Date` can represent; an impossible date (`2026-02-30`) or a non-ISO
  string such as `March 8, 2026 09:00` is refused with 400 too.
- The server refuses to start with `Config file …` — the message names the
  invalid field in `config.json` and the range it accepts; `ALLOWED_HOSTS
  entries must be "host" or "host:port"` is the same check for `.env`.
- "Notifications are blocked for this site, so reminders only show while a
  tab is open. Allow them in the browser settings to be alerted." in the
  sidebar footer (or the toast "Notifications are blocked. Allow them in the
  browser settings." after clicking the button) — allow notifications for the
  site in the browser, then reload.

## License

`public/vendor/twitter-text.js` is a bundle of
[twitter-text](https://github.com/twitter/twitter-text) 3.1.0, Copyright
Twitter, Inc., licensed under the Apache License, Version 2.0; the license
banner is kept at the top of the file and the source is `npm run build:vendor`.
The application code itself is marked `private` and `UNLICENSED` in
`package.json`, meaning no license has been chosen for it yet.
