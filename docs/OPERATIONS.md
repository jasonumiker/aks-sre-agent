# Booth operator runbook

## Before opening

1. Confirm Azure budget notifications and no real customer data/workloads.
2. Confirm checkout image prewarming on every eligible node and spare node capacity.
3. Check Container App health/logs, Table access, GitHub App installation, Argo CD,
   SRE trigger authentication, and MCP connector health.
4. Log in using the operator token; select **Restore & verify baseline**.
5. Wait for READY: expected Git revision, Argo CD Synced/Healthy, and ten successful
   functional requests spanning at least ten seconds.
6. Exercise each advertised button and confirm an **agent-attributed** correction
   and sustained recovery. Open the agent's real investigation in a second window.
7. Switch the visitor screen to a kiosk-token session. Keep operator credentials
   and Azure/GitHub administration surfaces away from visitors.

Azure mode initially enables only the port scenario. Use the `enabledScenarios`
deployment parameter to enable scenarios privately for rehearsal, then restrict
the public menu to those that pass. Disabled scenarios are also rejected by the API.
Do not describe local/manual rehearsals as autonomous Azure recovery.

## During a run

- One active run is allowed. Other button presses return an explicit conflict.
- Timeline events are controller observations and the repair's submitted evidence,
  not the agent's hidden reasoning or a streamed transcript.
- Expand the Git diff to show what changed and which actor initiated it.
- The timer includes deployment and sustained-verification time.
- Agent recovery retains the verified corrected baseline and automatically unlocks
  the next visitor. No operator reset is needed after a successful repair.

## If something fails

The initial deadline is 180 seconds. A timeout, Git conflict, invalid repair,
unavailable evidence, or ambiguous trigger outcome requires operator intervention.
There is **no silent deterministic rescue**.

1. Export current runs before changing anything.
2. Inspect controller logs and the real SRE Agent thread/execution history.
3. For an invocation timeout, do not resend the trigger blindly: the original may
   have been accepted. The controller deliberately attempts it only once.
4. Select **Restore & verify baseline**. This immediately revokes the old run.
   A new baseline Git commit fences delayed writes even if the manifest was
   already healthy.
5. If reset conflicts with an in-flight Git write, inspect the new head and request
   reset again. The UI must report the conflict, not pretend reset succeeded.
6. Only resume after READY. An old agent conversation may continue but cannot
   write using its revoked run ID/head.

A controller restart preserves Git/history but deliberately requires reset rather
than trying to infer whether an external operation completed.

## Timing rehearsal

Use a real Azure deployment after verifying the baseline. This script refuses to
certify local mode and never performs a hidden scripted repair/reset.

```sh
BOOTH_URL=https://YOUR-BOOTH-HOST \
OPERATOR_TOKEN="$(cat .local/azure-secrets/operator-token)" \
RUNS_PER_SCENARIO=30 REPORT_PATH=.local/rehearsal-report.json npm run rehearse
```

It performs 30 sequential runs of each scenario, stops on intervention, and writes
the measured runs plus p50/p95. Export UI history periodically; the controller
retains the latest 100 completed runs, not an unlimited archive.

Public acceptance target: p95 click-to-recovery <=180 seconds and at least 29/30
autonomous successes per scenario. The unattended script intentionally uses a
stricter all-success criterion; failures require review and a new rehearsal.
Complete a four-hour mixed-scenario soak and multi-browser/reset/restart checks
before the event. Test stale writes, not just the happy path.

## Connectivity fallback

Keep a clearly labelled recording. If internet, Azure, GitHub, or the agent service
is unavailable, present the recording as a recording. Never replace the live
agent with an automatic reset while retaining an "agent fixed it" message.

## Teardown

Export the event history, timing report and any useful agent audit first.
Confirm the exact dedicated resource group in the selected subscription and remove
only that group using your organization's approved deletion process. This deletes
the cluster, registry, controller and run storage. Key Vault soft-delete retention
and separately provisioned SRE Agent resources may need additional lifecycle
handling. Revoke the demo GitHub App installation and rotate/revoke booth tokens.
