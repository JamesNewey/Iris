output "fqdn" {
  value = azurerm_container_group.this.fqdn
}

output "cdp_endpoint" {
  description = "Paste into Iris's 'Add connection' endpoint field."
  value       = "http://${azurerm_container_group.this.fqdn}:${var.cdp_port}"
}

output "novnc_url" {
  description = "What Iris's NOVNC_PORT_OFFSET derivation should produce on its own — for cross-checking, not for pasting anywhere."
  value       = "http://${azurerm_container_group.this.fqdn}:${var.novnc_port}/vnc.html?autoconnect=true"
}
