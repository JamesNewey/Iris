resource "azurerm_container_group" "this" {
  name                = "${var.name_prefix}-${var.name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  os_type             = "Linux"
  ip_address_type     = "Public"
  dns_name_label      = "${var.name_prefix}-${var.name}"
  restart_policy      = "Always"

  image_registry_credential {
    server   = var.registry_login_server
    username = var.registry_username
    password = var.registry_password
  }

  container {
    name   = "client"
    image  = var.image
    cpu    = var.container_cpu
    memory = var.container_memory_gb

    ports {
      port     = var.cdp_port
      protocol = "TCP"
    }
    ports {
      port     = var.novnc_port
      protocol = "TCP"
    }

    environment_variables = {
      PROXY_PORT = tostring(var.cdp_port)
      NOVNC_PORT = tostring(var.novnc_port)
    }
  }
}
