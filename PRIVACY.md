# Privacy

grammar is a Claude Code plugin. It has no server and collects nothing for its author.

## What it sends

Each prompt you type in Claude Code (its first 6000 characters by default, the `max_chars` setting) is sent to Haiku, or the model you set, through Claude Code's own model access, on the same account and provider as the rest of your session, so Haiku can check its English. That request is handled under the terms that already cover your Claude Code session. Text you paste into a prompt is part of it and is sent too. Slash commands, hidden prompts, prompts shorter than `min_words`, prompts matching your `skip` list, and runs that draw nothing (`claude -p`, the SDK) are not sent. In a Cowork task, which draws nothing either, prompts are sent (unless the `cowork` setting is off), and a prompt's fixes are added beside it for Claude, so they become part of that conversation like the prompt itself. Nothing from Cowork is kept in the history file.

`/grammar review`, only when you type it, sends the fixes the plugin has kept (grouped, with counts; not your prompts) to Sonnet the same way, or to your `model` setting when your account can't use Sonnet.

`/grammar ask`, only when you type it, sends your question, the kept fixes for the period (grouped, with counts), the fixes from this session's latest prompts (at most 10; not the prompts), and, while ask memory is on, the session's last 5 asks and reviews with their answers, to Sonnet the same way, or to your `model` setting when your account can't use Sonnet.

With the `endpoint` setting set, all three of these go to that OpenAI-compatible endpoint instead, and nothing goes to Claude's models. A local server (`http://localhost:...`) keeps them on your machine; a remote one (OpenRouter, OpenAI, a gateway) gets your prompts under its own terms. The `endpoint_key` setting, when set, is sent to it as a Bearer token and kept in Claude Code's secure storage, not in `settings.json`.

Nothing is sent anywhere else: the plugin makes no other network requests (none at all while `endpoint` is empty) and starts no processes.

## What it keeps

- The checks (each prompt's text and its fixes) live in Claude Code's session state, in memory, and are gone when the session ends. So do the reviews and asks shown, and the last 5 asks and reviews that `/grammar ask` remembers for follow-ups; `/grammar ask clear` forgets those sooner, and `/grammar ask memory off` (the `ask_memory` setting) stops remembering them.
- Each fix is also kept on your disk in `grammar-history.json` in your Claude Code folder (`~/.claude/`, or `$CLAUDE_CONFIG_DIR`), for `/grammar stats` and `/grammar review`. A kept fix holds the words you typed that it corrects, the correction, a short reason, the kind of mistake and the time. There's also a count per day of prompts checked and prompts with a fix. These are short bits of what you typed, from every project you use Claude Code in. The prompt itself is not kept, and neither is the native-speaker rewrite. Fixes over 60 characters, fixes that only change case, fixes that look like code or a path, and fixes for words on your ignore list are dropped. The file keeps 90 days and at most 2000 fixes. The first session that keeps fixes starts with a notice naming the file; the plugin's own store notes that it has shown, so it shows once.
- `tools/import-history.ts`, only if you run it, reads the prompts you typed in Claude Code's transcripts and the plugin's options in `settings.json` (both in your Claude Code folder), sends them through `claude -p` on your own login to be checked, and adds their fixes to the same file.
- `/grammar history off` (or the `history` setting) stops keeping fixes. `/grammar history clear` empties the file, and you can delete it yourself. `"history": false` in a project's `.claude/grammar.json` keeps nothing while you work in that project.
- In the desktop app each check's fixes are also written as a notice line in the session's transcript (not sent to the model), and, while Claude Code's debug logging is on, to its debug log. With `desktop` set to `line`, so is a clean prompt's `✓ no mistakes` line.
- Its settings, the `/grammar` switches among them, are saved in your Claude Code `settings.json` like any plugin's.
- Your ignore and skip lists are in `grammar.json` files you control: one in your Claude Code folder and one in a project's `.claude` folder. The plugin reads them on each prompt. `/grammar ignore add|rm` writes only the one in your Claude Code folder.

The plugin reads and writes no other files.

## Turning it off

`/grammar off` stops all checks, and so no prompt is sent. Uninstalling the plugin removes it, but leaves `grammar-history.json` in place; delete it yourself if you want it gone.

## Contact

Questions: open an issue at https://github.com/jaklimoff/claude-grammar/issues.
