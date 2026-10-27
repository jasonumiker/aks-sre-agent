targetScope = 'resourceGroup'
param vaultName string
@secure()
param boothToken string
@secure()
param operatorToken string
@secure()
param mcpToken string
@secure()
param sessionSecret string
@secure()
param githubToken string
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: vaultName }
var values = [
  { name: 'booth-token', value: boothToken }
  { name: 'operator-token', value: operatorToken }
  { name: 'mcp-token', value: mcpToken }
  { name: 'session-secret', value: sessionSecret }
  { name: 'github-token', value: githubToken }
]
resource secrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [for secret in values: {
  parent: vault
  name: secret.name
  properties: { value: secret.value }
}]
