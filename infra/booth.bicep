targetScope = 'resourceGroup'

param location string = resourceGroup().location
param name string
param environmentName string
param identityName string
param registryServer string
@description('Fully qualified image with @sha256 digest.')
param boothImage string
param vaultUri string
param tableEndpoint string
param checkoutUrl string
param aksServer string
param aksCa string
param aksResourceId string
param githubOwner string
param githubRepo string
param githubAppId string
param githubInstallationId string
param sreTriggerUrl string
@description('HTTPS origin. Leave empty on first deploy, then redeploy with the returned app URL.')
param publicOrigin string = 'https://unconfigured.invalid'
param enabledScenarios string = 'port'

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = { name: environmentName }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: identityName }
var secretNames = ['booth-token', 'operator-token', 'mcp-token', 'session-secret', 'github-private-key']
resource booth 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  tags: { project: 'aks-sre-agent-booth', environment: 'demo' }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 3000, transport: 'http', allowInsecure: false }
      registries: [{ server: registryServer, identity: identity.id }]
      secrets: [for secret in secretNames: {
        name: secret
        keyVaultUrl: '${vaultUri}secrets/${secret}'
        identity: identity.id
      }]
    }
    template: {
      scale: { minReplicas: 1, maxReplicas: 1 }
      containers: [{
        name: 'booth'
        image: boothImage
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [
          { name: 'MODE', value: 'azure' }
          { name: 'PORT', value: '3000' }
          { name: 'PUBLIC_ORIGIN', value: publicOrigin }
          { name: 'ENABLED_SCENARIOS', value: enabledScenarios }
          { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
          { name: 'BOOTH_TOKEN', secretRef: 'booth-token' }
          { name: 'OPERATOR_TOKEN', secretRef: 'operator-token' }
          { name: 'MCP_TOKEN', secretRef: 'mcp-token' }
          { name: 'SESSION_SECRET', secretRef: 'session-secret' }
          { name: 'GITHUB_PRIVATE_KEY', secretRef: 'github-private-key' }
          { name: 'TABLE_ENDPOINT', value: tableEndpoint }
          { name: 'CHECKOUT_URL', value: checkoutUrl }
          { name: 'AKS_SERVER', value: aksServer }
          { name: 'AKS_CA', value: aksCa }
          { name: 'AKS_RESOURCE_ID', value: aksResourceId }
          { name: 'GITHUB_OWNER', value: githubOwner }
          { name: 'GITHUB_REPO', value: githubRepo }
          { name: 'GITHUB_APP_ID', value: githubAppId }
          { name: 'GITHUB_INSTALLATION_ID', value: githubInstallationId }
          { name: 'SRE_TRIGGER_URL', value: sreTriggerUrl }
        ]
        probes: [
          { type: 'Liveness', httpGet: { path: '/health/live', port: 3000 }, periodSeconds: 10 }
          { type: 'Startup', httpGet: { path: '/health/live', port: 3000 }, periodSeconds: 2, failureThreshold: 30 }
        ]
      }]
    }
  }
}
output url string = 'https://${booth.properties.configuration.ingress.fqdn}'
