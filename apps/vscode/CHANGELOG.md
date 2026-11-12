# Changelog

## 0.1.2

- **Security: only your own settings can name the CLI.** `optimaizr.cliPath` is run as a program when guard is turned on. It was read from workspace settings too, so a folder's `.vscode/settings.json` could point it at a file of its own. It is now a machine setting read from your user settings only, it has to be a full path to a file on this machine, and in a workspace you have not trusted VS Code ignores it altogether. If you had set it in a workspace, set it again in your user settings
- Install and turn on installs the CLI version this extension was built with, `optimaizr@0.13.1`, not whatever is newest that day
- With `"manageSettings": false` in `~/.optimaizr/config.json` the guard switch and the compaction button are gone, and the sidebar says what to add by hand. Nothing in the extension writes Claude Code's settings then
- Claude Code's settings are written in one step, and a symlinked settings file stays a symlink
- Fable 5.2 is named and priced as Fable 5.2 ($8/$40, cache reads $0.20/M), not as Fable 5. GPT-6.1 Sol and Terra from Codex are priced too
- When Claude Code hits the Fable limit, the sidebar and the status bar hover say when Fable is back, until it is. Only Claude Code writes that stop, so with Codex or opencode alone it never shows
- A new activity bar icon, the logo's prompt inside a meter, so optimAIzr no longer looks like a second terminal

## 0.1.1

- The cache heads-up can come 1 to 10 minutes before it expires, not only 5: `optimaizr.alerts.cacheExpiringMinutes`
- Hovering the status bar names the model and effort, and says what the last reply cost and its share of your 5-hour window
- Open savings in the hover says how many fixes are open and what they are worth a month
- The listing and the welcome name every tool the savings cover: Claude Code, Codex and opencode

## 0.1.0

The first release.

- Status bar with this folder's context size, cache countdown and 5-hour window
- A sidebar that leads with what you could save, then right now, guard and the fixes
- A heads-up before a long conversation's cache expires, and what a cold return cost
- Guard on and off from the sidebar, with what it held this week
- Compact Claude Code earlier, at 200K, in one click, and undo it the same way
- I did this for habits, so results can measure them
- A full report in an editor tab
- A desktop alert when a long turn finishes in the background
