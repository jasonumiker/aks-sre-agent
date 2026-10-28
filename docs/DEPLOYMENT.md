# Azure deployment

## Prerequisites and explicit manual gates

An authorized operator must choose the Azure subscription/resource group, region,
GitHub repository, Entra AKS administrator group, and Azure SRE Agent resource.
No deployment is run automatically by the application.

Required tools: Azure CLI + Bicep, kubectl, kubelogin, Node.js 22.16+, and Git.
Use Azure Container Registry Tasks to build when a local Docker daemon is absent.
The deployment identity needs resource creation and role-assignment permissions.

Before spending time on the full booth, complete the feasibility spike from the
[proposal](../DEMO-PLAN.md). Confirm SRE Agent availability, billing, HTTP triggers,
Streamable HTTP MCP support, network reachability, and tool autonomy in your tenant.

## 1. Deploy the foundation

### Reusing an existing cluster and registry

Do not run `infra/main.bicep` against an existing cluster: it creates a new
foundation rather than safely adopting arbitrary cluster settings.

The current checkout overlay is pinned to the image published in
`acraks2t8p.azurecr.io/sre-demo/checkout` for the existing `aks-aks-2t8p` cluster in
`rg-aks-2t8p`. Both `sre-demo/checkout:20261027` and `sre-demo/booth:20261027` are
published to that registry.

On 27 October 2026, the initial namespace bootstrap was rejected by AKS
authorization; the temporary custom role and assignment used to investigate it
were removed. After the namespace became available, checkout, quota, and image
prewarming were successfully deployed. The existing Argo CD now manages checkout
from the dedicated `booth` branch of `jasonumiker/aks-sre-agent` and reports
Synced/Healthy. The completed deployment is available at:

- Booth: https://sredemo-controller.orangeriver-a46f9da4.australiaeast.azurecontainerapps.io
- Synthetic checkout: http://4.200.85.187
- SRE Agent: `sre-aks-2t8p` in https://sre.azure.com

The controller uses a fine-grained GitHub token held in Key Vault, managed identity
for Azure access, private endpoints for Key Vault/Table storage, and the
VNet-integrated `sredemo-private-booth` Container Apps environment. Tenant policy
forces public access off for the vault and storage; do not disable that policy.
The existing cluster and Argo CD installation were preserved.

All three scenarios were verified against the real agent, GitHub, Argo CD and AKS,
with agent-attributed Git corrections and sustained functional recovery:

| Scenario | Click-to-verified-recovery |
| --- | --- |
| Service target port | 57.210 seconds |
| Invalid startup configuration | 58.680 seconds |
| Unmatched node selector | 54.573 seconds |

These are individual smoke-test measurements, not p95 certification or a soak
test. The port scenario also passed repeated runs, including a final 60.772-second
run after reapplying the reproducible agent configuration. All three buttons are
enabled, and the final observed state was READY with Argo CD Synced/Healthy.
The controller is pinned
to booth image digest
`sha256:152213a61ba4bec7ac8bf7dcb45d98f4a053a2cc0911a8cc14afbae2da165f08`.
The 28 October 2026 UI update was built from commit `e703919` as
`sre-demo/booth:ui-e703919-20261028` (ACR build `cr1`) and deployed as
revision `sredemo-controller--ui-e703919`. This healthy revision receives all
traffic; the previous revision is inactive. The updated public UI, persisted
availability samples, live checkout latency, and READY state were verified after
an operator baseline reset. Checkout and agent infrastructure were unchanged.
Operator/kiosk login tokens are in protected local files under
`.local/azure-secrets/`, not in this document or public browser URLs.

For reproducibility, `infra/existing-cluster.bicep` provisions identity, private
vault/storage and their role assignments; `infra/private-network.bicep` adds
dedicated subnets, private endpoints/DNS and the Container Apps environment.
Its subnet ranges are specific to this VNet and must be checked before reuse.
`infra/demo-agent.bicep` creates the dedicated Low-access/Review-mode SRE Agent.
`infra/credentials.bicep` accepts secure parameters to provision vault secrets
through ARM without opening a public data endpoint. Never commit a populated
credential parameter file or log its values.

The public checkout also requires the narrow `allow-sre-checkout-http` NSG rule
on `vnet-aks-2t8p-clusterSubnet-nsg-australiaeast`: priority 400, inbound TCP from
Internet to `4.200.85.187`, destination port 80. The actual node subnet is
`clusterSubnet`, not `systemSubnet`. Kubernetes manages the node NIC NSG rule;
the additional subnet NSG otherwise blocks it. Remove this named rule at teardown;
do not replace the shared NSG or open all node ports.

This cluster already has Argo CD and uses **Azure RBAC for Kubernetes**, unlike
the new-cluster template below. Reuse its Argo CD installation. Do not disable
Azure RBAC or replace the cluster's authentication configuration. Its AKS RBAC
Admin role excludes namespace and quota creation; a cluster operator needs
explicitly scoped permission to bootstrap those resources.

Until a hosted GitOps repository, GitHub credentials, and SRE Agent trigger
are configured, a direct checkout deployment is only a staging deployment. It
does not provide Argo CD reconciliation, the booth dashboard, or autonomous repair.
Do not install an Application pointing at placeholder URLs, or enable public fault
controls before the complete repair loop has been verified.

### Creating a new foundation

Use a unique **lowercase alphanumeric** prefix of 3-10 characters (storage/ACR
naming). Create a dedicated resource group. Example with operator-selected values:

```sh
az account set --subscription "$SUBSCRIPTION_ID"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION"
az deployment group create --resource-group "$RESOURCE_GROUP" --name foundation \
  --template-file infra/main.bicep \
  --parameters prefix="$PREFIX" aksAdminGroupIds="[\"$AKS_ADMIN_GROUP_ID\"]"
az deployment group show --resource-group "$RESOURCE_GROUP" --name foundation \
  --query properties.outputs
```

Record the output names/IDs; use them in the following steps. The template creates
AKS, ACR, a warm Container Apps environment, a controller identity, Key Vault,
Table storage, Log Analytics, and an Application Insights resource. Container
console logs are collected into Log Analytics; the application does not currently
emit Application Insights request spans. SRE Agent maintains its own audit trail.

The AKS cluster uses managed Entra authentication and **Kubernetes RBAC**, not
Azure RBAC for Kubernetes. Its public API is the initial connectivity choice so
the Container App can query it. Configure private networking/API restrictions
before reusing this outside an isolated demo.

Set a resource-group Azure budget and notification contacts in Cost Management
before enabling the booth. Costs depend on region and agent usage. Budgets notify;
they are not an automatic spending cap.

## 2. Build both images and prepare GitOps

```sh
az acr build --registry "$REGISTRY_NAME" --target checkout --image checkout:demo .
az acr build --registry "$REGISTRY_NAME" --target booth --image booth:demo .
az acr repository show --name "$REGISTRY_NAME" --image checkout:demo --query digest -o tsv
az acr repository show --name "$REGISTRY_NAME" --image booth:demo --query digest -o tsv
```

In `gitops/apps/checkout/booth/kustomization.yaml`, replace the registry hostname
and zero digest with the **actual checkout digest**. The prewarm DaemonSet uses
the same image substitution. Never deploy the all-zero placeholder.

Replace the repository URL placeholders in both bootstrap project/application
manifests. Create/push a dedicated `booth` branch with these changes. Protect the
main branch; allow the selected GitHub identity below to write the booth branch without an
interactive PR approval during the demo.

The only file the repair service can write is
`gitops/apps/checkout/booth/patch.yaml`. This file must retain exactly the two
expected checkout patch documents. Other infrastructure/image changes are
operator-owned and must be completed before the demo runs.

## 3. Bootstrap Argo CD and AKS authorization

Acquire credentials using the Entra admin group:

```sh
az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$AKS_NAME"
kubelogin convert-kubeconfig -l azurecli
kubectl create namespace argocd
kubectl apply --namespace argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.3.2/manifests/install.yaml
kubectl create namespace booth
kubectl label namespace booth pod-security.kubernetes.io/enforce=restricted
```

Pin and review the Argo CD release before the event; v3.3.2 is an explicit example,
not a claim that it is the latest version. Keep its administration UI private.
For a private repository, configure Argo CD read access separately (a read-only
deploy key or GitHub App); never commit its credential to this repository.

Replace `REPLACE_CONTROLLER_PRINCIPAL_ID` in the RBAC template with the foundation
output **principal ID**, not the client ID. Apply:

```sh
kubectl apply -f gitops/bootstrap/controller-rbac.yaml
kubectl apply -f gitops/bootstrap/project.yaml
kubectl apply -f gitops/bootstrap/application.yaml
kubectl --namespace booth rollout status daemonset/checkout-prewarm --timeout=120s
kubectl --namespace booth rollout status deployment/checkout --timeout=120s
kubectl --namespace booth get service checkout
```

Record the checkout LoadBalancer IP as `http://IP`. It serves synthetic data only;
use TLS/private ingress for environments requiring encrypted internal traffic.
The functional probe uses `/api/checkout`, not a readiness endpoint.

The controller reads namespace-scoped diagnostics and patches **only the named
Argo CD Application** to request a refresh. It does not patch workloads. Refresh
after every commit eliminates dependence on Argo CD's Git polling interval;
a public Git webhook is not needed.

Keep all demo resources in the same default sync wave, with **no health-gated
hooks or later waves**. Argo CD can then complete manifest application even when
the intentionally broken workload is unhealthy. Health-gated sync waves can leave
an operation waiting and block the next corrective commit's deployment.

## 4. GitHub authentication and secrets

### Recommended for this booth: fine-grained personal access token

Open https://github.com/settings/personal-access-tokens/new and create a token:

- Resource owner: `jasonumiker`.
- Repository access: **Only select repositories**, then `aks-sre-agent`.
- Repository permissions: **Contents: Read and write**; Metadata read is automatic.
- Expiration: shortly after the conference. Organization approval may be required.
- No Actions, Workflows, Administration, or organization permissions are needed.

Store the token in a protected file outside the repository. Do not paste it in
chat, a shell command argument, Git remote URL, or a tracked environment file.
On macOS, one option is to copy the token, then run:

```sh
mkdir -p "$HOME/.config/aks-sre-agent"
chmod 700 "$HOME/.config/aks-sre-agent"
(umask 077; pbpaste > "$HOME/.config/aks-sre-agent/github-token")
printf '' | pbcopy
```

Ensure the clipboard contained only the token. Share only the absolute file path
with the deployment operator. Do not print the token to verify it.

After Key Vault is available, upload without displaying the value:

```sh
az keyvault secret set --vault-name "$VAULT_NAME" --name github-token \
  --file "$HOME/.config/aks-sre-agent/github-token" --output none
```

In the booth deployment parameters, set `githubAuthMode` to `token`; omit
`githubAppId` and `githubInstallationId`. The template references only the
`github-token` secret in token mode; no App/private-key secret is required.
Rotate/replace the secret before expiration and roll/restart the Container App
to ensure the process receives the new value. Token failures explicitly stop the
run; there is no fallback to another credential.

For private repositories, Argo CD needs separate read authentication. Prefer a
read-only deploy key or a separate read-only token; do not distribute the repair
write token to Argo CD. Public repositories can be read anonymously.

### Alternative: GitHub App

Create a GitHub App installed on **only the demo repository**:

- Metadata: read.
- Contents: read/write.
- No workflow, administration, or organization permissions needed.

Record App ID and installation ID. Download the private key into a protected
location outside the tracked repository. The controller creates installation
tokens server-side; the SRE Agent never receives the key or a GitHub write token.

```sh
npm ci
npm run secrets
```

This writes four distinct secret files under `.local/azure-secrets`. It refuses to
overwrite existing files. Grant the deploying operator Key Vault Secrets Officer
through your approved identity process, then upload:

```sh
for secret in booth-token operator-token mcp-token session-secret; do
  az keyvault secret set --vault-name "$VAULT_NAME" --name "$secret" \
    --file ".local/azure-secrets/$secret" --output none
done
az keyvault secret set --vault-name "$VAULT_NAME" --name github-private-key \
  --file "$GITHUB_APP_KEY_PATH" --output none
```

The `github-private-key` upload is required only for App mode (`githubAuthMode=app`,
the backward-compatible default). For token mode upload `github-token` instead.
Generate/upload the four booth/session secrets for either mode.

The foundation grants only the controller identity Key Vault Secrets User and
Table Data Contributor. These secrets are injected using Container Apps Key Vault
references, not plaintext Bicep parameters. Allow for RBAC propagation.

## 5. Configure Azure SRE Agent

In the SRE Agent portal:

1. Create a custom agent with the text from `agent/handler.txt`.
2. Create an HTTP trigger targeting that custom agent. Start in **Review** mode.
3. Copy the generated trigger URL. The controller calls it with an SRE Agent
   data-plane token (`https://azuresre.dev/.default`), not an ARM token. The
   documented ARM audience returned HTTP 401 in this tenant.
4. Do not attach an overlapping Azure Monitor quickstart response plan to this
   same demo; the primary path is an explicit probe-driven HTTP trigger.

Grant the controller agent metadata/thread reads and thread invocation on the
selected agent (the write permission is a **data action**, not an ARM action):

```sh
az deployment group create --resource-group "$RESOURCE_GROUP" --name agent-access \
  --template-file infra/agent-access.bicep \
  --parameters agentName="$SRE_AGENT_NAME" controllerPrincipalId="$CONTROLLER_PRINCIPAL_ID"
```

The agent must reside in this resource group for this small template. For an
existing agent in another group, deploy this template in that group instead.
Allow time for role propagation. The final deployment was verified using only
this custom role; a temporary SRE Agent Standard User grant was removed.

## 6. Deploy the booth controller

Obtain the AKS API CA from the selected kubeconfig without exposing credentials:

```sh
kubectl config view --raw --minify \
  -o jsonpath='{.clusters[0].cluster.certificate-authority-data}'
```

Create a local, gitignored parameter file for `infra/booth.bicep`. Required values:

| Parameter | Value |
| --- | --- |
| `name` | Container App name, e.g. `rescue-booth` |
| `environmentName` | Foundation environment output |
| `identityName` | Foundation identity name, e.g. `PREFIX-controller` |
| `registryServer` | Foundation registry server output |
| `boothImage` | `REGISTRY.azurecr.io/booth@sha256:ACTUAL_DIGEST` |
| `vaultUri`, `tableEndpoint`, `aksServer`, `aksResourceId` | Foundation outputs |
| `checkoutUrl` | Reachable synthetic checkout URL |
| `aksCa` | Base64 API certificate authority from the previous command |
| `githubOwner`, `githubRepo` | `jasonumiker`, `aks-sre-agent` |
| `githubAuthMode` | `token` for a fine-grained PAT; `app` (default) for GitHub App |
| `githubAppId`, `githubInstallationId` | Required only for App mode; omit for token mode |
| `sreTriggerUrl` | Generated SRE Agent HTTP trigger URL |
| `publicOrigin` | HTTPS booth origin; initially omit, then set the returned URL |

Use the standard ARM parameters JSON format and place it in `.local/booth.parameters.json`.
No secrets belong in that file. Then:

```sh
az deployment group create --resource-group "$RESOURCE_GROUP" --name booth \
  --template-file infra/booth.bicep --parameters @.local/booth.parameters.json
```

The first deployment returns an HTTPS URL; set `publicOrigin` to precisely that
origin and redeploy. The initial `unconfigured.invalid` origin intentionally
prevents login/mutations until configured. Do not change only the browser URL:
CSRF validation requires the configured public origin.

Add a **Streamable HTTP MCP connector** to SRE Agent:

- URL: `https://YOUR-BOOTH-HOST/mcp`.
- Custom header: `Authorization: Bearer MCP_TOKEN`, using the actual server secret.
- Tools: `inspect_checkout`, `repair_checkout`.
- Assign only those tools to the custom agent.

To reproduce the connector/custom-agent/trigger configuration using Azure CLI
authentication, run the idempotent setup script from the repository root:

```sh
AGENT_RESOURCE_ID="/subscriptions/.../resourceGroups/.../providers/Microsoft.App/agents/..." \
AGENT_ENDPOINT="https://YOUR-AGENT.azuresre.ai" \
BOOTH_URL="https://YOUR-BOOTH-HOST" \
MCP_TOKEN_FILE=".local/azure-secrets/mcp-token" \
AGENT_MODE=Review npx tsx scripts/configure-agent.ts
```

It reads the MCP credential from the protected file without printing it, selects
the two prefixed MCP tool IDs, clears common/shell tools, and preserves an existing
trigger ID. After review, rerun with `AGENT_MODE=Autonomous`. The HTTP payload is
automatically attached to the trigger prompt; no `{{body}}` substitution is needed.
Review mode alone is not a write-approval boundary for MCP tools: the live tenant
executed the broker's repair tool in Review mode. Always review tool policies as
well; the broker allowlist and per-run authorization remain the enforcement layer.

The inspection tool brokers live Kubernetes reads through the controller's narrow
RBAC identity, so the agent does not need cluster-admin or a separate Kubernetes
write identity. Code Access is optional: relevant Git content/diff is already
returned by inspection. Never attach a generic shell or GitHub write connector.

Test in Review mode, inspect the proposed field/value and Git diff, then explicitly
switch to Autonomous and ensure tool policies allow these two tools without prompts.
The application still independently enforces the repair allowlist.

## 7. Preflight and acceptance

Log in with the operator secret, restore/verify baseline, run the Service-port
scenario, and watch the actual SRE Agent thread in a second browser window.
Repeat the spike at least ten times before adding the other buttons to a public
presentation. Use the [runbook](OPERATIONS.md) for the automated timing rehearsal.

Azure mode exposes only the Service-port button by default and rejects disabled
scenarios server-side. After private rehearsal, set the `enabledScenarios` Bicep
parameter to `port,configuration,scheduling` and redeploy to enable all three.
For local development, `ENABLED_SCENARIOS` defaults to all three.

Deployment is not certified until the target tenant demonstrates the complete
loop. Bicep compilation and local tests alone cannot verify Azure permissions,
MCP compatibility, AKS ingress, Argo CD behavior, or agent turnaround.

### Dependency advisories

Run `npm audit --omit=dev` before public deployment. The initial dependency registry
reports upstream advisories involving Express/body-parser compressed requests,
Azure Identity/MSAL, depending on selected versions. Do not blindly run
`npm audit fix --force`: it proposes incompatible major downgrades.

Both HTTP applications explicitly reject compressed request bodies before JSON
parsing (`inflate: false`) and tests cover rejection. Azure credentials
use `ManagedIdentityCredential` only server-side, not interactive authorization-code
flows. These restrictions are mitigations, not a clean audit or a vendor patch.
Upgrade/retest patched upstream releases and satisfy the customer's dependency
policy before exposing this publicly.
