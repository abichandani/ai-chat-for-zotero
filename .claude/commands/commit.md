---
description: Stage and commit unstaged changes, but stop if anything is already staged
---

1. Run `git status` (and `git diff --cached --stat` if useful) to check for staged changes.
2. If there are ANY staged changes already, STOP immediately — do not stage or commit anything. Ask the user what they want committed (the pre-staged changes, everything, or something else).
3. If there are no staged changes, review the unstaged/untracked changes (`git status`, `git diff`), stage the relevant files by name (never `git add -A`/`.` blindly — check for secrets or files that shouldn't be committed), and create a commit with a concise message describing the "why" per this repo's commit style, ending with:

   Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

4. Push the current branch to its remote tracking branch (`git push`). If it has no upstream yet, set one with `git push -u origin <branch>`. If the push is rejected (remote has diverged), stop and ask the user how to proceed — never force-push without explicit confirmation.

5. Report to the user what was committed (files + commit message/hash) and where it was pushed (branch).
