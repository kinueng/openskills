# Skip unchanged skills on `openskills update`

## What changes for the user

Today, `npx openskills update` re-downloads every git-sourced skill every time you run it, regardless of whether the upstream repository changed. With 10 installed skills you pay 10 full clones on every run, even when nothing upstream has moved.

After this change, `update` will:

1. Ask each skill's git remote "what's your latest commit?" (a small, cheap network call — no download).
2. Compare that commit to the one recorded when the skill was installed.
3. **If they match: skip the skill entirely** and print `Up to date: <skill-name>`.
4. **If they differ, or the skill was installed before this feature existed:** behave as before — clone and replace.

A new `--force` flag (`npx openskills update --force`) bypasses the check and re-clones everything.

The summary line at the end of `update` gains an "up to date" count alongside the existing "updated" / "failed" counts.

### What users will notice

- **First `update` after upgrading:** behaves exactly like today (legacy installs have no recorded SHA, so they fall through to the clone path). Each skill's metadata gets stamped with its current SHA as a side effect.
- **Second `update` onward:** unchanged skills print `Up to date` and finish in well under a second total. Only skills with actual upstream changes get re-cloned.

### Scope note: installed skills are deployment artifacts

OpenSkills treats an installed skill the way a package manager treats `node_modules/` — the source of truth is the upstream repo, and the local copy is a deployment artifact that gets replaced on `update`. Users who want to modify a skill should fork upstream and re-install, not edit in place. This change does not introduce any local-edit detection; the existing overwrite-on-update behavior is unchanged in the upstream-changed case.

### What does *not* change

- The `install` and `sync` commands behave identically to today from the user's perspective. `install` just additionally records the SHA it cloned, in the skill's `.openskills.json` (see [Where the SHA comes from](#where-the-sha-comes-from)).
- Local-source skills (installed from a path on disk, not a git URL) are unaffected.
- `git clone` runs two stages over one connection, using terminology from git's protocol docs (`Documentation/technical/protocol-v2.txt`, `Documentation/technical/pack-protocol.txt`): **(1) reference discovery** (the `ls-refs` command in protocol v2; "ref advertisement" in v0) — server lists branches/tags and their SHAs, a few KB of text; and **(2) packfile negotiation and transfer** — client and server exchange `want`/`have` lines to determine missing objects, then the server packs and streams the reachable commits/trees/blobs (MB to GB; this is what costs server CPU, network, and client disk). `git ls-remote` performs stage 1 and disconnects; stage 2 never runs. We are deliberately doing only stage 1 in the common case, and escalating to stage 2 (the existing clone) only when the SHA actually moved. Same URL, same auth, same endpoint, same rate-limit bucket as clone — no `api.github.com` quota or other new surface is involved.

### Known limitation, called out in the PR

For skills installed from a monorepo subpath (e.g. `anthropics/skills/foo`), the recorded SHA is the *whole repo's* HEAD. So if any *other* skill in that monorepo gets a commit, our skill will look "changed" and re-clone unnecessarily. That's a regression-free outcome (we still do no worse than today), but the optimization is less effective for monorepo skills.

## How it works under the hood

### The peek

`git ls-remote <url> HEAD` returns the SHA of the remote's default branch in a single short request. No objects are transferred. We compare it to the SHA recorded at install time.

### Where the SHA comes from

Each installed skill carries a `.openskills.json` metadata file inside its own installed directory — wherever the user told `install` to put it. The exact path varies by the agent and scope the user chose: `./.claude/skills/<skill-name>/` for project-local Claude installs (the default), `./.agent/skills/<skill-name>/` for `--universal` installs (Cursor, Windsurf, Aider, Codex, anything that reads `AGENTS.md`), `~/.claude/skills/<skill-name>/` for `--global`, and so on. The file lives alongside the skill's content on the user's machine in whichever of these directories applies; it's an artifact of `install`, not something the openskills *project itself* version-controls or ships. (Whether a downstream user commits their own skills directory into their own repo is up to them.)

This file gains an optional `commitSha` field. It's populated:

- At **install** time, immediately after the clone succeeds, by reading `git rev-parse HEAD` from the cloned working tree. (`rev-parse HEAD` works fine on `--depth 1` shallow clones — `HEAD` is just a ref to the one commit we fetched.)
- At **update** time, after a successful re-clone, by the same mechanism — so the field stays current.

The field is optional so that `.openskills.json` files written by older versions keep working: missing SHA → fall through to the clone path → SHA gets populated → next `update` benefits from the skip.

### Decision matrix at update time

| Recorded `commitSha` | `ls-remote` result | Outcome |
|---|---|---|
| absent (legacy install) | — | clone (today's behavior); record SHA |
| present, equals remote | match | **skip; preserve local files** |
| present, differs from remote | mismatch | clone (today's behavior); update SHA |
| present, `ls-remote` failed (network/auth) | error | fall through to clone path so existing error handling runs |
| any | — | with `--force`: always clone |

## Files touched

- `src/utils/skill-metadata.ts` — new optional `commitSha` field on `SkillSourceMetadata`.
- `src/commands/install.ts` — capture SHA after clone; thread through `InstallSourceInfo`; include in `buildGitMetadata`.
- `src/commands/update.ts` — `peekRemoteHead` helper; pre-clone SHA check; capture-and-persist SHA after a successful clone; `force` parameter; "up to date" counter.
- `src/cli.ts` — `--force` option on the `update` command.
- `tests/commands/update.test.ts` — new tests (below).

`src/commands/sync.ts` and `src/types.ts` are not touched.

## Tests

The existing `tests/commands/update.test.ts` covers only the local-source path. Adding the first git-path tests, in the same style as the rest of the suite (real filesystem, no mocks, temp dirs via `mkdtempSync`). For "the remote", create a local bare git repo in `tempRoot` and use its file path as `repoUrl` — `git ls-remote` and `git clone` both accept local paths, so the tests run offline and deterministically.

New cases:

1. **Up-to-date skip avoids the clone.** Install from a local bare repo, set `commitSha` in metadata to current HEAD, run `updateSkills([])`. Assert: "Up to date" appears in output and the skill directory's mtime is unchanged (no re-write occurred).
2. **Changed remote re-clones.** Same setup, then commit a new `SKILL.md` to the bare repo, run `updateSkills([])`. Assert: content reflects the new commit and `commitSha` in metadata advanced.
3. **Legacy metadata (no `commitSha`) auto-heals.** Write metadata without `commitSha`, run update. Assert: clone happens and SHA is now populated.
4. **`--force` bypasses match.** Recorded SHA equals remote, call with `force: true`. Assert: clone runs anyway.

## Verification

```
npm run typecheck
npm test
npm run build
```

End-to-end smoke (against the actual github remote, locally only — not part of CI):

```
node dist/cli.js install anthropics/skills/skill-creator --yes
cat .claude/skills/skill-creator/.openskills.json   # should now contain commitSha
node dist/cli.js update                              # should print "Up to date"
node dist/cli.js update --force                      # should re-clone
```

## PR notes

- Branch from `main`, single feature commit.
- PR title: `feat(update): skip unchanged skills via git ls-remote SHA check`.
- Body: lead with the user-visible change (faster `update` when upstream is unchanged, new `--force` flag), then the mechanism (`ls-remote` + recorded SHA), and the backward-compat story (optional field, legacy installs auto-heal on first update).
