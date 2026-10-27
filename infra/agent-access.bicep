targetScope = 'resourceGroup'

param agentName string
param controllerPrincipalId string
resource agent 'Microsoft.App/agents@2026-01-01' existing = { name: agentName }
resource triggerRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, resourceGroup().id, 'booth-trigger')
  properties: {
    roleName: 'Booth trigger ${resourceGroup().name}'
    description: 'Invoke SRE Agent threads for the conference booth.'
    type: 'CustomRole'
    permissions: [{
      actions: ['Microsoft.App/agents/read']
      notActions: []
      dataActions: [
        'Microsoft.App/agents/threads/read'
        'Microsoft.App/agents/threads/write'
        'Microsoft.App/agents/extendedAgents/read'
      ]
      notDataActions: []
    }]
    assignableScopes: [resourceGroup().id]
  }
}
resource triggerAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: agent
  name: guid(agent.id, controllerPrincipalId, 'trigger')
  properties: {
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: triggerRole.id
  }
}
