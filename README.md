> [!WARNING]
> This is a proof-of-concept repo. Do not rely on it.

# Codjiflo Reviewer

A mention-triggered GitHub PR reviewer for trusted self-hosters. Requires Node.js 22+, Git, and Codex or Claude access. Codex uses its CLI; Claude uses the Anthropic Agent SDK with API keys and falls back to an existing Claude CLI subscription login. No hosted review service or multi-tenant infrastructure.

Comment on an open PR:

```text
@codjiflo-reviewer review
@codjiflo-reviewer review opus-xhigh full
@codjiflo-reviewer review sol-medium
@codjiflo-reviewer review codex
@codjiflo-reviewer review claude full
@codjiflo codex
@codjiflo claude full
@codjiflo sol-medium incremental
```

`@codjiflo` and `@codjiflo-reviewer` are both accepted. The mention must begin a line (leading spaces/tabs are allowed), and the command must stay on that line. Use `@codjiflo review [preset] [full|incremental]` or the shorthand `@codjiflo <preset> [full|incremental]`. Explicit `review` defaults to `sol-xhigh` when no preset is supplied; shorthand requires a known canonical preset or alias immediately after the mention. Commands, presets, aliases, and modes are case-insensitive. After `review`, options are optional and order-independent; both forms allow at most one preset and one mode, and duplicate arguments are rejected. Only newly created issue comments trigger work; editing an existing comment does not.

Bare mentions, casual mentions, unknown shorthand profiles, and mentions inside a sentence do not trigger a review. Once a command starts with `review` or a known profile, unknown options are rejected rather than ignored. For example, `@codjiflo turbo` is ignored, while `@codjiflo review turbo` and `@codjiflo codex turbo` are invalid. Both forms require the same approved original comment author.

## Presets

| Preset | Provider/model default | Model effort | Default e-code-review recipe |
| --- | --- | --- | --- |
| `sol-xhigh` (default; alias `codex`) | Codex / `gpt-6.1-sol` | high | xhigh |
| `opus-xhigh` (alias `claude`) | Claude / `opus` | high | xhigh |
| `sol-medium` | Codex / `gpt-6.1-sol` | medium | high |
| `opus-medium` | Claude / `opus` | medium | high |

Preset names and aliases are case-insensitive in mentions and local `--preset` arguments. Aliases resolve to their canonical preset before kickoff, review publication, and baseline selection; they do not add extra presets. An alias and its canonical name still count as two preset arguments and are rejected together in a mention. `sol-high` and `opus-high` have been replaced by `sol-xhigh` and `opus-xhigh`; the old names are no longer accepted. Model effort remains `high`, and medium presets are unchanged. Historical reviews marked with the old names do not match the new presets, so the next review falls back to full scope.

`CODJIFLO_SOL_MODEL` and `CODJIFLO_OPUS_MODEL` override model IDs. There is no automatic substitution or cross-provider fallback: configure a model available to your account. Claude's `opus` is its supported Opus alias; use a full model ID to pin a release.

When `.codjiflo/code-review/PROMPT.md` is absent, the default high and xhigh methodology uses eight/ten sequential independent angles (no subagent fanout), deduplication without verification, severity ordering, a gap sweep for xhigh, and caps of ten/fifteen findings. These instructions are adapted from the e-code-review skill and embedded for both providers; no skill installation is required on the runner. Structured JSON/native GitHub reviews replace ReportFindings; the unrelated native-observer pilot and later fix reporting are omitted. See `src/prompt.mjs` for the complete instructions.

### Repository-specific review instructions

Optionally commit UTF-8 instructions to `.codjiflo/code-review/PROMPT.md` in the repository being reviewed. Codjiflo loads only a regular Git blob directly from the exact inspected **current PR head** tree, not the worktree, default branch, or bot checkout. Its contents **replace the default methodology, even when empty**, for both Codex and Claude (SDK and CLI fallback). Shared review-only, review-scope, JSON verdict, and native GitHub comment-anchor requirements remain; built-in angles, finding quotas, reporting conventions, and verifier restrictions do not apply to custom methodology. Only an absent file selects the default methodology. Symlinks at the file or any ancestor, directories in place of the file, submodules anywhere along the path, and other read errors fail the review before a provider is invoked.

Incremental reviews reuse a successful approval only when the optional custom prompt has the same regular Git blob identity at the approved head and the current PR head (or is absent at both). Adding, deleting, or changing its content invalidates that baseline and forces a full PR review, including earlier source edits, under the current instructions. Unchanged instructions retain incremental scope when the other baseline requirements are met.

## Install in a consumer repository

1. Make sure this public repository's Actions workflows are usable by your organization. Choose a trusted Codjiflo commit SHA. Copy [`examples/codjiflo-reviewer.yml`](examples/codjiflo-reviewer.yml) to `.github/workflows/codjiflo-reviewer.yml` on your repository's **default branch**. Replace both `@main` and `bot-ref: main` with the **same** trusted commit SHA. `main` is usable for development but follows future source changes.
2. Under Settings → Secrets and variables → Actions → Variables, set **`CODJIFLO_APPROVED_USERS`** to comma-, whitespace-, or newline-separated GitHub logins, for example `alice,bob`. Matching is exact and case-insensitive. **Unset/empty means nobody is approved.** Repository ownership, association, collaborator status and write permission do not override this list.
3. Register a trusted Linux self-hosted Actions runner with the consumer repository/organization (`self-hosted` label by default). Install Git, Node 22+, and current `codex` and/or `claude` executables on its PATH. Log in to each CLI **as the runner OS user**, using its normal interactive authentication setup. For Claude API access, configure the local key pool below. Do not copy auth files into this repository or Actions artifacts. Set `runner-label` in the caller if using a dedicated custom label.
4. Grant the workflow `contents: read`, `issues: write`, `pull-requests: write` as shown. Organization policy must allow these permissions and bot approvals (see below).
5. Optionally configure the GitHub App below for a dedicated bot identity. Otherwise the workflow uses `GITHUB_TOKEN`.
6. Post an allowed mention on an open PR. A kickoff comment links the workflow run. CLI stdout/stderr and SDK events stream live in the review step's logs. A successful run posts a native `APPROVE` or `REQUEST_CHANGES` review with validated single-/multi-line inline findings on the appropriate LEFT/RIGHT sides.

The reusable workflow first runs an authorization gate on `ubuntu-latest`, **before scheduling self-hosted review work**. Both gate and CLI authorize the original `issue_comment.comment.user.login`, not the user who reruns the workflow. The CLI repeats authorization before any API mutation or provider invocation. The event JSON is the source of truth; workflow runs ignore local requester flags. No `workflow_dispatch` path or caller-supplied event login is supported.

Bot implementation checkout always comes from trusted `vezzadev/codjiflo-reviewer` at `bot-ref`, **never the PR branch**. The target PR is fetched separately into a disposable Git repository, including fork heads via GitHub's accessible commit objects. It is not built or tested by the orchestrator. The review CLI can read files and use Git to inspect context. This is intended for machines/repositories whose users and content you trust; it is not a sandbox or a malicious-input isolation product.

This repository runs its own instance through [`.github/workflows/codjiflo.yml`](.github/workflows/codjiflo.yml). It uses the `codjiflo-reviewer` runner label and the existing `Codjiflo` GitHub App. The local reusable workflow and bot checkout use the same default-branch revision. Approved users and App credentials remain in repository Actions variables/secrets; consumer repositories should use the example workflow above.

### GitHub identity and permissions

**Recommended: GitHub App.** Create or reuse an App, install it on the consumer repository, and grant repository permissions **Contents: read** and **Pull requests: read/write**. Pull-request write permission also permits comments on PR conversations; Issues write permission is not required. No webhook subscription is needed. Set repository variable `CODJIFLO_APP_ID` and Actions secret `CODJIFLO_APP_PRIVATE_KEY`. The example passes them to the reusable workflow, which mints a short-lived installation token with `actions/create-github-app-token`. Reviews appear under the App's bot identity. Reusing an App does not require changing its OAuth callbacks, existing keys, or other installations.

**Built-in `GITHUB_TOKEN`:** works where repository/organization policy allows it. Enable Settings → Actions → General → Workflow permissions → **Allow GitHub Actions to create and approve pull requests** if approval is restricted. Its actor is `github-actions[bot]`, not a custom Codjiflo App. GitHub can reject an approval by the PR's own author; bot-created PRs can therefore require a separate App identity. Events created using `GITHUB_TOKEN` generally do not start other Actions workflows; use an App token when downstream review-triggered automation is required. Fork/organization policies may further restrict token writes. An API rejection is a failed run, never silently converted into approval.

Existing CLI authentication is independent of the GitHub token. Subscription/API access, usage limits and model availability remain your responsibility. The code checks provider exit status and structured completion; it does not turn quota/auth errors into a clean review.

Provider work has one 45-minute limit, including all Claude key attempts and CLI fallback; the review job has a 55-minute limit, below the GitHub App token's one-hour lifetime. Timeouts stop the provider and enter the normal failure-reporting path. A runner shutdown or forced workflow cancellation may prevent the failure comment and temporary-checkout cleanup; check the workflow logs in that case.

### Claude API pool and subscription fallback

Configure exactly three distinct Anthropic API keys **on the runner host, as the runner OS user**:

```sh
npm ci --omit=dev
node scripts/claude-keys.mjs configure
node scripts/claude-keys.mjs status
```

`configure` hides key input and writes `~/.config/codjiflo/anthropic-keys.json` with mode `0600`. Each entry has an `id`, `apiKey`, and optional `quotaGroup` (defaults to its ID). For automation, `configure --stdin` accepts `{"keys":[...]}` through a secure pipe; never put secrets in command arguments, Git, workflow YAML, or comments. A present but invalid or insufficiently private file fails the review. An absent file selects OAuth-only CLI mode.

Keys sharing a quota must use the same quota group. Anthropic limits are organization-wide, with optional workspace limits: three keys from one pool do **not** triple capacity. See [Anthropic's rate-limit documentation](https://platform.claude.com/docs/en/api/rate-limits).

All runners under the same OS account share `~/.local/state/codjiflo/claude-routing.json`. A short cross-process lock protects atomic round-robin selection and quota updates; it is not held during reviews. State contains fingerprints and availability metadata, not API keys. Concurrent jobs can use the same key after the cursor wraps.

- Each review tries an eligible key through `@anthropic-ai/claude-agent-sdk`; each key is attempted at most once per review.
- Recognized quota failures make that key's quota group unavailable. Temporary rate limits use the SDK's retry delay when exposed, otherwise a 60-second cooldown. The pinned SDK can emit terminal 429 errors without HTTP headers, so `Retry-After` is not always available. Explicit credit/spend exhaustion waits for a known reset, a replacement key, or operator reset.
- When no eligible key remains, the review restarts through the installed Claude CLI using its subscription login. This includes a missing key file.
- Authentication, model, network, schema, and unrelated provider errors fail the review; they do not silently switch credentials. Partial attempts never publish a review.

Use `node scripts/claude-keys.mjs status` to inspect availability without exposing secrets. After replenishing credits or raising a cap, run `node scripts/claude-keys.mjs reset api-1` (or omit IDs to reset all blocks). Reset without IDs also recovers corrupt routing state. A stale lock requires confirming its owner is no longer running before removal.

Override paths with `CODJIFLO_ANTHROPIC_KEYS_FILE` and `CODJIFLO_CLAUDE_STATE_FILE` in the runner service environment; every runner sharing a pool must use the same state file. No Actions secret is required for these API keys. Configured key values are redacted from provider logs. API mode honors an explicitly configured `ANTHROPIC_BASE_URL`; that endpoint receives the selected key and must be trusted. OAuth fallback removes this override and verifies the CLI's subscription authentication before use.

The SDK receives API credentials only. OAuth fallback stays in the separately installed, normally authenticated Claude CLI; Codjiflo does not extract or reuse its OAuth tokens in the SDK. Anthropic restricts third-party use of claude.ai login in SDK products; see the [Agent SDK authentication guidance](https://code.claude.com/docs/en/agent-sdk/quickstart).

The reusable workflow installs the pinned SDK only for authorized Claude jobs, before minting the GitHub App token. Codex jobs and the hosted authorization gate need no npm dependencies. Keep npm optional dependencies enabled: they include the SDK's native executable.

### Prepare offline review prerequisites

Use the optional `prepare-command` input for trusted host-side setup. It runs from the bot checkout after authorization and before the App token is minted or either reviewer CLI starts. A nonzero exit stops the job without submitting a review. Preparation has a five-minute limit; commands come from the consumer's trusted workflow, not PR content.

For repositories requiring the `developing-solidworks` reference:

```yaml
with:
  prepare-command: node scripts/prepare-solidworks-docs.mjs
```

The helper resolves the enabled Codex plugin through `codex plugin list --json` and provisions its exact versioned skill directory from an installed Claude offline bundle. It copies reference data only, preserving skill instructions, scripts, and learnings. A valid target is reused without requiring the source cache; an absent or incomplete bundle fails preparation. Plugin-version changes select a new target automatically.

Install the source bundle once as the runner user before enabling this input. Preparation does not download documentation or invoke PowerShell. Codex retains `--sandbox read-only`, and reviews can read the prepared docs even when the skill's optional online freshness check is unavailable. Local CLI users should run the same preparation command before invoking the reviewer.

Concurrent preparation waits up to 30 seconds for a live lock owner, then checks the cache again. A stale lock fails with cleanup instructions instead of silently accepting unfinished data.

### Review parallelism

Each self-hosted runner process executes one job at a time. To allow more simultaneous reviews, register additional runners with the same configured label and separate installation/work directories and services. They may share a machine, subject to its resources and the provider account's quotas. The per-PR concurrency group still serializes reviews of the same PR. `strategy.max-parallel` applies to matrix jobs and does not control this workflow.

## Incremental review and fail-closed publication

Incremental is the default. Each successful native review includes a machine-readable marker:

```html
<!-- codjiflo-reviewer:v3 {"head":"<40-character-sha>","base":"<40-character-sha>","preset":"sol-xhigh"} -->
```

The most recent current-version marked review must be an approval whose marker matches its GitHub `commit_id`, current base, and requested preset. Both App/bot and PAT-authored reviews participate. Its head must be an available ancestor of the new head. Then only changes since that approval are reviewed. Missing baseline, changed base or preset, rewritten/unavailable history, a previous changes-requested verdict, or a same-head rerun forces a **full** review. Earlier blocking findings are revisited rather than discarded. `full` explicitly requests the merge-base-to-head diff. Full Git history is fetched as needed.

Replacement semantics invalidate all legacy `v1` and `v2` review markers: only `v3` markers qualify as incremental baselines. Unsupported versions are ignored, not migrated or treated as errors. Without a usable `v3` approval, the next review covers the full PR under the current instructions, even if `.codjiflo/code-review/PROMPT.md` already existed unchanged at both heads. A new `v3` approval can establish an incremental baseline for subsequent changes.

Inline coordinates come from GitHub's paginated PR file patches, including the current filename for renamed files. LEFT endpoints must be deleted lines; RIGHT endpoints may be added or unchanged context lines. Local Git diffs supply review scope, not publication coordinates. Missing or truncated patches provide no valid anchors: findings on them go into the review summary and require changes. PRs exceeding GitHub's 3,000-file metadata limit fail without a verdict.

Each native review is pinned to the inspected head commit. Before publication the bot rereads the PR and rejects changed head/base or a closed PR. There is an unavoidable GitHub API race between that final read and creating the review; `commit_id` still records the exact inspected commit and never claims to have reviewed a newer one. GitHub's branch protection should dismiss stale approvals if desired.

Only authorized review jobs enter the per-PR concurrency group. Unrelated comments and denied requests cannot displace queued reviews. GitHub retains one running and one pending job per group: a newer authorized request replaces an older pending request, without cancelling the running review.

Malformed JSON, missing structured output, provider failure, contradictory approval with blocking findings, or a stale PR produce **no approval**. Invalid/out-of-hunk locations are preserved as summary findings and force `REQUEST_CHANGES`; they are not dropped or assigned invented coordinates. Failures are reported in a comment and Actions logs when the runner and API remain available. Each structured finding carries `disposition: "blocking" | "advisory"`; correctly anchored advisory findings may accompany approval.

## Local CLI

```sh
# Required for Claude SDK API-key reviews; Codex needs no npm install.
npm ci --omit=dev
export CODJIFLO_APPROVED_USERS='your-login'
export GITHUB_TOKEN='your-app-installation-token-or-PAT'
node bin/codjiflo-reviewer.mjs --repo owner/repo --pr 123 --requester your-login --preset claude --full
```

| Invocation | Behavior |
| --- | --- |
| `node bin/codjiflo-reviewer.mjs` | Uses `GITHUB_EVENT_PATH` for an issue_comment event |
| `node bin/codjiflo-reviewer.mjs --gate` | Authorization/command check only; sets `allowed` and `provider` in `GITHUB_OUTPUT`; no token/provider/API calls |
| `--repo owner/repo --pr N --requester login` | Trusted local invocation, default `sol-xhigh` incremental; still requires allowlist |
| `--preset PRESET` | Select one of the four canonical presets or the `codex`/`claude` aliases |
| `--full` | Full review in local invocation |
| `--help` | Print usage |

Local `--requester` is an operator assertion, not remote authentication. Do not expose this CLI as an unauthenticated service. Event-based runs always use the original event author instead.

Other environment: `GH_TOKEN` is a fallback for `GITHUB_TOKEN`; `GITHUB_API_URL` supports GitHub Enterprise/the fixture server; PR metadata supplies its clone URL. `CODJIFLO_CODEX_BIN`/`CODJIFLO_CLAUDE_BIN` override executable paths (also used by fixtures). `GITHUB_RUN_ID`/`GITHUB_SERVER_URL` build kickoff links. The reusable workflow exposes `sol-model`, `opus-model`, `runner-label`, optional `app-id`, and optional `prepare-command` inputs.

Codex uses `exec --model -c model_reasoning_effort=... --sandbox read-only --json --output-schema --output-last-message`, with its prompt on closed stdin. Claude SDK queries use the preset model/effort, JSON-schema output, `Read`, `Grep`, `Glob`, and `Bash` tools, `dontAsk` permissions, strict MCP configuration, and no session persistence. CLI fallback uses the equivalent `--print --output-format stream-json --verbose --json-schema` flags. Both Claude paths require a successful terminal result, no `is_error`, and `structured_output`; the orchestrator independently validates the review. Keep the installed CLIs recent enough to support these flags. External MCP configurations are not loaded.

## Development and deterministic verification

```sh
npm ci
npm test
npm run smoke
```

Tests cover authorization, native review coordinates, incremental baselines, malformed results, stale-head rejection, subprocess deadlines, cross-process key rotation, quota-group cooldowns, exhaustion/reset, key replacement, secret redaction, and non-quota failure handling.

The smoke runs the **real entry point and orchestration**, native fetch against a loopback GitHub fixture, Git fetch/checkout of a temporary repository, and fixture Codex/Claude executables. It checks native review payloads and LEFT/RIGHT ranges, plus stale-head rejection.

A second smoke runs the **installed Agent SDK and its native executable** against a local streaming Messages API. It covers structured review publication, three-key credit exhaustion, and HTTP 429 cooldown/rotation into fixture OAuth fallback, with exactly one native review per scenario. It does not replace the SDK with a mock. Both smokes use temporary credentials/state, make no paid model calls or remote writes, and clean up afterward. Hosted CI runs them with the test suite; no self-hosted runner or live authentication is needed.
