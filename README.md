# CoNest Harness Core — reconstruction prototype

Independent reconstruction prototype, Node.js >=24.16 <25. Strict TypeScript sources compile to native ES modules and declarations.
This does not replace or modify the existing CoNest installation. The optional DSH adapter uses an isolated pinned upstream runtime; the compiled control-plane core has no third-party runtime dependencies. Development dependencies are exactly pinned in package.json and package-lock.json.

```sh
npm ci
npm run typecheck
npm run test:types
npm run build
npm test
npm run check
npm run demo
```

The default demo registers a deterministic provider, starts an instance, admits a task, emits correlated events and releases the instance.
`src/types.mts` defines Provider, Instance, task, event and lifecycle contracts; `contracts.mts` implements runtime validation;
`registry.mts` owns provider registration; `manager.mts` owns instance lifecycle, admission, generations and cancellation; `testing.mts` is a synthetic provider.

Providers implement `{id, version, protocolVersion, features, validateConfig, createInstance}`.
Instances implement async `start()`, `run(admittedTask, {signal, emit})`, `stop()`.
See `examples/demo.mjs` for the complete public usage example and `test/` for failure behavior.

## Static contract checks

- `npm run typecheck`: strict no-emit checking for every src/**/*.mts module plus positive/negative contract fixtures. No SDK installation is needed for this check.
- `npm run test:types`: checks the project, then removes expected-error markers in a temporary copy and proves all 14 invalid contracts produce diagnostics. An overall successful command is the expected result.
- `npm test`: first runs typecheck and builds, then executes 61 runtime behavior tests against compiled dist/.
- `npm run check`: typecheck plus syntax checks for JavaScript tooling/tests and framework import-boundary checks.
- `npm run build`: compiles source under strict settings, refuses emit on errors, and produces .mjs and .d.mts.

Negative fixtures reject missing stop(), wrong task input/permission types, an unsupported execution mode, malformed events, authority mutation, unchecked unknown results, missing DSH resolver, invalid deadlines, invalid tool states and literal model credentials.
Runtime configuration/RPC data remains unknown until validated; compile-time types do not validate external JSON or implement a security sandbox.
JavaScript behavior tests and utility scripts are syntax/runtime-tested, not all statically typed. Upstream SDK internals are not retyped by this project; dynamic transport import is an explicit checked interop boundary.

## Pinned DSH integration

`runtime.lock.json` fixes the CoNest source commit, SDK archive/manifest hashes, pnpm lock hash, package manager and private worker protocol.
The preparation script exports only committed source bytes from the specified clean CoNest checkout, then independently bootstraps and installs dependencies.
It never copies another checkout's .local, node_modules or SDK directory. Do not change the pin just to make installation pass.

```sh
npm run prepare:runtime -- /absolute/path/to/CoNest
npm run build
npm run test:dsh
npm run test:upstream
npm run demo:dsh
```

Preparation downloads the exact SDK from its pinned upstream release. It refuses to overwrite an existing runtime.
The resulting `.vendor/conest` has its own package-manager pin and installation. Run preparation separately in every checkout.
The dependency freeze is enforced during install; a build-file seal catches accidental local drift before transport import.
The seal is not an adversarial signature and does not hash every installed transitive dependency.

`createDshProvider()` isolates DSH-specific setup and RPC. `createDshHostBinding()` supplies the `runHarnessAgent` seam consumed by the unchanged OpenClaw HarnessV2 adapter.
The existing adapter remains responsible for finalized host authority, prompt hooks, approvals and transcript mapping. A binding cannot manufacture those rights.
Production routes may be supplied through the trusted `resolveModelRoute` service; credentials are not accepted in instance JSON and live requests were not run during this stage.
The research core owns its own child Host, not the user's running Gateway. There is no automatic wiring to the current Studio yet.

All integration tests and `demo:dsh` use the internal proof model with real DSH processes. Their host tools return deterministic synthetic data; the demo does not execute a real shell command or paid model call.

## Boundaries

- Core administrative APIs are trusted in-process APIs. The local Studio authenticates with a full-management bearer token and supplies the fixed studio subject; no multi-user roles are implemented.
- Instance policy gates task admission; runtime task-access revocation also cancels existing work and invalidates mediated callbacks. They are not a filesystem/network sandbox and do not constrain arbitrary trusted provider JavaScript.
- Stop currently cancels active tasks, then waits for actual settlement. Noncooperative work remains tracked after caller timeout.
- An unconfirmed stop marks the instance failed and retains ownership; this prototype does not kill processes.
- start/create/stop provider hooks must settle cooperatively; there is no hard process watchdog in step 1.
- The DSH adapter now reuses/resets its upstream sessions using host lifecycle identities. A generic session API, durable manager storage, restart backoff, quotas, fine-grained dynamic policy and tool publishing remain later stages.
- Observer events are best-effort, in-memory and carry no durable audit guarantee. Applications must redact provider payloads before persistence.
- No deployment daemon, UI migration, expanded framework compatibility claim or untrusted-plugin isolation is provided. Native evidence currently applies only to the tested macOS arm64 environment.

Research, baseline and implementation records are under `agent-record/`. Those records are local research material and are not upstream release documentation.

## Configuration: first increment

Proposed contract: [configuration design](agent-record/03-config-contract.md). Only the documented first increment is implemented: parallelism and control deadlines. localShell remains explicitly unsupported. See [work record](agent-record/work.md#p3-config).

Run `npm test` for parser/CAS/storage checks and `npm run test:dsh` for actual safe-tool parallelism at 1 and 2. Preview JSON using `node scripts/config.mjs /absolute/config.json`. On a fresh runtime, apply `node scripts/apply-config-overlay.mjs /absolute/path/to/pinned/CoNest` after preparation, then build. The runtime is a research overlay, not unmodified upstream. See [implementation scope](agent-record/work.md#p3-implementation).

## Reconstruction Studio (proof mode)

Run `npm run studio`, open the printed URL (default port 18801), and enter the token from `.local/reconstruct-studio/connection.json`. Start the instance, run the tool preset, then try the waiting preset and cancel it. This is the independent reconstruction UI, not the original CoNest Studio. No API key, paid inference or real Shell execution. Jobs are in-memory; no browser visual qualification has been performed. See [manual acceptance](agent-record/04-studio.md).


## Configuration-driven Studio startup

`npm run studio` creates `.local/reconstruct-studio/instances.json` on first use and reads it on subsequent starts. Existing files are never overwritten. Set `CONEST_RECONSTRUCT_CONFIG` to use an explicit file; missing or invalid explicit configuration fails startup without fallback. Every instance is validated before the HTTP server or any Harness process starts. Instances initially remain stopped (or disabled).

```sh
node examples/studio-config.mjs
CONEST_RECONSTRUCT_CONFIG="$PWD/.local/studio-multi/instances.json" npm run studio
```

The example creates two independent DSH proof instances and a synthetic `test.echo` instance. It refuses to overwrite the example config. Select an instance in Studio, start it, and run the proof preset for DSH or arbitrary text for test.echo. No model API calls or real Shell commands are used.

Config uses the existing schemaVersion/providerConfigVersion 1 contract. Provider workspace and session paths must be absolute; workspaces must already exist. DSH session roots must not overlap, including symlink aliases. Provider modules are registered by trusted application code; JSON cannot load arbitrary code or credentials. Task deadlines, stop grace and admission policy come from each configured instance. The Studio subject is `studio`; DSH proof requires `host:tools` permission.

Configuration is read at startup, with no file watcher or page editor. Stop Studio, edit the file, and restart to change the catalog. `connection.json` continues to contain only URL, local access token, mode and PID; it is not instance configuration. Failed startup can leave an older connection file, which is not a liveness check. Jobs remain in memory.

Run `npm test` (61 behaviors), `npm run test:types` (14 negative contracts), `npm run check`, and `npm run test:dsh` (13 real integration tests). The latter verifies two DSH instances, cancellation isolation, custom configuration, default preservation across restarts and invalid-start refusal. See [current scope and manual acceptance](agent-record/04-studio.md).


## Live tasks with read-only workspace tools

The default remains proof. Explicit live mode uses instance `providerConfig.model` with `name` and `credentialRef: "env:DEEPSEEK_API_KEY"`; literal keys and endpoint URLs are rejected in instance JSON. The launcher fixes the official endpoint and accepts only text model names declared by the pinned runtime. This does not update the SDK or guarantee account/model availability.

```sh
node examples/studio-live.mjs
# Export DEEPSEEK_API_KEY securely in the launching environment before starting.
CONEST_RECONSTRUCT_MODE=live \
CONEST_RECONSTRUCT_CONFIG="$PWD/.local/studio-live/instances.json" \
CONEST_RECONSTRUCT_STATE="$PWD/.local/studio-live" \
CONEST_RECONSTRUCT_PORT=18803 \
npm run studio
```

The example creates synthetic files for two isolated instances, without accessing credentials or a model. Connect with the new token in `.local/studio-live/connection.json`, start an instance and submit a task. Live task submission can incur API costs; starting Studio does not call a model. Known credentials are redacted before tool data reaches the model and before trace truncation/display.

Only `read_file`, `list_files` and `search_text` are published to the live DSH turn. Policy must grant `studio` subject and `workspace:read`. Workspaces and session roots cannot overlap. Tools reject parent/absolute paths, hidden/env files and symlinks; reads are UTF-8/64KiB maximum and scans/results are bounded. These are application tool restrictions in a trusted local environment, not an operating-system sandbox for malicious provider code or concurrent filesystem adversaries. Provider sessions can persist authorized file content.

Studio shows correlated task/tool events, elapsed time, bounded result previews and safe failure codes. Jobs/events are in memory; cancellation/timeout gates late callbacks, but hard lifecycle isolation and dynamic revocation remain later work.

Validated: 61 behaviors, 14 negative type contracts, 13 DSH integrations and 8 pinned upstream regressions. Live integration uses a deterministic local model endpoint with the real provider transport, DSH process and file tools; no paid DeepSeek request or browser visual/click acceptance was run. See [startup, proxy and manual acceptance](agent-record/05-live-studio.md).


## P5 runtime access, failure and lifecycle status

`manager.setTaskAccess(instanceId, false)` immediately refuses new tasks and revokes in-flight work. Restoring access affects future tasks only. This is an in-memory instance-wide override, not a persisted policy edit. The execution context supplies `assertAuthorized()`; DSH checks it before/after mediated callbacks alongside the parent host authority and cancellation signal.

Providers can implement `setFailureHandler()` to report declared safe failures. DSH wires the owned client failure hook so active or idle process death marks the instance failed and in-flight tasks interrupted. Old runtime notifications cannot affect replacement generations; failed tasks are never replayed automatically. Stop/confirm cleanup, then explicitly start again.

Snapshots expose ownership, taskAccess and resourceState. Studio separately shows the task terminal state and whether its actual work has settled. A completed/cancelled caller does not imply all resources are released. Stop grace now covers task settlement and the provider stop hook; timeouts retain ownership and the cleanup promise. Late success can confirm release, but does not auto-restart. No universal hard kill or startup watchdog is implemented.

The existing connection.json token keeps full local management access. A new `viewer-connection.json` in the same state directory supplies a read-only token. HTTP scopes distinguish state reading, instance control, task submission/cancellation and access management; control does not imply reading job data. Tokens remain local shared credentials, not a multi-user identity system.

Studio now presents instance cards, state-dependent buttons, translated errors, grouped tool calls and explicit truncation notices. Automated API, state-model and script checks pass. Browser visual/click acceptance could not run: no browser connection was available and native Computer Use permission was denied. See [P5 contract, manual acceptance and remaining work](agent-record/06-p5-lifecycle.md).
