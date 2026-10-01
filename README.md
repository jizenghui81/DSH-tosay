# dsh-stage-speak 🔊

Makes DeepSeek Harness speak its progress in one plain sentence **every time a stage completes** — instead of reading the raw reply from top to bottom.

> You're doing something else, and your headphones say: "The login bug is fixed and the tests pass; one edge case is still uncovered."

## How it differs from "reading the final reply"

| | Reading the final reply (dsh-speak, etc.) | This plugin |
|---|---|---|
| What it says | The raw reply, read aloud after stripping Markdown | **The model condenses recent work into 1–2 spoken sentences** |
| When it speaks | Turn end | **Eight kinds of stage boundaries**: kickoff feedback, silence heartbeat, cumulative steps, todo completed, turn end, error, waiting for your approval, goal change |
| Long text | "This announcement is long — please read it yourself" | The summary is one sentence by design, so the problem doesn't exist |
| When busy | Queued | Normal announcements are **coalesced into the latest one**; urgent ones **interrupt** |

## How it works

```
session/event ──► activity.noteEvent      decide "is this a stage boundary?"
                     │
                     ├─ throttleMs quiet-period coalescing + minGapMs minimum interval
                     ▼
               summarize.summarize        model condenses to one sentence; falls back to rule summary on failure
                     ▼
               engine.speak               serialized announcements: coalesce when busy, jump the queue when urgent
```

The five functional layers are independent and individually replaceable (`lib/index.js` is the orchestration entry point):

| File | Responsibility | Dependencies |
|---|---|---|
| `lib/activity.js` | Activity buffer + stage boundary detection | None (pure functions, unit-testable offline) |
| `lib/summarize.js` | Summarization: LLM first, rule-based fallback | `llm` service (optional) |
| `lib/engine.js` | Serial speech queue + platform argv + engine path resolution | `subprocess` service |
| `lib/clean.js` | Markdown → speakable text | None |
| `lib/journal.js` | Announcement audit log | `node:fs` |

**Bottom line**: any step that fails only writes a log entry. Announcements are a nice-to-have and never affect the session.

## Installation

**Install straight from GitHub** (pure ESM, no build step, so no pnpm build authorization is needed):

```bash
dsh plugin --profile <your profile> add github:jizenghui81/DSH-tosay
```

**Install from a local checkout**:

```bash
dsh plugin --profile <your profile> add /path/to/dsh-stage-speak
```

**A DSH restart is required** after installing: new bundle rows are read at boot, and ESM caches by URL.
Sessions that already existed before the install receive no events either; only after a restart, once all mounts are rebuilt, does it work.

### Requirements

- DSH `>= 0.1.7-rc.1` (`dsh.engines` in `package.json` declares the exact range)
- macOS: the built-in `say` — **works out of the box, no key of any kind**
- Windows: `powershell` + `System.Speech` (Windows 11 ships natural voices; Windows 10 needs NaturalVoiceSAPIAdapter)

## Configuration

There are two entry points for changes, and both write the same configuration: the DSH settings page (this plugin exports a Config with `volatile()`), or a top-level row in `~/.dsh/profiles/<profile>/cordis.patch.yml`.

```yaml
- id: dsh-stage-speak
  name: dsh-stage-speak
  config:
    logFile: ~/.dsh/dsh-stage-speak.log
    voice: ''
```

⚠️ **Layers and overrides**: the effective configuration is layered as bundle patch → profile patch → `$DSH_HOME/cordis.patch.yml` → `--patch`, and **later layers win per row, and a patch replaces the entire `config` of the target row — there is no deep merge**. So when you write a top-level row with the same id in your profile, that row's config **replaces the in-package defaults wholesale** — if you want to keep a default, restate it in your own row.

### Options

| Option | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Master switch |
| **What to announce** | | |
| `announceTurnEnd` | `true` | Turn end. Every turn-end announcement **starts with a deterministic closer** (see below) |
| `announceTurnEndOnChat` | `true` | Pure-chat turns (zero tool calls) skip the summary but **still speak the closer** — the end signal must never be missing. Set `false` to restore full silence for those turns |
| `announceKickoff` | `true` | Kickoff feedback: on receiving a new task, immediately say "got it + here's how I'll approach it" |
| `kickoffThrottleMs` | `400` | Dedicated short throttle window for kickoff feedback — "immediately" must not be dragged down by the default 2500ms |
| `kickoffMinTaskChars` | `4` | Tasks shorter than this character count are not spoken (e.g. "continue") |
| `silenceHeartbeatMs` | `30000` | Silence heartbeat: if the turn is still running and nothing has been announced for this long, report progress once (0 = off). **There must be real activity during the window**; nothing is announced when it is genuinely stuck |
| `announceTodoCompleted` | `true` | A todo item transitions to completed |
| `announceApprovals` | `true` | Waiting for your approval (high priority, interrupts) |
| `announceGoalChange` | `false` | Goal change |
| `includeSubagents` | `false` | Whether subagent sessions are announced too (keep it off when running several subagents in parallel) |
| `toolErrorIgnoreCodes` | `["FS_NOT_OBSERVED","FS_STALE_VERSION"]` | Filter out tool errors that are "self-healing by design" by error code |
| `toolErrorPriority` | `normal` | `high` restores "interrupt on error" |
| **Pacing** | | |
| `throttleMs` | `2500` | Quiet period; consecutive events are coalesced into a single announcement |
| `minGapMs` | `6000` | Minimum interval between two announcements |
| `stageToolCalls` | `8` | Announce long-task progress after this many accumulated tool calls |
| `turnEndMinToolCalls` | `1` | How many steps a turn must have taken to be worth speaking (0 = speak even for pure chat) |
| **Summary** | | |
| `useLlmSummary` | `true` | Turn it off to use rule-based summaries only |
| `maxChars` | `120` | Character limit for a single spoken announcement |
| `summaryProvider` / `summaryModel` | `''` | Empty = use the session's own model routing |
| `llmTimeoutMs` | `15000` | Summary timeout; on timeout it falls back to the rule summary |
| **Voice** | | |
| `voice` | `''` | Empty follows the system default speech voice; a name pins it |
| `rate` | `0` | macOS: words per minute (about 175 by default); Windows: SAPI `-10..10` |
| `volume` | `100` | Windows only |
| `engine` | `''` | Empty = macOS `say` / Windows `powershell`; `./x` resolves relative to the **package root**; anything else resolves via PATH |
| **Operations** | | |
| `cwd` | `''` | Working directory of the speech subprocess; empty = the user's home directory (the contract requires it) |
| `graceMs` | `4000` | Grace period after the subprocess exits |
| `speakTimeoutMs` | `120000` | Maximum duration of a single spoken sentence, so one stuck engine cannot hold the queue |
| `logFile` | `''` | Announcement audit log (tab-separated, appended line by line). Supports the `~/` prefix |
| `logAnnouncements` | `false` | Also write summaries to the host log |

The three path fields `logFile` / `engine` / `cwd` support the `~/` prefix (expanded by the plugin) — which is why the in-package defaults work across machines.

### Deterministic turn-end closer

Every turn-end announcement **begins with a closer whose text is hard-coded in the plugin, never generated by the model**:

| Turn end reason | Closer |
|---|---|
| `completed` | 这一轮结束了。 |
| `error` | 这一轮报错中断了。 |
| `aborted` | 这一轮被中断了。 |

Then the summary follows: `这一轮结束了。{summary}`.

**Why it is not left to the LLM.** Auditing 30 real turn-end announcements: only 4 carried any closure wording,
and the wording differed every time ("这轮任务完成" / "这轮结束了" / "这一轮做完了") — while 10 of 156 *mid-turn*
progress announcements used the same kind of vocabulary. With both sides sharing words, a listener has no
reliable cue for "this turn is over". A model-generated signal is a random event; a hard-coded one is not.

**Why the closer goes first, not last.** `truncateForSpeech` keeps only a **prefix window**
(`text.slice(0, maxChars)`, then backs up to the last sentence end). Anything at the tail of a long summary
gets cut — so a trailing closer would randomly disappear exactly when the summary is long.

**Consequence**: even when the summary fails or is empty, the closer is still spoken. That path previously
logged `dropped` and stayed silent, which is the one place a missing end signal is least acceptable.

### The seven kinds of log lines

Each `logFile` line is `timestamp <TAB> category <TAB> detail`:

| Category | Meaning |
|:--|:--|
| `ready` | Plugin mounted successfully (one line at startup). **This line missing = the plugin was never loaded** |
| `boundary` | A stage boundary was detected |
| `announce` | The summary was handed to the announcement queue — **note: this only means "it entered the queue", not "it played"** |
| `coalesced` | The boundary was coalesced into an already-pending boundary (within the same-priority window) |
| `dropped` | The summary was empty, or the plugin was unloaded/reloaded |
| `pipeline-error` | The announcement pipeline threw, with the error message |
| `speak-error` | The speech process failed to start or run, with the original error |

Debug order: `ready` → `boundary` → `announce` → `speak-error`. One glance shows which link broke.

> **Channel contract**: **every detected `boundary` must eventually leave behind
> exactly one of `announce` / `coalesced` / `dropped` / `pipeline-error`.**
> The unit tests assert `boundary count == announce + dropped + coalesced + pipeline-error` directly.
>
> Why this contract exists: before it was fixed, coalesced and dropped boundaries were **silent returns that left no trace**,
> so "detected but never spoken" was **impossible to attribute** from the logs.

> ⚠️ **Do not use `pgrep` to verify whether speech happened.** Measured from DSH's bash tool,
> `pgrep -x say` cannot see processes spawned by DSH's subprocess service (47 consecutive heartbeats
> covering the whole window still produced zero hits), while in the same environment
> `pgrep -x WindowServer` and `Finder` are visible as usual. To judge whether audio played, look at the
> `speak-error` line, or simply listen.

## Cloud voice engine (optional)

The default is system speech: **zero configuration, fully local, no key required**. For better audio quality, you can enable the MiniMax engine shipped with the package:

```yaml
engine: ./engine/minimax-speak.sh
```

A path starting with `./` resolves relative to the **package root**, so this configuration holds on any machine with the plugin installed and contains neither a username nor an absolute path.

| Item | Value |
|:--|:--|
| Key source | The `MINIMAX_API_KEY` environment variable (preferred) or `api_key` in `~/.mmx/config.json` — **both outside the repository** |
| Default model | `speech-2.8-turbo` (change `~/.dsh/tools/minimax-model.txt`; no restart needed) |
| Default voice | `Chinese (Mandarin)_Warm_Girl` (change `~/.dsh/tools/minimax-voice.txt`; no restart needed) |
| Failure fallback | Network down / unpaid balance / rate limiting / any exception → **automatically falls back to system `say`**, guaranteeing audio |
| Cache | `~/.cache/dsh-stage-speak/<hash>.mp3`, hashed by text + model + voice; automatically pruned above 300 entries |
| Log | `~/.dsh/logs/minimax-speak.log` (`ok` / `cache-hit` / `fallback` / `prune`; `ok` lines end with the model actually used) |

Configuration precedence (high → low): environment variable → `~/.dsh/tools/minimax-{model,voice}.txt` → **in-package** `engine/minimax-{model,voice}.txt` → built-in default.

### ⚠️ Two gotchas you must know

1. **The plugin injects `-v <voice>`** — the engine-side argv looks like `<wrapper> -v <voice> "text"`.
   The wrapper uses `${!#}` **to take the last argv as the text** and ignores every flag. Don't break that convention when changing engines.
2. **MiniMax returns HTTP 200 even on error** — you must read `base_resp.status_code`, otherwise you write out a bogus empty mp3 and fail silently. The wrapper already validates this.

### Redaction

Announcement text **leaves this machine**. When needed, copy `engine/minimax-redact.txt.example` to
`~/.dsh/tools/minimax-redact.txt` and fill in one `original=replacement` pair per line.
⚠️ This is a **global string replacement**; **do not put short words or bare numbers in it** (e.g. `325` would corrupt normal text).

## Troubleshooting

| Symptom | Cause / action |
|---|---|
| Installed but nothing happens at all | Restart DSH first. New bundle rows are read at boot; already-existing sessions never receive the new plugin's mount |
| Source changes don't take effect | ESM caches by URL. Code changes require reloading the plugin or a restart |
| No audio at all | Check whether `logFile` is being written. A `boundary` with neither `announce` nor `coalesced`/`dropped`/`pipeline-error` → the event never arrived; a non-empty `speak-error` → a problem on the engine side |
| Too chatty | Raise `minGapMs` / `stageToolCalls`, turn off `announceTurnEnd` |
| Saying the wrong thing | Set `logAnnouncements: true` and check the host log, or read the text actually spoken in `logFile` |
| Cloud engine not taking effect | Check `~/.dsh/logs/minimax-speak.log` for `fallback` lines — the most common cause is a missing key |
| **Long silence (minutes) with no announcement** | Look at the `boundary` lines **inside** the gap. **None at all** → the decision layer never fired (the "no activity" guard suppressed it); if there *was* activity, that is the v1.2.1 in-flight fix — see below. `boundary` present but no `announce`/`coalesced`/`dropped`/`pipeline-error` → broken channel contract, please report it |

### Why a blocking tool call used to go silent (fixed in v1.2.1)

Measured on a real session (2026-10-01): the assistant issued `bash {"command":"sleep 180"}`.
A blocking call emits **no session events while it is in flight** — no `tool/result` (it has not returned),
no `assistant/message` (the model is not generating). The heartbeat guard only looked at the activity
buffer and a counter that the **previous announcement's `drain()` had just cleared**, so it concluded
"no activity" and suppressed **10 consecutive ticks** — **187 seconds of total silence** while the task
was in fact progressing (two background subagents delivered results in the middle of it).

v1.2.1 fixes it by tracking **in-flight tool calls** as a first-class activity signal that `drain()`
never clears, and by feeding the summarizer an honest line (`still running bash (sleep 180…), 94s elapsed`)
when the buffer is empty.

**The guard is deliberately still strict**: when nothing is in flight and no events arrive, the plugin
stays silent — it will not invent "working hard" to fill a gap. Consequence you should know:
a single **very long model generation** (minutes with no tool call, no message) still has no signal to
report, and remains a known silent window.

## Development

```bash
pnpm install          # install devDependencies (real @deepseek-ai/* packages)
npm test              # 72 offline unit tests, no DSH required
npm run check-secrets # must run before committing: secrets and privacy guard
npm run replay -- <session log> --verbose   # replay a real session
```

`test/offline.mjs` runs the whole pipeline against a fake cordis context and a fake subprocess, covering boundary detection, debouncing, priority queue-jumping, LLM degradation, subagent filtering, queue coalescing, unload cleanup, and the guards for kickoff feedback and the silence heartbeat, plus two contract assertions: **`SubprocessSpawnSpec` conformance on every spawn** and **channel trace completeness**.

## Security

**This repository contains no secrets**, and writing secrets into the repository is not accepted. Run `npm run check-secrets` before committing;
the guard reads this machine's real secrets and real username into memory and compares them character by character to confirm none of them appear anywhere in the repository.
See [SECURITY.md](./SECURITY.md) for details.

## License

MIT, see [LICENSE](./LICENSE).
