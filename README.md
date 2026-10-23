# Codjiflo Reviewer

A mention-triggered GitHub PR reviewer for trusted self-hosters. Node.js 22+, Git, native `fetch`, `node:test`, and your existing Codex/Claude CLI login. No runtime npm dependencies, hosted review service, or multi-tenant infrastructure.

Comment on an open PR:

```text
@codjiflo-reviewer review
@codjiflo-reviewer review opus-xhigh full
@codjiflo-reviewer review sol-medium
@codjiflo-reviewer review codex
@codjiflo-reviewer review claude full
```

`@codjiflo` is also accepted. The mention must begin a line. Options are optional, order-independent, and limited to one preset plus one mode (`full` or `incremental`). Only newly created issue comments trigger work; editing an existing comment does not.

## Presets

| Preset | CLI/model default | Model effort | Embedded e-code-review recipe |
| --- | --- | --- | --- |
| `sol-xhigh` (default; alias `codex`) | Codex / `gpt-6.1-sol` | high | xhigh |
| `opus-xhigh` (alias `claude`) | Claude / `opus` | high | xhigh |
| `sol-medium` | Codex / `gpt-6.1-sol` | medium | high |
| `opus-medium` | Claude / `opus` | medium | high |

Preset names and aliases are case-insensitive in mentions and local `--preset` arguments. Aliases resolve to their canonical preset before kickoff, review publication, and baseline selection; they do not add extra presets. An alias and its canonical name still count as two preset arguments and are rejected together in a mention. `sol-high` and `opus-high` have been replaced by `sol-xhigh` and `opus-xhigh`; the old names are no longer accepted. Model effort remains `high`, and medium presets are unchanged. Historical reviews marked with the old names do not match the new presets, so the next review falls back to full scope.

`CODJIFLO_SOL_MODEL` and `CODJIFLO_OPUS_MODEL` override model IDs. There is no automatic substitution or cross-provider fallback: configure a model available to your account. Claude's `opus` is its supported Opus alias; use a full model ID to pin a release.

The high and xhigh instructions are faithfully adapted from the e-code-review skill: eight/ten sequential independent angles (no subagent fanout), deduplication without verification, severity ordering, a gap sweep for xhigh, and caps of ten/fifteen findings. They are embedded in **every provider prompt**, not dependent on installing the skill on the runner. Structured JSON/native GitHub reviews replace ReportFindings; the unrelated native-observer pilot and later fix reporting are omitted. See `src/prompt.mjs` for the complete instructions.

## Install in a consumer repository

1. Make sure this public repository's Actions workflows are usable by your organization. Choose a trusted Codjiflo commit SHA. Copy [`examples/codjiflo-reviewer.yml`](examples/codjiflo-reviewer.yml) to `.github/workflows/codjiflo-reviewer.yml` on your repository's **default branch**. Replace both `@main` and `bot-ref: main` with the **same** trusted commit SHA. `main` is usable for development but follows future source changes.
2. Under Settings → Secrets and variables → Actions → Variables, set **`CODJIFLO_APPROVED_USERS`** to comma-, whitespace-, or newline-separated GitHub logins, for example `alice,bob`. Matching is exact and case-insensitive. **Unset/empty means nobody is approved.** Repository ownership, association, collaborator status and write permission do not override this list.
3. Register a trusted Linux self-hosted Actions runner with the consumer repository/organization (`self-hosted` label by default). Install Git, Node 22+, and current `codex` and/or `claude` executables on its PATH. Log in to each CLI **as the runner OS user**, using its normal interactive authentication setup. Do not copy auth files into this repository or Actions artifacts. Set `runner-label` in the caller if using a dedicated custom label.
4. Grant the workflow `contents: read`, `issues: write`, `pull-requests: write` as shown. Organization policy must allow these permissions and bot approvals (see below).
5. Optionally configure the GitHub App below for a dedicated bot identity. Otherwise the workflow uses `GITHUB_TOKEN`.
6. Post an allowed mention on an open PR. A kickoff comment links the workflow run. CLI stdout **and stderr stream live** in the review step's logs. A successful run posts a native `APPROVE` or `REQUEST_CHANGES` review with validated single-/multi-line inline findings on the appropriate LEFT/RIGHT sides.

The reusable workflow first runs an authorization gate on `ubuntu-latest`, **before scheduling self-hosted review work**. Both gate and CLI authorize the original `issue_comment.comment.user.login`, not the user who reruns the workflow. The CLI repeats authorization before any API mutation or provider invocation. The event JSON is the source of truth; workflow runs ignore local requester flags. No `workflow_dispatch` path or caller-supplied event login is supported.

Bot implementation checkout always comes from trusted `vezzadev/codjiflo-reviewer` at `bot-ref`, **never the PR branch**. The target PR is fetched separately into a disposable Git repository, including fork heads via GitHub's accessible commit objects. It is not built or tested by the orchestrator. The review CLI can read files and use Git to inspect context. This is intended for machines/repositories whose users and content you trust; it is not a sandbox or a malicious-input isolation product.

This repository runs its own instance through [`.github/workflows/codjiflo.yml`](.github/workflows/codjiflo.yml). It uses the `codjiflo-reviewer` runner label and the existing `Codjiflo` GitHub App. The local reusable workflow and bot checkout use the same default-branch revision. Approved users and App credentials remain in repository Actions variables/secrets; consumer repositories should use the example workflow above.

### GitHub identity and permissions

**Recommended: GitHub App.** Create or reuse an App, install it on the consumer repository, and grant repository permissions **Contents: read** and **Pull requests: read/write**. Pull-request write permission also permits comments on PR conversations; Issues write permission is not required. No webhook subscription is needed. Set repository variable `CODJIFLO_APP_ID` and Actions secret `CODJIFLO_APP_PRIVATE_KEY`. The example passes them to the reusable workflow, which mints a short-lived installation token with `actions/create-github-app-token`. Reviews appear under the App's bot identity. Reusing an App does not require changing its OAuth callbacks, existing keys, or other installations.

**Built-in `GITHUB_TOKEN`:** works where repository/organization policy allows it. Enable Settings → Actions → General → Workflow permissions → **Allow GitHub Actions to create and approve pull requests** if approval is restricted. Its actor is `github-actions[bot]`, not a custom Codjiflo App. GitHub can reject an approval by the PR's own author; bot-created PRs can therefore require a separate App identity. Events created using `GITHUB_TOKEN` generally do not start other Actions workflows; use an App token when downstream review-triggered automation is required. Fork/organization policies may further restrict token writes. An API rejection is a failed run, never silently converted into approval.

Existing CLI authentication is independent of the GitHub token. Subscription/API access, usage limits and model availability remain your responsibility. The code checks provider exit status and structured completion; it does not turn quota/auth errors into a clean review.

Provider calls have a 45-minute limit; the review job has a 55-minute limit, below the GitHub App token's one-hour lifetime. A provider timeout terminates its process group on Linux and enters the normal failure-reporting path. A runner shutdown or forced workflow cancellation may prevent the failure comment and temporary-checkout cleanup; check the workflow logs in that case.

## Incremental review and fail-closed publication

Incremental is the default. Each successful native review includes a machine-readable marker:

```html
<!-- codjiflo-reviewer:v1 {"head":"<40-character-sha>","base":"<40-character-sha>","preset":"sol-xhigh"} -->
```

The most recent marked review must be an approval whose marker matches its GitHub `commit_id`, current base, and requested preset. Both App/bot and PAT-authored reviews participate. Its head must be an available ancestor of the new head. Then only changes since that approval are reviewed. Missing baseline, changed base or preset, rewritten/unavailable history, a previous changes-requested verdict, or a same-head rerun forces a **full** review. Earlier blocking findings are revisited rather than discarded. `full` explicitly requests the merge-base-to-head diff. Full Git history is fetched as needed.

Inline coordinates come from GitHub's paginated PR file patches, including the current filename for renamed files. LEFT endpoints must be deleted lines; RIGHT endpoints may be added or unchanged context lines. Local Git diffs supply review scope, not publication coordinates. Missing or truncated patches provide no valid anchors: findings on them go into the review summary and require changes. PRs exceeding GitHub's 3,000-file metadata limit fail without a verdict.

Each native review is pinned to the inspected head commit. Before publication the bot rereads the PR and rejects changed head/base or a closed PR. There is an unavoidable GitHub API race between that final read and creating the review; `commit_id` still records the exact inspected commit and never claims to have reviewed a newer one. GitHub's branch protection should dismiss stale approvals if desired.

Only authorized review jobs enter the per-PR concurrency group. Unrelated comments and denied requests cannot displace queued reviews. GitHub retains one running and one pending job per group: a newer authorized request replaces an older pending request, without cancelling the running review.

Malformed JSON, missing structured output, provider failure, contradictory approval with blocking findings, or a stale PR produce **no approval**. Invalid/out-of-hunk locations are preserved as summary findings and force `REQUEST_CHANGES`; they are not dropped or assigned invented coordinates. Failures are reported in a comment and Actions logs when the runner and API remain available. Each structured finding carries `disposition: "blocking" | "advisory"`; correctly anchored advisory findings may accompany approval.

## Local CLI

```sh
# No npm install needed.
export CODJIFLO_APPROVED_USERS='your-login'
export GITHUB_TOKEN='your-app-installation-token-or-PAT'
node bin/codjiflo-reviewer.mjs --repo owner/repo --pr 123 --requester your-login --preset claude --full
```

| Invocation | Behavior |
| --- | --- |
| `node bin/codjiflo-reviewer.mjs` | Uses `GITHUB_EVENT_PATH` for an issue_comment event |
| `node bin/codjiflo-reviewer.mjs --gate` | Authorization/command check only; sets `allowed` in `GITHUB_OUTPUT`; no token/provider/API calls |
| `--repo owner/repo --pr N --requester login` | Trusted local invocation, default `sol-xhigh` incremental; still requires allowlist |
| `--preset PRESET` | Select one of the four canonical presets or the `codex`/`claude` aliases |
| `--full` | Full review in local invocation |
| `--help` | Print usage |

Local `--requester` is an operator assertion, not remote authentication. Do not expose this CLI as an unauthenticated service. Event-based runs always use the original event author instead.

Other environment: `GH_TOKEN` is a fallback for `GITHUB_TOKEN`; `GITHUB_API_URL` supports GitHub Enterprise/the fixture server; PR metadata supplies its clone URL. `CODJIFLO_CODEX_BIN`/`CODJIFLO_CLAUDE_BIN` override executable paths (also used by fixtures). `GITHUB_RUN_ID`/`GITHUB_SERVER_URL` build kickoff links. The reusable workflow exposes `sol-model`, `opus-model`, `runner-label`, and optional `app-id` inputs.

Provider flags were checked against installed help: Codex `exec --model -c model_reasoning_effort=... --sandbox read-only --json --output-schema --output-last-message`, prompt on closed stdin; Claude `--print --model --effort --output-format stream-json --verbose --json-schema --no-session-persistence --strict-mcp-config --allowedTools Read,Grep,Glob,Bash --permission-mode dontAsk`. Claude result events require `subtype: success`, no `is_error`, and `structured_output`. No interactive stdin is left open. Keep CLIs recent enough to support these flags; unsupported flags fail the run. Claude uses existing auth/settings, but external MCP configurations are not loaded.

## Development and deterministic verification

```sh
npm test
npm run smoke
```

Tests cover command parsing, executable deny-default authorization, original-sender identity, GitHub patch coordinates and renames, split UTF-8 output, subprocess deadlines, baseline and preset transitions, previous blockers, malformed output, provider failures, and stale-head rejection.

The smoke runs the **real entry point and orchestration**, native fetch against a loopback HTTP fixture server, Git fetch/checkout of a real temporary repository, and fake executable Codex/Claude CLIs. It asserts kickoff/native review payloads and range coordinates, exercises both provider adapters and stale-head failure, and performs **no remote writes or real model calls**. Everything is temporary and cleaned up. Hosted CI runs both commands on pushes and PRs; no self-hosted runner or auth is needed for tests.
