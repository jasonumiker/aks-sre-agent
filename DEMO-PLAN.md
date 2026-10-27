# AKS + Azure SRE Agent: conference booth demo

## Recommendation

Build a **"Break it. Watch the agent fix it."** experience around a small
application on AKS, deployed through Argo CD.

A visitor selects one of three failures. A real Git change breaks the
application; Azure SRE Agent investigates the actual symptoms, makes a corrective
Git change, and Argo CD restores service. A booth dashboard shows the outage,
evidence, repair commit, deployment, and verified recovery.

**Keep Git as the source of truth for both the fault and the fix.** Do not
demonstrate a live Kubernetes patch that Argo CD will subsequently overwrite.

Prioritize one excellent scenario before adding the other two. Target roughly
one to two minutes from click to recovery, but treat latency as an acceptance
test, not a promise about the managed agent service.

## Assumptions and boundaries

- Dedicated demo subscription or isolated resource group; no customer workloads.
- One shared booth experience, with one active incident at a time.
- Synthetic data only, no payment processing, personal information, or database.
- GitHub for the initial implementation; Argo CD deploys a dedicated demo branch.
  Confirm the customer's preferred Git provider before implementation.
- Visitors can choose a scenario, not enter commands, prompts, manifests, or URLs.
- Autonomous remediation is explicitly enabled only for the demo's narrow scope,
  after initial testing in Review mode.
- The three incidents affect workloads and Kubernetes configuration, not the AKS
  control plane. Actual node or infrastructure failures are out of scope initially.

## Visitor experience

Use an engaging storefront or conference ticket checkout. The checkout API runs
on AKS; the storefront and demonstration controls remain available during faults.

1. **Healthy:** successful synthetic orders and a green application indicator.
2. **Choose:** "Disconnect checkout", "Break its configuration", or
   "Make its pods unschedulable".
3. **Observe:** the fault commit appears, Argo CD deploys it, and real requests fail.
4. **Investigate:** show timestamped evidence and the agent's concise explanation.
5. **Repair:** show the agent-authored corrective diff and Argo CD reconciliation.
6. **Verify:** successful orders return and the timer stops after sustained health.
7. **Ready again:** reconcile the baseline, close the run, and unlock the buttons.

The display should answer four questions without requiring visitors to read logs:

- What is broken?
- What evidence did the agent find?
- What did it change?
- How do we know the application works again?

Show actual observations and actions, not a simulated agent transcript. If agent
progress cannot be retrieved through a supported API, keep the Azure SRE Agent
portal on a second screen and show only independently verifiable events in the
custom dashboard.

## Architecture

```text
Visitor browser / booth display
             |
             v
Always-on demo controller + dashboard (Azure Container Apps)
  |          |                         |
  |          | real synthetic traffic  | authenticated HTTP trigger
  |          v                         v
  |      Checkout API on AKS       Azure SRE Agent
  |          ^                     |       |
  |          |                     |       +-- reads Kubernetes evidence,
  |          |                     |           logs, Git history, runbook
  |          |                     v
  +------> GitOps repo <------ constrained Git repair tool
             |
             | signed Git webhook / application refresh
             v
          Argo CD ----------------> AKS workload reconciliation
```

### Components

| Component | Purpose and proposed implementation |
| --- | --- |
| Demo application | Small TypeScript/Node.js checkout API with startup validation, readiness, liveness, structured logs, and a real functional checkout endpoint. |
| AKS | Small dedicated cluster with sufficient spare capacity; separate system/demo node pools if budget permits. No node provisioning in the critical path. |
| GitOps | Argo CD, a dedicated Application/AppProject, Kustomize base and booth overlay, pinned image digest, automatic sync and self-healing. |
| Dashboard/controller | Always-on Container Apps service; owns the run lock, scenario injection, traffic generator, timing, event stream, and operator reset. It is not deployed inside the workload being broken. |
| Azure SRE Agent | One narrowly scoped custom agent with application topology, Git locations, diagnostic guidance, read tools, and constrained repair tools. |
| Git integration | Repository-scoped GitHub App. Prefer native supported tools when their permissions meet the scope; otherwise expose a small authenticated MCP repair service. |
| Telemetry | Application Insights and Log Analytics for investigations/audit; direct HTTP probes and Kubernetes API reads for fast detection and verification. |
| Persistent run state | Small Azure Table Storage store for run ownership, lease/lock, execution/thread IDs, commit SHAs, timestamps, status, and recovery history. |

Use Bicep for Azure resources and Kubernetes/GitOps manifests for application
resources. Avoid a service mesh, database, general-purpose chaos platform, and
additional incident-management product in the first version.

## Three proposed failures

All faults are valid, narrowly scoped manifest changes committed to the booth
branch. They must pass normal syntax validation while intentionally producing
an operational failure.

| Button | Fault injected through Git | Evidence the agent should find | Persistent repair | Why it suits a booth |
| --- | --- | --- | --- | --- |
| **Disconnect checkout** | Change the checkout Service's `targetPort` to an unused port. | Failed functional requests; healthy pods; Service port does not match the container's listening port. | Correct the Service port in Git. | Fastest scenario; no image pull or pod replacement required. Strong first milestone. |
| **Break its configuration** | Change a Deployment environment setting to a value the API rejects during startup. | Unavailable pod; startup validation error; relevant configuration diff. | Restore the valid setting in Git. | Obvious logs and root cause; illustrates configuration-aware diagnosis rather than blind restarts. |
| **Make its pods unschedulable** | Add a node selector that matches no node. | Pending pod; `FailedScheduling` event; node labels do not satisfy the selector. | Remove the erroneous selector in Git. | Demonstrates Kubernetes scheduling diagnosis without damaging nodes or waiting for infrastructure recovery. |

For the booth overlay only, use a single checkout replica and a `Recreate`
deployment strategy so deployment faults produce visible downtime rather than
leaving an old healthy replica serving traffic. Explain that this is a deliberate
demo simplification, not a production availability recommendation.

For crash and scheduling recovery, warm the pinned image on every eligible demo
node and use `IfNotPresent`. Test startup/readiness settings and crash-loop
replacement behavior. A repair should create a healthy new pod, not wait for an
old container's restart backoff.

Do not start with node drains, cluster deletion, AKS upgrades, DNS outages, expired
credentials, or storage corruption. Their duration or blast radius makes them
poor short-turnaround conference scenarios.

## GitOps semantics: avoid a misleading demonstration

Argo CD self-healing fixes drift between Git and the cluster. It does not infer
that a syntactically valid configuration committed to Git is operationally wrong.
That is the useful division of responsibility:

1. Controller commits the selected fault to Git.
2. Argo CD faithfully applies that desired state.
3. An independent probe observes a real failure.
4. SRE Agent gathers evidence and selects a corrective manifest change.
5. The change is committed to Git.
6. Argo CD applies it.
7. Independent application checks prove recovery.

Leave Argo CD self-healing on. Do not pause it to make a live patch appear durable.
Use Git reverts/corrective commits rather than an Argo CD rollback operation.

### Change governance

For the booth, permit automatic corrective commits on a dedicated, nonproduction
branch. Surface the exact diff and identity in the UI.

For a production discussion, show the alternative: the agent opens a PR, policy
checks run, and a human or authorized automation merges it. Do not imply that
unreviewed production changes are necessary for the concept to work.

The repair interface must enforce allowed repository, branch, resource, path,
field, and value constraints in code. Prompts are not an authorization boundary.
Use expected-head SHA checks so a stale agent execution cannot overwrite a newer
run or an operator reset.

A narrow repair tool can accept a run ID, expected commit SHA, resource/field,
proposed value, and evidence summary. It validates the requested diff and commits
it. It must not secretly diagnose the incident or pick the repair for the agent.
The controller's baseline reset is a separate operator action.

## Fast triggering and honest timing

Microsoft documents authenticated **HTTP triggers** that invoke a selected
agent/custom agent, return HTTP 202, and provide a thread ID. Use this as the
primary booth trigger after a probe has observed the fault.

The controller invokes the trigger using managed identity, with the documented
`Microsoft.App/agents/threads/write` permission scoped to the agent resource.
Never put Azure tokens or the trigger's invocation credentials in the browser.

Pass the run ID, AKS resource/namespace, affected endpoint, observed symptoms,
timestamps, and Git repository reference. Do not pass the selected button,
injected fault description, or a prescribed answer. The agent can discover the
recent manifest change as part of its investigation.

Use one generic handler so routing does not reveal the scenario. Instruct it to:

1. Read the current application, pod, event, and Service state.
2. Compare relevant live configuration with recent Git changes.
3. Explain the cause using concrete evidence.
4. Make the smallest authorized correction in Git.
5. Verify deployment and functional recovery; escalate if evidence is inconclusive.

This is a **probe-triggered investigation**, not a claim that Azure Monitor
independently discovered the outage. Add an optional production-style path using
Azure Monitor alerts and incident response plans later. Measure its latency
separately, and prevent it from launching duplicate repairs during booth runs.

### Remove avoidable delays

- Use Git webhooks to refresh Argo CD immediately. Its normal polling can take
  up to roughly three minutes with the documented defaults.
- Authenticate webhooks and protect/rate-limit their ingress.
- For private Argo CD, use a reachable, validated relay or a controller-requested
  application refresh after commits; do not expose the admin UI publicly.
- Keep the dashboard/controller and any repair service warm.
- Make repairs as manifest-only changes. No builds, image pushes, or new nodes.
- Avoid GitHub Actions runner startup in the critical remediation path.
- Use direct pod/events/probe evidence first; do not wait for log ingestion.
- Provide concise topology and diagnostic guidance, not a large runbook search.
- Preflight all credentials, endpoints, permissions, and tools before the booth opens.

### Timing targets to prove in rehearsal

| Measurement | Initial target |
| --- | --- |
| Visitor click to observed fault | 5-20 seconds |
| Observed fault to accepted agent invocation | Under 5 seconds |
| Agent invocation to corrective Git commit | 20-60 seconds, subject to measured service/tool latency |
| Corrective commit to sustained functional recovery | 5-30 seconds |
| Overall click to verified recovery | Aim for 60-120 seconds; launch gate: p95 at most 180 seconds |
| Verified recovery to ready for next visitor | At most 20 seconds |

These are engineering targets, not Azure service guarantees. Record every phase
so slow detection, agent execution, Git integration, and reconciliation can be
distinguished. Show elapsed wall-clock time, including trigger/service delays.

If sub-30-second recovery is a hard requirement, an agent-led end-to-end loop may
not meet it. A deterministic runbook is a different demonstration and must be
labelled as such; never present a scripted reset as autonomous agent recovery.

## Booth resilience and safety

### State and concurrency

Persist a run state machine:

```text
READY -> INJECTING -> FAULT_OBSERVED -> INVESTIGATING
      -> REPAIRING -> VERIFYING -> RECOVERED -> RESETTING -> READY
```

Any stage can transition to `FAILED` or `OPERATOR_REQUIRED`.

- Acquire a durable, exclusive run lock before accepting a button press.
- Reject concurrent presses with a visible "demo in progress" message.
- Use a unique run ID in events, commits, probes, and repair authorization.
- Make event handling idempotent and deduplicate trigger retries.
- A trigger timeout may mean the request was accepted: inspect execution history
  before resubmitting. Do not blindly create duplicate agent threads.
- Lock/lease expiration must not automatically admit another visitor while an
  earlier agent may still be running.
- Timebox the run at 180 seconds initially. Show the failure honestly and offer
  an operator reset rather than spinning indefinitely.

### Reset

The operator can stop a run, revoke its repair authorization, and commit the
known-good baseline. Reject late writes from the old agent using run ID and
expected-head checks, even if its execution cannot be cancelled.

Argo CD then reconciles the baseline. Mark the demo ready only when:

- Git contains the expected baseline and Argo CD reports the intended revision.
- Argo CD is Synced and Healthy, with expected pods ready.
- Ten consecutive real checkout requests succeed over at least ten seconds.
- No old run remains authorized to modify the branch.

Keep a clear attribution field: `agent`, `operator`, or `watchdog`. A watchdog can
alert or invoke a separately labelled recovery policy, but cannot turn a timed-out
run into an apparent agent success.

### Permissions and containment

- Separate controller/injector and agent identities.
- The agent receives read access to required Azure telemetry and namespace-scoped
  Kubernetes diagnostic access. Azure resource Reader alone does not establish
  Kubernetes data-plane access; verify the AKS authorization path explicitly.
- Prefer Git-only write permissions for the agent; no cluster-admin, broad
  Contributor, node mutation, secret reads, or unrestricted shell repair tool.
- Scope Argo CD's AppProject to the demo repository, namespace, and necessary
  resource kinds; deny deployment of cluster-scoped resources from the demo repo.
- Restrict the repair service to the allowed changes. Store GitHub App credentials
  server-side in Key Vault and avoid printing credentials or raw sensitive logs.
- Use an authenticated kiosk session, request throttling, and an operator-only
  reset/administration surface. Visitor access does not imply Azure portal access.
- Isolate the workload, apply resource quotas, and keep the dashboard, Argo CD,
  and system components outside its failure scope.
- Enable Azure budget alerts and deployment tags; remove the dedicated demo
  resources after the event.

## Implementation plan

Indicative effort: **5-8 engineering days**, assuming Azure access, Git access,
agent availability, and no new enterprise-network approvals. Re-estimate after
the initial spike.

### Phase 0: feasibility spike and go/no-go (0.5-1 day)

Before polishing the application or dashboard:

1. Confirm Azure SRE Agent availability, current release/preview conditions,
   region, quotas, pricing, and tenant policy in the intended subscription.
2. Create the agent and test its authenticated HTTP trigger.
3. Prove the agent can read live AKS pod, event, Service, and log evidence through
   the intended network and namespace-scoped authorization.
4. Prove it can make a constrained Git correction without interactive approval
   in the configured autonomous mode.
5. Configure Argo CD's Git change notification and measure reconciliation.
6. Run the Service-port fault end-to-end at least ten times; capture phase timings.
7. Confirm supported execution/progress retrieval. Choose the dual-screen portal
   approach if a supported transcript integration is unavailable.

**Gate:** do not promise a three-button autonomous demo until this loop works.
If timing fails, simplify evidence/tool calls and remeasure. If still unsuitable,
present the measured limitations and reduce the demo scope rather than hiding
agent latency behind an automatic reset.

### Phase 1: infrastructure and GitOps foundation (1-1.5 days)

- Bicep for AKS, Container Apps, identities, telemetry, run storage, and secrets.
- Application container, health endpoints, structured logs, and synthetic checkout.
- Argo CD bootstrap, AppProject, base/booth overlay, and image prewarming.
- Dedicated GitHub App, booth branch, webhook/refresh path, and baseline snapshot.
- Document one-command environment creation and explicit teardown.

### Phase 2: one complete visitor journey (1-1.5 days)

- Run lock/state machine and authenticated scenario endpoint.
- Service-port fault injection through Git.
- Probe-triggered SRE Agent investigation and constrained Git repair.
- Live UI showing real evidence, commits, elapsed time, and independent recovery.
- Operator reset and late-agent-write rejection.

### Phase 3: expand and harden (1-2 days)

- Add invalid-startup-configuration and unmatched-node-selector scenarios.
- Tune startup, readiness, reconciliation, and tool-call latency.
- Handle webhook failure, trigger ambiguity, duplicate events, controller restart,
  Git conflicts, quota/admission errors, and timeouts explicitly.
- Add operator preflight, event export, budget guidance, and a clearly labelled
  recorded demonstration for connectivity/service outages.

### Phase 4: rehearsal and handover (1-2 days)

- At least 30 automated runs per scenario; report p50/p95 and success rate.
- At least four hours of mixed-scenario soak testing.
- Test repeated presses, multiple browsers, refresh during a run, controller
  restart, token failure, lost webhook, and operator reset during agent execution.
- Verify no stale agent can alter the next visitor's run.
- Prepare an operator runbook, recovery instructions, and a two-minute talk track.

Do not add a slower scenario to the public menu until it passes the same gate.
It is better to ship two consistently impressive buttons than three unreliable ones.

## Definition of done

- Each advertised button produces a real, visible functional failure.
- The agent records evidence-based diagnosis and initiates a corrective Git change.
- Git history and the agent audit identify the change and its reason.
- Argo CD deploys the corrected revision without a controller-made live patch.
- Recovery requires successful functional checks, not just Kubernetes readiness.
- Every public scenario meets p95 click-to-recovery of at most 180 seconds in
  rehearsal, with at least 29 of 30 runs recovering without human assistance.
- The baseline is restored and next-run readiness is verified within 20 seconds
  after recovery under normal conditions.
- All resets, fallbacks, and failures are attributed visibly and honestly.
- The demo cannot mutate resources outside the intended application scope.
- Infrastructure, configuration, and operating instructions are reproducible.

## Cost and deployment considerations

Prepare a regional estimate after the spike rather than relying on a fixed price.
Include AKS VM/node-pool hours, networking/load balancer or ingress, ACR, always-on
Container Apps replicas, telemetry ingestion/retention, storage, and current Azure
SRE Agent billing. Agent investigations repeated throughout a conference must be
included, not just idle infrastructure costs.

Prefer a small always-ready environment over scale-to-zero savings during booth
hours. Avoid Spot nodes and infrastructure provisioning during a run. Validate
conference internet access and have an operator-controlled recorded fallback
clearly marked as a recording.

## Implemented repository structure

The implementation uses one TypeScript package rather than separate application
packages. See [README](README.md) for local launch and validation instructions.

```text
infra/                       Azure Bicep templates
src/checkout*.ts             Checkout workload and startup validation
src/engine.ts                Run state machine, probes, repair authorization
src/http.ts                  Kiosk/operator API and constrained MCP tools
src/git.ts, src/store.ts     GitHub/local Git and Table/local state adapters
src/runtime.ts, src/local.ts Azure integrations and labelled local simulation
public/                     Responsive booth dashboard
gitops/bootstrap/            Argo CD Application and AppProject
gitops/apps/checkout/base/   Workload base
gitops/apps/checkout/booth/  Dedicated demo overlay and faultable configuration
agent/                       Custom-agent handler instructions
scripts/                     Timing rehearsal and local secret generation
tests/                       Scenario, safety, timing, MCP, and local integration tests
docs/                        Deployment and booth operator runbooks
```

Keep the faultable booth manifests on the dedicated deployment branch. A separate
GitOps repository can be used if the customer prefers a platform/application split.

## Sources and capability checks

Documentation consulted on 27 October 2026. Features, permissions, release status,
and APIs must be verified in the target tenant during Phase 0.

- [Azure SRE Agent overview](https://learn.microsoft.com/azure/sre-agent/overview):
  resource investigation, governed automation, identity, and tool policies.
- [HTTP triggers](https://learn.microsoft.com/azure/sre-agent/http-triggers):
  authenticated event-driven invocation, autonomous/review settings, asynchronous
  acceptance, thread ID, and execution history.
- [Azure observability diagnostics](https://learn.microsoft.com/azure/sre-agent/diagnose-azure-observability):
  telemetry sources and AKS kubectl diagnostics.
- [Execute mitigations](https://learn.microsoft.com/azure/sre-agent/execute-mitigations):
  diagnosis/action/verification loop and permission requirements.
- [GitHub connector](https://learn.microsoft.com/azure/sre-agent/github-connector):
  distinction between Code Access, connector operations, and GitHub MCP tools.
  Read access alone is not proof of manifest-write capability.
- [Incident response plans](https://learn.microsoft.com/azure/sre-agent/incident-response-plans):
  optional alert-driven routing and autonomy; avoid overlapping quickstart plans.
- [Argo CD automatic sync](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/):
  self-healing, polling interval, and rollback limitations.
- [Argo CD webhook configuration](https://argo-cd.readthedocs.io/en/stable/operator-manual/webhook/):
  immediate Git change notification and webhook configuration.
