# Record commit SHA in `.openskills.json` at install time

## What changes for the user

When `npx openskills install <source>` clones a git-sourced skill, the resulting `.openskills.json` file records *when* the install happened (`installedAt`) but not *which commit* was installed. After this change, the same file also records the commit SHA that `git clone` brought down, plus a browser-clickable URL pointing at that commit on the upstream host.

No user-facing command behavior changes. Skills install the same way, in the same place, with the same output. The only observable difference is two extra lines in `.openskills.json`:

```json
{
  "source": "anthropics/skills/pdf-editor",
  "sourceType": "git",
  "repoUrl": "https://github.com/anthropics/skills",
  "subpath": "pdf-editor",
  "installedAt": "2026-05-11T19:42:08.123Z",
  "commitSha": "f458cee31a7577a47ba0c9a101976fa599385174",
  "commitUrl": "https://github.com/anthropics/skills/commit/f458cee31a7577a47ba0c9a101976fa599385174"
}
```

Both fields contain the **full 40-character SHA** that `git rev-parse HEAD` returned — no truncation. `commitUrl` is always an `https://` URL so that terminals (iTerm2, Warp, VS Code's integrated terminal) and editors that auto-linkify URLs make it clickable — `cat .openskills.json` becomes a one-step "what code am I actually running?" lookup.

### Why this is useful on its own

**Team and debugging visibility.** When skills are installed in a team-shared repo (the `.claude/skills/` or `.agent/skills/` tree committed alongside the project's code), every developer on the team gets the same installed copy. But when a teammate hits a bug — "this skill is producing weird output", "the docs say feature X but I don't see it" — there's currently no way to answer "what version of the upstream skill are we actually pinned to?" without re-running `install` and hoping the upstream hasn't changed. Recording `commitSha` (plus the clickable `commitUrl`) makes this directly answerable: a teammate (or an LLM helping debug) can `cat .openskills.json`, click straight through to the upstream commit, and see the exact code that's installed. Bug reports to upstream skill authors become actionable too ("we're on commit `f458cee` and seeing X") instead of vague.

**Self-explaining diffs.** When the skills tree is committed to the team's repo, a `git pull` that brings in a skill update now shows both the changed `SKILL.md` *and* a changed `.openskills.json` with the new `commitSha`/`commitUrl`. A teammate scanning the diff sees the SHA bump and immediately understands the SKILL.md changes came from an upstream sync — no more wondering "did someone hand-edit this?" or "where did this change come from?"

### What does *not* change

- Local-source skills (installed from a path on disk via `npx openskills install ./path/to/skill`) are explicitly out of scope: no `commitSha` is recorded for them, even when the local path happens to be inside a git working tree. The team-debugging use case that motivates this PR assumes upstream skills shared via a remote repo; local installs are typically used by skill *authors* iterating on their own work and don't benefit from the same provenance trail.
- Legacy `.openskills.json` files written by previous versions of openskills stay valid — readers tolerate a missing `commitSha`. But going forward, every fresh `install` with this version (or later) will write the field; there is no opt-out and no flag to disable it. In other words: backward-compatible for reads, mandatory for writes. Older installs will be naturally migrated when users next re-install those skills. `update` in this PR does not back-fill the field — it only rewrites `installedAt`, same as today.
- `update`, `sync`, and every other command read and write the metadata exactly as today. Nothing consumes `commitSha` in this PR.
- No new dependencies, no new network calls, no new auth surface.

## How it works under the hood

### Where the SHA comes from

Right after the clone succeeds at [src/commands/install.ts:160](https://github.com/kinueng/openskills/blob/main/src/commands/install.ts#L160), run:

```ts
const commitSha = execSync(`git -C "${tempDir}/repo" rev-parse HEAD`, { stdio: ['pipe','pipe','pipe'] })
  .toString().trim();
sourceInfo.commitSha = commitSha;
sourceInfo.commitUrl = buildCommitUrl(repoUrl, commitSha);
```

A note on shallow clones: the existing install code already runs `git clone --depth 1` (see [src/commands/install.ts:157](https://github.com/kinueng/openskills/blob/main/src/commands/install.ts#L157)), which only downloads the latest snapshot, not the project's full history. That's fine for our SHA lookup — `HEAD` is a tiny pointer file inside the clone that records "the current commit is X", written the moment the clone completes. `git rev-parse HEAD` just reads that pointer, so it works the same whether we fetched 1 commit or 100,000. No history walk, no extra network calls.

### Monorepo skills can have different SHAs across installs

The captured SHA is the *whole repo's* HEAD at clone time, not the subpath's. So two skills from the same monorepo (e.g. `anthropics/skills/pdf-editor` and `anthropics/skills/skill-creator`) installed at different times will record different `commitSha` values — even if neither subpath's files changed between the installs. A default `update` re-clones all installed skills in one pass, so monorepo skills converge back to a single SHA after the next update; but in between, divergence is expected and correct.

### Building the commit URL

`commitSha` is host-agnostic — we read it via `git rev-parse HEAD` from the local clone, which works regardless of where the repo came from. `commitUrl` is host-specific, since different hosts use different URL patterns for viewing commits (`/commit/<sha>`, `/-/commit/<sha>`, `/commits/<sha>`, …).

`buildCommitUrl(repoUrl, sha)` is a small pure helper that returns a browser-clickable `https://` URL when it recognizes the host's pattern, or `undefined` otherwise. In this PR it recognizes github-style hosts (github.com plus any host whose commit path follows the `/<owner>/<repo>/commit/<sha>` convention). For unrecognized hosts, `commitUrl` is omitted from `.openskills.json` and the user still gets `commitSha` to look up manually.

**Normalization rules for github-style inputs.** The output is always `https://<host>/<owner>/<repo>/commit/<sha>` — HTTPS scheme is enforced regardless of how the user originally cloned (SSH, `git://`, or HTTPS), so the URL is always browser-clickable:

- `https://github.com/anthropics/skills` → use as-is.
- `https://github.com/anthropics/skills.git` → strip trailing `.git`.
- `git@github.com:anthropics/skills.git` → rewrite SSH to HTTPS (`git@<host>:<path>` → `https://<host>/<path>`), strip trailing `.git`.
- `git://github.com/anthropics/skills.git` → rewrite scheme to `https`, strip trailing `.git`.

The helper lives in [src/utils/skill-metadata.ts](https://github.com/kinueng/openskills/blob/main/src/utils/skill-metadata.ts) next to the metadata types, so the same logic can be reused by any future code that needs to display a clickable link (e.g. an `openskills info` command).

### Why thread it through `sourceInfo`

The install code writes `.openskills.json` metadata in two different places depending on which branch of the install flow runs:

- `installSpecificSkill` path ([src/commands/install.ts:312](https://github.com/kinueng/openskills/blob/main/src/commands/install.ts#L312)), when the user requested one subpath like `anthropics/skills/foo`.
- `installFromRepo` path ([src/commands/install.ts:476](https://github.com/kinueng/openskills/blob/main/src/commands/install.ts#L476)), the interactive multi-skill selection from a whole repo.

Both paths receive a shared `InstallSourceInfo` object and ultimately call `buildGitMetadata` ([src/commands/install.ts:498](https://github.com/kinueng/openskills/blob/main/src/commands/install.ts#L498)) to produce the metadata blob. Stashing `commitSha` onto `sourceInfo` once, before the branching, means `buildGitMetadata` copies it into the metadata regardless of which branch executes. No need to modify two write sites.

### Data model

Extend `SkillSourceMetadata` ([src/utils/skill-metadata.ts:8-15](https://github.com/kinueng/openskills/blob/main/src/utils/skill-metadata.ts#L8-L15)) with one optional field:

```ts
commitSha?: string;  // populated for sourceType === 'git'; set after a successful clone
```

Optional, so existing `.openskills.json` files (which won't have it) keep working unchanged.

Also extend `InstallSourceInfo` in [src/commands/install.ts](https://github.com/kinueng/openskills/blob/main/src/commands/install.ts) with the same optional field, so `buildGitMetadata` can include it.

### Error handling

If `git rev-parse HEAD` fails (it shouldn't — we just successfully cloned the same repo a line earlier), the install fails the same way any other unexpected exception fails: the existing try/catch around the clone block reports it and exits non-zero. We do *not* swallow the error to install without a SHA — better to fail loudly so the bug surfaces, given that this command should be reliable.

## Files to modify

- [src/utils/skill-metadata.ts](https://github.com/kinueng/openskills/blob/main/src/utils/skill-metadata.ts) — add `commitSha?: string` to `SkillSourceMetadata`.
- [src/commands/install.ts](https://github.com/kinueng/openskills/blob/main/src/commands/install.ts) — capture SHA after clone ([~line 160](https://github.com/kinueng/openskills/blob/main/src/commands/install.ts#L160)); add field to `InstallSourceInfo`; include in `buildGitMetadata` ([line 498](https://github.com/kinueng/openskills/blob/main/src/commands/install.ts#L498)).
- `tests/integration/install.test.ts` — new test file (below).

No changes to `update.ts`, `sync.ts`, or `cli.ts`. No new dependencies.

## Tests

Existing vitest unit tests ([tests/commands/install.test.ts](https://github.com/kinueng/openskills/blob/main/tests/commands/install.test.ts), [tests/utils/skill-metadata.test.ts](https://github.com/kinueng/openskills/blob/main/tests/utils/skill-metadata.test.ts)) cover only pure helpers and use `toMatchObject` subset matching — they should keep passing unmodified. The new optional fields (`commitSha`, `commitUrl`) are purely additive.

New functional coverage goes in a **new file** at `tests/integration/install.test.ts`, dedicated to install-flow tests. As part of this change, the existing `describe('openskills install (local paths)', ...)` block currently inside [tests/integration/e2e.test.ts](https://github.com/kinueng/openskills/blob/main/tests/integration/e2e.test.ts) (3 tests, ~40 lines) is **moved** into the new file. This consolidates all install testing — local-path and git-clone — in one place, regardless of source type, and trims `e2e.test.ts` to its remaining commands (list, read, sync, remove).

The folder structure makes the unit-vs-functional split visible:

```
tests/
├── commands/                # unit tests of command helpers
├── utils/                   # unit tests of utility modules
└── integration/             # functional tests of the built CLI
    ├── e2e.test.ts                (existing, slightly trimmed)
    └── install.test.ts            (new — all install-flow tests)
```

### `tests/integration/install.test.ts` cases

Style matches `e2e.test.ts`: invoke the built CLI via `execSync`, real filesystem in a temp dir, assert on `.openskills.json` contents.

**Moved from `e2e.test.ts` (unchanged):**

- `openskills install` from absolute local path.
- `openskills install` installs a directory of skills from a local path.
- `openskills install` errors for non-existent local path.

**New for this PR:**

1. **Install from real github records `commitSha` and `commitUrl`.** Run `node dist/cli.js install anthropics/skills/pdf-editor --yes` against real github.com. Assert: `.openskills.json` exists, `commitSha` is a 40-char hex string, `commitUrl` equals `https://github.com/anthropics/skills/commit/<commitSha>`.
2. **`commitUrl` returns HTTP 200.** Fetch the recorded `commitUrl`; assert response status is 200. Confirms the URL is actually browser-clickable.
3. **`buildCommitUrl` normalization** (pure-function test cases): HTTPS, HTTPS+`.git`, SSH (`git@github.com:...`), `git://github.com/...` → all produce `https://github.com/<owner>/<repo>/commit/<sha>`. Unknown host (`https://example.com/foo/bar`) → returns `undefined`.

The first two new cases require network access at test time. They're appropriate for [tests/integration/](https://github.com/kinueng/openskills/tree/main/tests/integration) (the directory already implies "real CLI, real environment") and run as part of `npm test` — which already executes on every CI run via [.github/workflows/ci.yml](https://github.com/kinueng/openskills/blob/main/.github/workflows/ci.yml). No CI changes needed.

## Verification

```
npm run typecheck
npm test
npm run build
```

Manual smoke:

```
node dist/cli.js install anthropics/skills/pdf-editor --yes
cat .claude/skills/pdf-editor/.openskills.json   # should include "commitSha" and "commitUrl"
```

## PR notes

- Branch from `main`, single feature commit.
- PR title: `feat(install): record git commit SHA in .openskills.json`.
- Body: lead with the team-debugging value (clickable `commitUrl` + self-explaining diffs on `git pull`), describe the field and where it's captured, and confirm backward compatibility (legacy `.openskills.json` files stay valid; the field is mandatory only for new installs going forward).
