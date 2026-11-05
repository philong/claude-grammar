# grammar

[![test](https://github.com/jaklimoff/claude-grammar/actions/workflows/test.yml/badge.svg)](https://github.com/jaklimoff/claude-grammar/actions/workflows/test.yml)

A Claude Code plugin that checks the English of each prompt you send and shows the fixes right under it. It can check another language instead, a few you choose, or each prompt in whatever language it's written in: see [Other languages](#other-languages).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/jaklimoff/claude-grammar/media/tour-dark.gif">
  <img alt="A tour in six scenes. A prompt's mistakes are struck through in red under it, with the fixes in green and why. A second line says how a native speaker would put it. /grammar stats lists mistakes by kind and the fixes you repeat. /grammar review draws a summary card with bars, then habits to work on with your own fixes as examples. /grammar ignore add keeps your jargon unflagged and /grammar help shows the settings. tools/import-history.ts fills the history from past prompts." src="https://raw.githubusercontent.com/jaklimoff/claude-grammar/media/tour-light.gif">
</picture>

If English is not your first language, you write a lot of it in your prompts, and nobody tells you where it goes wrong. Claude understands you anyway, so the same mistakes stay. With this plugin, Haiku proofreads each prompt after you send it, and a dim line under that prompt shows what to fix: the wrong words struck through in red, the fixes in green, and a few words on why. When a sentence still sounds off once the grammar is fixed, a second line shows how a native speaker would say it.

Over time it keeps your fixes, so `/grammar stats` shows the mistakes you make most and `/grammar review` turns them into a few rules written for you, with your own mistakes as the examples.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/jaklimoff/claude-grammar/media/cost-brand-dark.png">
  <img alt="What the grammar check costs: a 50-prompt session is $0.004 to $0.02. Per check: a clean prompt $0.00007 (602 tokens in, 21 out); 3 mistakes $0.0003 to $0.0005 (613 in, 425 to 799 out); 5+ mistakes $0.0002 to $0.0003 (638 in, 239 to 541 out). Claude Haiku 5.5 at low effort, API prices, measured 2026-10-30 on version 1.2.0." src="https://raw.githubusercontent.com/jaklimoff/claude-grammar/media/cost-brand-light.png">
</picture>

How it was measured: [Privacy and cost](#privacy-and-cost).

## Install

```
/plugin marketplace add jaklimoff/claude-grammar
/plugin install grammar@grammar
```

Or in one step from the shell (v2.1.292+):

```
claude plugin install grammar --marketplace jaklimoff/claude-grammar
```

## Use

Send prompts as usual. The fixes show under each one a few seconds later, while Claude works. Each prompt keeps its own lines, so scrolling back shows them all for the session.

A prompt with no mistakes gets a green `✓` before it instead. From the third clean prompt in a row, a line under it counts them (`3 in a row`); a prompt with a fix or a native-speaker line starts the count over. The `clean` setting turns this off.

```
✓ ❯ please deploy it to staging
    5 in a row
```

| Command | What it does |
|---|---|
| `/grammar help` | Lists the commands and shows what's on now: the check, the natural line, the model and the limits. |
| `/grammar` | Turns the check on or off. |
| `/grammar on`, `/grammar off` | Sets it. `on` also resumes checks paused after 3 failures in a row. |
| `/grammar natural on\|off` | Switches only the native-speaker line. |
| `/grammar ignore add <words>` | Never flags these words. Separate phrases with commas: `pull request, kubectl`. |
| `/grammar ignore rm <words>` | Flags them again. |
| `/grammar ignore` | Shows the ignore and skip lists and the files they're in. |
| `/grammar stats [period] [language]` | Your mistakes by kind, the fixes you keep repeating, and whether you're making fewer. No model call. |
| `/grammar review [period] [language]` | A summary card, then the 3 to 5 habits behind most of your mistakes from one Sonnet call, with your own fixes as examples. Needs 20 kept fixes in the period. |
| `/grammar ask [period] <question>` | Ask Sonnet anything about your writing, with your kept fixes and this session's latest fixes at hand. One call. |
| `/grammar ask list` | What follow-ups remember: the last 5 asks and reviews of the session. |
| `/grammar ask clear` | Forgets them, so the next ask starts fresh. |
| `/grammar ask memory on\|off` | Remembers asks for follow-ups, or not. |
| `/grammar history on\|off` | Keeps your fixes, or stops keeping new ones. |
| `/grammar history clear` | Empties the history file. |
| `/grammar history` | Shows whether it's on, how many fixes are kept, and where. |

A period is `7d` or `30d` (the last N days, today included), or `since 2026-10-01`. Without one, `stats`, `review` and `ask` cover everything kept. Days are UTC dates.

The on/off switches are settings, so they last across sessions and show under `/config` too.

### In Cowork

Cowork tasks in the desktop app load the plugin but draw nothing from it: no line under the prompt, no band, no toast, and `/grammar` is rejected as an unknown skill (Claude's side: [anthropics/claude-code#101213](https://github.com/anthropics/claude-code/issues/101213), [#106320](https://github.com/anthropics/claude-code/issues/106320); found by [@ArnauMontagud](https://github.com/ArnauMontagud) in [#3](https://github.com/jaklimoff/claude-grammar/issues/3)). So there the prompt waits for its check, a second or two, and when it has mistakes Claude is asked to end its reply with them:

```
Paris! Have a great trip.

✎ i want know it → I want to know it (missing "to")  ·  what i planing → that I'm planning (verb form)
↳ I want to know it for the trip I'm planning.
```

A clean prompt adds nothing. The fixes become part of the conversation, so Claude sees them too. Nothing is kept for `/grammar stats` from Cowork: the task runs on a machine of its own, and `/grammar` can't run there. A check that takes over 15 seconds or fails lets the prompt go without one; after 3 failures in a row the checks pause for the session. The `cowork` setting (on by default) turns this off. A Cowork task is told apart from `claude -p` and the SDK, which draw nothing either, by `CLAUDE_CODE_ENTRYPOINT`, which names Cowork there.

## Settings

Under `/config`, or in `settings.json` under `pluginConfigs` → `grammar@grammar` (the plugin as you installed it: `grammar@<marketplace>`) → `options`:

| Setting | Default | What it does |
|---|---|---|
| `enabled` | `true` | Checks your prompts. Same as `/grammar on\|off`. |
| `natural` | `true` | The native-speaker line. Same as `/grammar natural on\|off`. |
| `model` | `haiku` | `haiku` or `sonnet`. Sonnet catches more and costs more. |
| `effort` | `low` | `low`, `medium` or `high`. |
| `language` | `English` | The language your prompts are checked in, named in English: `French`, `German`, `Japanese`... Several, separated by commas (`English, French`), check each prompt in whichever of them it's in. Prompts in other languages are skipped. `auto` checks each prompt in whatever language it's written in. See [Other languages](#other-languages). |
| `dialect` | `any` | For English: `any` accepts US and UK spelling. `us` or `uk` flags the other one's spellings. |
| `min_words` | `2` | Shorter prompts (`ok`, `yes`, `continue`) aren't checked. |
| `max_chars` | `6000` | How much of a long prompt is checked and sent, cut at a word boundary. |
| `icons` | `true` | Terminal only: off draws plain characters for terminals without a Nerd Font. The desktop app always draws plain characters. |
| `show_why` | `true` | The short reason after each fix. |
| `desktop` | `band` | `band`, `line`, `toast` or `off`. The desktop app doesn't draw the line under the prompt: `band` shows the newest check in color in a band above the prompt box (with a Hide button) and also adds the dim transcript line, `line` only the transcript line, `toast` shows them briefly as a toast, `off` shows nothing there. |
| `clean` | `true` | A green `✓` before a prompt with no mistakes, and from 3 in a row, how many in a row. In the desktop app it shows as `desktop` says: in the band, as a transcript line (`line` only), or as a short toast. |
| `history` | `true` | Keeps each fix for `/grammar stats` and `/grammar review`. Same as `/grammar history on\|off`. |
| `ask_memory` | `true` | `/grammar ask` remembers the last 5 asks and reviews of the session for follow-ups. Same as `/grammar ask memory on\|off`. |
| `cowork` | `true` | In a Cowork task, which shows no plugin output, the prompt waits for its check and Claude ends its reply with the fixes. Off, Cowork prompts aren't checked. See [In Cowork](#in-cowork). |
| `endpoint` | empty | An OpenAI-compatible API to use instead of Claude's models, local or not. See [Another model](#another-model). |
| `endpoint_model` | empty | The model to ask the endpoint for. Empty: its default. |
| `endpoint_key` | empty | The endpoint's API key, sent as a Bearer token. Kept in secure storage, not `settings.json`. |

### Another model

Set `endpoint` and the checks, `/grammar review` and `/grammar ask` all go to that OpenAI-compatible API (`/v1/chat/completions`) instead of Claude's models:

| Server | `endpoint` | `endpoint_model` | `endpoint_key` |
|---|---|---|---|
| llama.cpp | `http://localhost:9931` (its default port) | empty for the one model it serves, else an id from `/v1/models` | |
| LM Studio | `http://localhost:1234/v1` | the loaded model's id | |
| Ollama | `http://localhost:11434/v1` | a pulled model's name | |
| OpenRouter | `https://openrouter.ai/api/v1` | a model id from openrouter.ai/models | `sk-or-...` |

`model` and `effort` then don't apply. Thinking is turned off where the server supports llama.cpp's `chat_template_kwargs`; a server that refuses it, `max_tokens` or `temperature` gets the request again without it. A local model needs to follow the JSON answer format well: Gemma 4 26B does. A check that can't be read shows as `no grammar check` under the prompt, like any failed check.

## Ignore and skip lists

Put a `grammar.json` in your Claude Code folder (`~/.claude/grammar.json`, or `$CLAUDE_CONFIG_DIR/grammar.json`) for every project. Put one in a project's `.claude/grammar.json` for that project only. Both files are read on every prompt, and their lists are combined.

```json
{
  "ignore": ["kubectl", "pnpm", "pull request", "/^[A-Z]+-\\d+$/"],
  "skip": ["^(ok|yes|continue|go on)\\b", "^deploy "],
  "history": false
}
```

- **`ignore`:** words and phrases never flagged, matched as whole words in any case. Plain words are also passed to the model so it leaves them alone. Wrap an entry in slashes for a regex, which is matched against each fix.
- **`skip`:** regexes, case-insensitive. A prompt that matches one isn't checked or sent.
- **`history`:** `false` keeps no fixes while you work in that project, even with the setting on. Use it in a project's file for work that should leave no trace.

`/grammar ignore add|rm` edits the global file and keeps everything else in it. A file that doesn't parse is skipped, with one notice.

## What it checks

- **Checked:** spelling, grammar (tense, agreement, articles, prepositions, word order), a wrong word, a missing word.
- **Left alone:** lowercase, punctuation style, dropped apostrophes (`lets`, `dont`), slang and short forms (`smth`, `pls`, `btw`), code, paths, logs and pasted text.
- **Only a `✓`:** a clean prompt (with `clean` on).
- **No line at all:** a prompt that is not in your `language` (with `auto`, one with no prose, only code), slash commands, and anything in `claude -p` or the SDK, where nothing would show it. In a Cowork task the fixes come at the end of Claude's reply instead: see [In Cowork](#in-cowork).

The native-speaker line is rare on purpose. It shows only when a sentence is clearly unidiomatic even with the grammar fixed, not for style.

## Other languages

The `language` setting picks what is checked:

- **`English`** (the default): as before 1.7, word for word the same system prompt. Prompts in other languages are skipped and cost nothing.
- **Another language** (`French`, `German`, `Brazilian Portuguese`...): only prompts in that language are checked; the rest are skipped.
- **A list** (`English, French`): each prompt is checked in whichever of them it's in, and prompts in any other language are skipped, so their fixes stay out of your history. The model tells which language a prompt is in, so a skipped prompt is still a model call. With English in the list, `dialect` applies to the English prompts.
- **`auto`**: every prompt is checked in its own language, so you can switch from prompt to prompt. Prompts with no prose, only code, are skipped. Each prompt is a model call, whatever its language.

Outside English, the reason under each fix is in the prompt's language, and the native-speaker line is in that language too. Words from another language mixed in (English technical terms in a French prompt, say) are left alone. Prompts in Chinese, Japanese or Thai count about one word per two characters for `min_words`, so `好的` is skipped like `ok`.

Each kept fix and day count remembers its language, and the history keeps them apart. `/grammar stats` and `/grammar review` cover one language: the one you name (`/grammar stats 7d french`, `/grammar review french`), else your `language` setting (with a list, the one of them you've written the most prompts in), else the one you've written the most prompts in. Stats name the others kept (`Also kept: French (12 fixes)`). The review writes its advice in the language it reviews. `/grammar ask` sends the fixes of every language, grouped by language, and answers in the language you ask in. A history from before 1.7 counts as English.

## Your mistakes over time

Each checked prompt adds to `grammar-history.json` in your Claude Code folder (`~/.claude/`, or `$CLAUDE_CONFIG_DIR`): its fixes, each with the words, the fix, the reason, the kind of mistake and the time, plus a count per day of prompts checked and prompts with a fix. The first session that keeps fixes starts with a notice naming the file; it shows once. Each fix and day count also notes its language when it is not English. The model labels each fix with one kind: spelling, tense, agreement, article, preposition, word order, wrong word, missing word, extra word or other. Days are UTC dates, the same on every machine. If two sessions write the file at the same moment, at most one entry is lost. If a write is cut short, the lines that still parse are kept and the next check writes the file whole again; the day counts come first in the file, so what a cut loses is the newest fixes.

Not kept: the prompt itself, the native-speaker line (it is a whole sentence), fixes longer than 60 characters, fixes that only change case or spacing, fixes that look like code or a path (`/`, `_`, brackets, `file.ts`), and fixes for words on your ignore list. The file keeps 90 days (today and the 89 before, UTC) and at most 2000 fixes, so it stays under about 300 KB.

```
/grammar stats
Everything kept (Sep 21 – Oct 30): 240 prompts checked, 100 with a fix (42%), 63 fixes kept.
Fewer than before: 39% of prompts had a fix in the last 30 days, 50% in the 30 before.

By kind:
  article         14   22%  e.g. in separate module → in a separate module
  extra word      14   22%  e.g. should to move → should move
  preposition      8   13%  e.g. depend from → depend on
  ...

Repeated fixes:
  ×6   depend from → depend on
  ×5   explain me → explain to me
  ...
```

With a period, the trend compares it with the stretch just before it of the same length: `/grammar stats 7d` says "Fewer than the 7 days before (71%)". Without one, it compares the last 30 days with the 30 before.

`/grammar review` sends the period's grouped fixes (`6× depend from → depend on (preposition; verb takes on)`, one line each, most frequent first, at most 300 lines) to Sonnet once. In the terminal it draws a card with the period's figures, then the habits Sonnet found, each example struck through in red with the fix in green, the same way as under a prompt:

```
╭────────────────────────────────────────────────────╮
│ Grammar review · last 7 days (Oct 24 – Oct 30)     │
│ 142 prompts · 59% with a fix · 119 fixes           │
│ ↓ Fewer than the 7 days before (71%)               │
│                                                    │
│ spelling     ███████████████  38%                  │
│ article      █████████░░░░░░  23%                  │
│ missing word ████░░░░░░░░░░░  11%                  │
│                                                    │
│ most repeated  explain me explain to me  ×4        │
╰────────────────────────────────────────────────────╯
1. Dropping articles (a, an, the) before singular nouns. A singular countable noun almost always needs a, an,
or the in front of it.
   spawn fable subagent spawn a fable subagent
   in future in the future
2. ...
sonnet, from 119 fixes
```

The row also holds the same as plain text, which is what the model sees in the conversation and what surfaces that don't draw the card show. The card's figures are never sent in the review's call. After a resumed session, earlier reviews show as that plain text.

When your account can't use Sonnet, it asks the model in your `model` setting instead. Words you add to the ignore list later drop out of both commands, and stats count fixes the same however you capitalized or spaced them.

### Ask about your English

`/grammar ask` takes any question about your English (or the other languages you write in) and answers it from one Sonnet call, using your own fixes as examples when they show the point:

```
/grammar ask why do I keep dropping "the"?
/grammar ask 30d which prepositions do I mix up most?
/grammar ask is "I have done it yesterday" wrong?
```

The call sends the question, the period's grouped fixes (the same lines as `/grammar review`; no period means everything kept), and the fixes from this session's latest prompts, at most 10. It needs no minimum of kept fixes: with few or none, the answer says so and stays general. Examples come out like a review's, struck through in red with the fix in green.

Follow-ups work. The session remembers the last 5 asks and reviews, and each ask sends them along, so `/grammar ask explain the second one more` after a review knows which one you mean. The line under each answer says what it remembered:

```
sonnet, from 63 fixes · remembered 2 earlier · /grammar ask list, clear
```

- `/grammar ask list` shows what is remembered, oldest first.
- `/grammar ask clear` forgets it; the next ask starts fresh.
- `/grammar ask memory off` (or the `ask_memory` setting) forgets it and stops remembering, so each ask starts fresh.

What is remembered lives in the session's memory only and is gone when the session ends. A failed ask is not remembered. When your account can't use Sonnet, it asks the model in your `model` setting instead, the same way the review does.

### Import your past prompts

The history starts with your next prompt, but Claude Code's transcripts still hold the prompts you typed before. `tools/import-history.ts` checks those with the plugin's own prompt and adds their fixes, each with the time the prompt was sent:

```
git clone https://github.com/jaklimoff/claude-grammar && cd claude-grammar
bun tools/import-history.ts --dry-run       # how many prompts, no model calls
bun tools/import-history.ts --days 30       # the last 30 days (default 7, at most 90)
```

- It reads only prompts you typed, sent at once or queued while Claude worked: no slash commands, no Claude's replies or tool output, no subagents. It uses your settings and both `grammar.json` files, the way the plugin does, so `skip`, `ignore` and `"history": false` all apply.
- It checks about 20 prompts per call through `claude -p` with your own login (Haiku at low effort unless your settings say otherwise). The calls run in safe mode from an empty folder, so no CLAUDE.md, plugins, hooks, MCP servers or tools come along, and they save no session. A prompt a reply skips gets one more call. 195 prompts took 10 calls, 40 seconds and about $0.02.
- `--days N` covers the same days as the period `Nd`: today and the N − 1 days before, UTC. It prints how many prompts were checked, how many were in another language (with `auto`, had no prose), and how many got no usable answer. It checks in your `language` setting and keeps each fix under its language.
- It imports only the days before the history's first day, so running it again adds nothing twice.
- For another config folder, pass `--config-dir` (it defaults to `$CLAUDE_CONFIG_DIR`, then `~/.claude`). It needs [Bun](https://bun.sh).

## Privacy and cost

Each prompt you type (its first 6000 characters by default, pasted text included) goes to Haiku (or the model you set) through Claude Code's own model access, on the same account and provider as the rest of your session. That is one small call per prompt (Haiku at low effort, unless you change `model` or `effort`), counted in your usage like any other call. `/grammar review`, only when you run it, sends your grouped fixes (not your prompts) to Sonnet the same way. `/grammar ask`, only when you run it, sends your question, your grouped fixes, the fixes from this session's latest prompts and the remembered asks and answers. With `endpoint` set, all of it goes to that endpoint instead, and none of it to Claude's models: a local server keeps it on your machine, a remote one gets it under its own terms. Nothing goes anywhere else.

The fixes are kept on your disk in `grammar-history.json` (see [Your mistakes over time](#your-mistakes-over-time)). They are short bits of what you typed, from every project. `/grammar history off` stops keeping them, `/grammar history clear` empties the file, and `"history": false` in a project's `.claude/grammar.json` keeps nothing from that project.

What one check costs, measured on 2026-10-30 with the 1.2.0 system prompt (default settings: natural phrasing on, and the history on, so each fix's kind is asked for), Claude Haiku 5.5 at low effort, 10 runs per prompt, through the same `$.model.complete` call the plugin makes.

| Prompt | Input tokens | Output tokens | Cost at API prices |
|---|---|---|---|
| Clean, 35 characters | 602 | 21 | ~$0.00007 |
| 3 mistakes, 80 characters | 613 | 425 to 799 | ~$0.0003 to $0.0005 |
| 5+ mistakes, 200 characters | 638 | 239 to 541 | ~$0.0002 to $0.0003 |

About 580 of the input tokens are the mod's instructions. Asking for each fix's kind added 82 of them in 1.2.0; with the history off, the check leaves the kind out and sends 1.1.0's shorter prompt (520 tokens for the clean prompt). A clean prompt costs almost nothing to answer. When Haiku finds mistakes, it writes out the fixes and often thinks first, and that is most of the output. How much it thinks varies more than the number of mistakes does: in these runs the 200-character prompt with five mistakes came out cheaper than the 80-character one with three. A session of 50 prompts comes to roughly 31K tokens if you write clean and up to about 70K if every prompt has mistakes: about $0.004 to $0.02 at Haiku's API prices ($0.10 per 1M input tokens, $0.50 per 1M output). On a subscription the same tokens count toward your plan's usage instead. `/grammar off` stops the calls.

One `/grammar review` over 119 kept fixes (115 grouped lines) sent 2,900 tokens and got back 425 to 515 in 3 runs: about $0.01 at Sonnet 5.5's API prices ($2 per 1M input tokens, $10 per 1M output). At the 300-line cap it sends about 6K tokens, roughly $0.02. It runs only when you type it.

A mod is code that runs inside Claude Code with your permissions, so read it before you install it. This one uses only:

| API | For |
|---|---|
| `$.model.complete` | The Haiku call, and the Sonnet calls of `/grammar review` and `/grammar ask`. |
| `$.http.fetch` | Only with `endpoint` set: the same calls, to that endpoint instead. |
| `$.state` | The checks, reviews, asks and what follow-ups remember, in memory for the session. |
| `$.config.list`, `$.config.set` | Finding the settings' keys, and saving `/grammar on\|off`, `natural on\|off`, `history on\|off` and `ask memory on\|off` as settings. |
| `$.store` | Reading and clearing where 1.0 kept the two switches, once, and noting that the history notice has shown. |
| `$.command.register` | `/grammar`. |
| `$.fs.exists`, `$.fs.read`, `$.fs.write`, `$.env.get`, `$.session.root` | Finding and reading your `grammar.json` files, and keeping `grammar-history.json`. Writes go only to two files in your Claude Code folder: the global `grammar.json` on `/grammar ignore add\|rm`, and the history after each check and on `/grammar history clear`. |
| `$.clock.now`, `$.clock.sleep` | The time on each kept fix, and the endpoint call's timeout. |
| `$.ui.toast` | The one notice for a file that doesn't parse, the one naming the history file until it exists, and each check's fixes in the desktop app when `desktop` is `toast`. |
| `$.ui.log` | Each check's fixes as a dim transcript line in the desktop app, where the line under the prompt isn't drawn (the `desktop` setting, `band` by default, which adds the colored band too). |
| `$.session.surfaces` | Skipping runs that draw nowhere, and telling a Cowork task (no surface, and `CLAUDE_CODE_ENTRYPOINT` read through `$.env.get`) from them. |
| `$.clock.after`, `$.ui.resolve` | Running the check off the prompt's path, and drawing the lines. |

No other files, no processes, and no network but your `endpoint` when you set one. `claude plugin validate .` prints the same list for any mod. The full note is in [PRIVACY.md](PRIVACY.md).

## Requirements

- Claude Code with mods. Tested with v2.1.314, in the terminal. Mods can change between releases, so if the line stops showing after an update, check the [changelog](https://code.claude.com/docs/en/changelog).
- A Nerd Font in your terminal for the icons. Without one, they show as empty squares; set `icons` to off for plain characters.
- Not drawn in the VS Code extension or in `claude -p`. In the desktop app the line under the prompt isn't drawn either, so the newest check shows in color in a band above the prompt box, with a dim transcript line as the record (the `desktop` setting; `line`, `toast` or `off` also work).
- In Cowork tasks the fixes come at the end of Claude's reply, since Cowork draws nothing from mods: see [In Cowork](#in-cowork).

## How it works

The plugin is five files: `hooks/grammar.tsx` (the hooks, commands and drawing), `hooks/check.ts` (the check's prompt and the reply's parsing), `hooks/config.ts` (settings and ignore lists), `hooks/history.ts` (the kept fixes, stats, and the review's and ask's prompts) and `hooks/endpoint.ts` (the OpenAI-compatible call, when `endpoint` is set). `tools/import-history.ts` uses the same `check.ts` and `history.ts` outside Claude Code. It is a Claude Code mod: a plugin whose `hooks/hooks.json` lists a module that runs inside Claude Code ([mods docs](https://code.claude.com/docs/en/plugins/mods/overview)). It hooks these events:

| Event | What it does |
|---|---|
| `session.start` | Sets the switches from the settings (moving 1.0's from `$.store` once) and registers `/grammar`. |
| `command.run` | Handles `/grammar`. |
| `prompt.submit` | Queues a check of the prompt on a timer, so the prompt is never held up, and passes it on unchanged. Once the check is drawn, its fixes go into the history. In a Cowork task it checks first instead and, when there are fixes, passes them on beside the prompt for Claude to end its reply with. |
| `ui.render` (`UserMessage`) | Draws the fixes and the native-speaker line under the transcript row of the prompt they belong to. |
| `ui.render` (`AbovePrompt`) | Draws the newest check's fixes in a band above the prompt box in the desktop app, with a Hide button (the `desktop` setting). |
| `ui.render` (`CommandOutput`) | Draws the `/grammar review` card and `/grammar ask` answers in place of their plain text. |

The check asks Haiku for JSON:

```json
{ "english": true, "fixes": [{ "from": "...", "to": "...", "why": "...", "kind": "preposition" }], "natural": null }
```

With another `language`, a list or `auto`, it names the language instead, or `null` for a text it doesn't check:

```json
{ "language": "French", "fixes": [{ "from": "...", "to": "...", "why": "...", "kind": "agreement" }], "natural": null }
```

Fixes for words that aren't in the prompt, or are on your ignore list, are dropped before they're drawn. The system prompt is at the top of `hooks/check.ts`, so tune it there.

Works well beside [open-questions](https://github.com/jaklimoff/claude-open-questions): the answers it sends or appends for you are not checked, since they quote Claude's own words.

## Development

```
claude --plugin-dir .          # run Claude Code with your working copy
claude plugin test .           # the tests in tests/grammar.test.ts, with Haiku mocked
claude plugin validate --strict .
bun docs/render-tour.ts        # record the tour GIFs from docs/tour.html; they live on the media branch
bun docs/measure-cost.ts ...   # measure a check's tokens for the cost table (usage in the file)
docs/render-cost.sh brand      # render the cost card PNGs; they live on the media branch
```

## Contributing

Issues and PRs welcome: [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the checks to run and how releases work. Report security problems privately: [SECURITY.md](SECURITY.md). What changed in each version: [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
