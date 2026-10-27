# AKS Rescue Lab

A conference booth experience: visitors break a checkout workload; Azure SRE Agent
investigates and proposes a constrained Git correction; Argo CD deploys it; real
checkout requests independently prove recovery.

## Run locally

Requires Node.js 22.16+ and Git. No Azure credentials or Docker required.

```sh
npm ci
npm run dev
```

Open <http://localhost:3000>. On first start, four local credentials are generated
in the gitignored `.local/access.json`. Read `OPERATOR_TOKEN` locally, paste it into
the login form, and choose **Restore & verify baseline**. After at least ten
seconds of healthy probes, the three fault buttons unlock.

Local mode uses an actual checkout subprocess and a private bare Git repository.
It **simulates Service routing and Kubernetes scheduling**, not AKS or Argo CD.
**No local AI agent runs.** After a fault, use **Inspect current run**, select the
evidence-based correction in the operator console, and submit it. The UI
attributes that repair to the operator, never to Azure SRE Agent.

Use `BOOTH_TOKEN` for a visitor-only session without reset/repair controls.
Run only one local controller per `.local` directory. Stop it with Ctrl+C;
persistent history and Git commits survive restart. Restart always requires a
baseline reset before a new visitor can start.

## Validate

```sh
npm run typecheck
npm test
npm run build
kubectl kustomize gitops/apps/checkout/booth
az bicep build --file infra/main.bicep
az bicep build --file infra/booth.bicep
az bicep build --file infra/agent-access.bicep
```

The tests include all three failures/repairs, functional response validation,
ten-second recovery verification, concurrency, stale Git writes, reset/revocation,
ambiguous trigger outcomes, authenticated MCP, HTTP roles/CSRF, persistent state,
and real local subprocess/Git integration.

To run compiled local code: `npm run build && npm start`.

## Deploy and operate

- [Azure deployment](docs/DEPLOYMENT.md): infrastructure, images, GitHub App,
  Kubernetes bootstrap, SRE Agent connector/trigger, and application configuration.
- [Booth operator runbook](docs/OPERATIONS.md): preflight, resets, timing rehearsal,
  failure handling, and teardown.
- [Design and acceptance targets](DEMO-PLAN.md): proposal, scope, and rationale.
- [Agent handler](agent/handler.txt): instructions to paste into the custom agent.

The same container build produces `checkout` and `booth` targets:

```sh
docker build --target checkout -t checkout:demo .
docker build --target booth -t booth:demo .
```

The booth server also exposes the authenticated, stateless Streamable HTTP MCP
endpoint at `/mcp`. `inspect_checkout` reads evidence; `repair_checkout` can only
change the three approved manifest fields/values in one configured Git path.
Azure mode has no browser-based repair endpoint.

## Important limits

- Azure mode needs explicit tenant/subscription/agent configuration. A local demo
  is not proof of AKS permissions, managed-service latency, or autonomous recovery.
- Aim for 60-120 seconds; the rehearsal gate is p95 <=180 seconds. Do not promise
  that timing until it has been measured against the actual Azure SRE Agent.
- One run at a time; no automatic recovery on ambiguous trigger/write outcomes.
- Azure mode starts with only the port scenario enabled; enable others after rehearsal.
- The dashboard is not an agent transcript. Use the SRE Agent portal alongside it.
- The deployment starts with a public AKS API and public synthetic-only checkout
  LoadBalancer for simplicity. Harden networking for customer environments.
- See dependency advisory handling in the deployment guide before public use.
