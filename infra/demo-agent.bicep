targetScope = 'resourceGroup'
param location string = resourceGroup().location
param agentName string = 'sre-aks-2t8p'
param workspaceName string = 'log-aks-2t8p'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = { name: workspaceName }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${agentName}-identity'
  location: location
}
resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${agentName}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}
resource agent 'Microsoft.App/agents@2025-05-01-preview' = {
  name: agentName
  location: location
  identity: {
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    knowledgeGraphConfiguration: {
      identity: identity.id
      managedResources: [resourceGroup().id]
    }
    actionConfiguration: {
      accessLevel: 'Low'
      identity: identity.id
      mode: 'Review'
    }
    logConfiguration: {
      applicationInsightsConfiguration: {
        appId: insights.properties.AppId
        connectionString: insights.properties.ConnectionString
        applicationInsightsResourceId: insights.id
      }
    }
    upgradeChannel: 'Preview'
    monthlyAgentUnitLimit: 10000
    defaultModel: { provider: 'MicrosoftFoundry', name: 'Automatic' }
    experimentalSettings: {
      EnableWorkspaceTools: true
      EnableHttpTriggers: true
      EnableV2AgentLoop: true
    }
  }
}
resource admin 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: agent
  name: guid(agent.id, deployer().objectId, 'administrator')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'e79298df-d852-4c6d-84f9-5d13249d1e55')
    principalId: deployer().objectId
    principalType: 'User'
  }
}
output resourceId string = agent.id
output endpoint string = agent.properties.agentEndpoint
