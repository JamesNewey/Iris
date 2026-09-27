output "registry_login_server" {
  description = "ACR login server the client image was pushed to."
  value       = azurerm_container_registry.this.login_server
}

output "clients" {
  description = "Per-client connection info for Iris's 'Add connection' dialog: cdp_endpoint goes in the endpoint field. novnc_url is what NOVNC_PORT_OFFSET should derive on its own — listed here only to cross-check."
  value = {
    for name, mod in module.client : name => {
      cdp_endpoint = mod.cdp_endpoint
      novnc_url    = mod.novnc_url
    }
  }
}
