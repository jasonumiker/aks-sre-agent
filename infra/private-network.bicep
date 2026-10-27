targetScope = 'resourceGroup'
param location string = resourceGroup().location
param vnetName string = 'vnet-aks-2t8p'
param vaultName string = 'sredemo-itexoj2gbn674'
param storageName string = 'sredemoitexoj2gbn674'
param workspaceName string = 'log-aks-2t8p'

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' existing = { name: vnetName }
resource appsSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' = {
  parent: vnet
  name: 'sreAppsSubnet'
  properties: {
    addressPrefix: '172.19.4.0/23'
    delegations: [{
      name: 'container-apps'
      properties: { serviceName: 'Microsoft.App/environments' }
    }]
  }
}
resource endpointsSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' = {
  parent: vnet
  name: 'srePrivateEndpoints'
  properties: {
    addressPrefix: '172.19.6.0/27'
    privateEndpointNetworkPolicies: 'Disabled'
  }
  dependsOn: [appsSubnet]
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: vaultName }
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageName }
var services = [
  { name: 'vault', zone: 'privatelink.vaultcore.azure.net', resourceId: vault.id, groupId: 'vault' }
  { name: 'table', zone: 'privatelink.table.${az.environment().suffixes.storage}', resourceId: storage.id, groupId: 'table' }
]
resource zones 'Microsoft.Network/privateDnsZones@2020-06-01' = [for service in services: {
  name: service.zone
  location: 'global'
}]
resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = [for (service, i) in services: {
  parent: zones[i]
  name: 'sre-demo-vnet'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}]
resource endpoints 'Microsoft.Network/privateEndpoints@2023-11-01' = [for service in services: {
  name: 'sre-${service.name}-endpoint'
  location: location
  properties: {
    subnet: { id: endpointsSubnet.id }
    privateLinkServiceConnections: [{
      name: service.name
      properties: { privateLinkServiceId: service.resourceId, groupIds: [service.groupId] }
    }]
  }
}]
resource groups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = [for (service, i) in services: {
  parent: endpoints[i]
  name: 'default'
  properties: { privateDnsZoneConfigs: [{ name: service.name, properties: { privateDnsZoneId: zones[i].id } }] }
}]
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = { name: workspaceName }
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'sredemo-private-booth'
  location: location
  properties: {
    vnetConfiguration: { infrastructureSubnetId: appsSubnet.id, internal: false }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}
output environmentName string = environment.name
