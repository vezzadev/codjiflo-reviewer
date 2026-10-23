# Codjiflo Reviewer

An API-smoke-fixture GitHub PR reviewer for trusted self-hosters. Node.js 22+, Git, native `fetch`, `node:test`, and your existing Codex/Claude CLI login. No runtime npm dependencies, hosted review service, or multi-tenant infrastructure.

Comment on an open PR:

```text
@codjiflo-reviewer review
@codjiflo-reviewer review opus-high full
@codjiflo-reviewer review sol-medium
```

`@codjiflo` is also accepted. The mention must begin a line. Options are optional, order-independent, and limited to one preset plus one mode (`full` or `incremental`). Only newly created issue comments trigger work; editing an existing comment does not.

## Presets

| Preset | CLI/model default | Model effort | Embedded e-code-review recipe |
| --- | --- | --- | --- |
| `sol-high` (default) | Codex / `gpt-6.1-sol` | high | xhigh |
| `opus-high` | Claude / `opus` | high | xhigh |
| `sol-medium` | Codex / `gpt-6.1-sol` | medium | high |
| `opus-medium` | Claude / `opus` | medium | high |

`CODJIFLO_SOL_MODEL` and `CODJIFLO_OPUS_MODEL` override model IDs. There is no automatic substitution or cross-provider fallback: configure a model available to your account. Claude's `opus` is its supported Opus alias; use a full model ID to pin a release.

The high and xhigh instructions are faithfully adapted from the e-code-review skill: eight/ten sequential independent angles (no subagent fanout), deduplication without verification, severity ordering, a gap sweep for xhigh, and caps of ten/fifteen findings. They are embedded in **every provider prompt**, not dependent on installing the skill on the runner. Structured JSON/native GitHub reviews replace ReportFindings; the unrelated native-observer pilot and later fix reporting are omitted. See `src/prompt.mjs` for the complete instructions.

## Install in a consumer repository

1. Make sure this public repository's Actions workflows are usable by your organization. Choose a trusted Codjiflo commit SHA. Copy [`examples/codjiflo-reviewer.yml`](examples/codjiflo-reviewer.yml) to `.github/workflows/codjiflo-reviewer.yml` on your repository's **default branch**. Replace both `@main` and `bot-ref: main` with the **same** trusted commit SHA. `main` is usable for development but follows future source changes.
2. Under Settings → Secrets and variables → Actions → Variables, set **`CODJIFLO_APPROVED_USERS`** to comma-, whitespace-, or newline-separated GitHub logins, for example `alice,bob`. Matching is exact and case-insensitive. **Unset/empty means nobody is approved.** Repository ownership, association, collaborator status and write permission do not override this list.
3. Register a trusted persistent self-hosted Actions runner with the consumer repository/organization (`self-hosted` label by default). Install Git, Node 22+, and current `codex` and/or `claude` executables on its PATH. Log in to each CLI **as the runner OS user**, using its normal interactive authentication setup. Do not copy auth files into this repository or Actions artifacts. Set `runner-label` in the caller if using a dedicated custom label.
4. Grant the workflow `contents: read`, `issues: write`, `pull-requests: write` as shown. Organization policy must allow these permissions and bot approvals (see below).
5. Optionally configure the GitHub App below for a dedicated bot identity. Otherwise the workflow uses `GITHUB_TOKEN`.
6. Post an allowed mention on an open PR. A kickoff comment links the workflow run. CLI stdout **and stderr stream live** in the review step's logs. A successful run posts a native `APPROVE` or `REQUEST_CHANGES` review with validated single-/multi-line inline findings on the appropriate LEFT/RIGHT sides.

The reusable workflow first runs an authorization gate on `ubuntu-latest`, **before scheduling self-hosted review work**. Both gate and CLI authorize the original `issue_comment.comment.user.login`, not the user who reruns the workflow. The CLI repeats authorization before any API mutation or provider invocation. The event JSON is the source of truth; workflow runs ignore local requester flags. No `workflow_dispatch` path or caller-supplied event login is supported.

Bot implementation checkout always comes from trusted `vezzadev/codjiflo-reviewer` at `bot-ref`, **never the PR branch**. The target PR is fetched separately into a disposable Git repository, including fork heads via GitHub's accessible commit objects. It is not built or tested by the orchestrator. The review CLI can read files and use Git to inspect context. This is intended for machines/repositories whose users and content you trust; it is not a sandbox or a malicious-input isolation product.

### GitHub identity and permissions

**Recommended: GitHub App.** Create an App, install it on the consumer repository, and grant repository permissions **Contents: read**, **Issues: read/write**, and **Pull requests: read/write**. No webhook subscription is needed. Set repository variable `CODJIFLO_APP_ID` and Actions secret `CODJIFLO_APP_PRIVATE_KEY`. The example passes them to the reusable workflow, which mints a short-lived installation token with `actions/create-github-app-token`. Reviews appear under the App's bot identity. The App needs visibility into the target repository and its PR commits.

**Built-in `GITHUB_TOKEN`:** works where repository/organization policy allows it. Enable Settings → Actions → General → Workflow permissions → **Allow GitHub Actions to create and approve pull requests** if approval is restricted. Its actor is `github-actions[bot]`, not a custom Codjiflo App. GitHub can reject an approval by the PR's own author; bot-created PRs can therefore require a separate App identity. Events created using `GITHUB_TOKEN` generally do not start other Actions workflows; use an App token when downstream review-triggered automation is required. Fork/organization policies may further restrict token writes. An API rejection is a failed run, never silently converted into approval.

Existing CLI authentication is independent of the GitHub token. Subscription/API access, usage limits and model availability remain your responsibility. The code checks provider exit status and structured completion; it does not turn quota/auth errors into a clean review.

## Incremental review and fail-closed publication

Incremental is the default. Each successful native review includes a machine-readable marker:

```html
<!-- codjiflo-reviewer:v1 {"head":"<40-character-sha>","base":"<40-character-sha>"} -->
```

The most recent marked bot review must be an approval whose marker matches its GitHub `commit_id`. Its base must still equal the current base, and its head must be an available ancestor of the new head. Then only changes since that approval are reviewed, with the full current PR diff provided separately for correct inline coordinates. Missing baseline, changed base, rewritten/unavailable history, or a previous changes-requested verdict forces a **full** review. In particular, earlier blocking findings are never silently dropped by incrementally reviewing only newer changes. `full` explicitly requests the merge-base-to-head diff. Full Git history is fetched as needed; there is no shallow-history shortcut.

Each native review is pinned to the inspected head commit. Before publication the bot rereads the PR and rejects changed head/base or a closed PR. There is an unavoidable GitHub API race between that final read and creating the review; `commit_id` still records the exact inspected commit and never claims to have reviewed a newer one. Workflow runs serialize per PR. GitHub's branch protection should dismiss stale approvals if desired.

Malformed JSON, missing structured output, provider failure, contradictory approval with blocking findings, invalid/out-of-hunk ranges, or a stale PR produce **no approval**. Invalid findings fail the entire review rather than being dropped. Failure is reported in a comment and Actions logs. A native changes-requested summary may report a real unanchorable issue without manufacturing a diff line. Each structured finding carries `disposition: "blocking" | "advisory"`; advisory findings may accompany approval.

## Local CLI

```sh
# No npm install needed.
export CODJIFLO_APPROVED_USERS='your-login'
export GITHUB_TOKEN='your-app-installation-token-or-PAT'
node bin/codjiflo-reviewer.mjs --repo owner/repo --pr 123 --requester your-login --preset opus-high --full
```

| Invocation | Behavior |
| --- | --- |
| `node bin/codjiflo-reviewer.mjs` | Uses `GITHUB_EVENT_PATH` for an issue_comment event |
| `node bin/codjiflo-reviewer.mjs --gate` | Authorization/command check only; sets `allowed` in `GITHUB_OUTPUT`; no token/provider/API calls |
| `--repo owner/repo --pr N --requester login` | Trusted local invocation, default `sol-high` incremental; still requires allowlist |
| `--preset PRESET` | Select one of the four presets |
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

Tests cover command parsing, deny-default/exact/case-insensitive authorization, original-sender identity, LEFT/RIGHT and multi-line hunk validation, successful baselines, changed base/history fallback, previous blockers, malformed/contradictory output, provider failures, Claude error events, and stale-head rejection.

The smoke runs the **real entry point and orchestration**, native fetch against a loopback HTTP fixture server, Git fetch/checkout of a real temporary repository, and fake executable Codex/Claude CLIs. It asserts kickoff/native review payloads and range coordinates, exercises both provider adapters and stale-head failure, and performs **no remote writes or real model calls**. Everything is temporary and cleaned up. Hosted CI runs both commands on pushes and PRs; no self-hosted runner or auth is needed for tests.
