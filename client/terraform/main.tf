# Tag the image with a hash of everything that goes into it, so any change to
# client/docker/ yields a new image reference — which both re-runs the build
# below and makes ACI replace the container group and pull the new image
# (a fixed tag like `latest` would push the new image but never deploy it).
locals {
  image_source_hash = substr(sha256(join("", [
    for f in sort(fileset("${path.module}/../docker", "**")) : filesha256("${path.module}/../docker/${f}")
  ])), 0, 12)
  image = "${azurerm_container_registry.this.login_server}/iris-client:${var.image_tag}-${local.image_source_hash}"
}

resource "azurerm_resource_group" "this" {
  name     = var.resource_group_name
  location = var.location
}

# ACR names must be alphanumeric only (no hyphens), 5-50 chars, globally unique.
resource "azurerm_container_registry" "this" {
  name                = replace("${var.name_prefix}acr", "-", "")
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku                 = "Basic"
  admin_enabled       = true
}

# Builds the client/docker/ image with the local Docker daemon and pushes it
# to the registry. (Not `az acr build`: ACR Tasks is disabled on many
# subscriptions, including free-trial ones, and fails with
# TasksOperationsNotAllowed.) Logs in with the registry's admin credentials,
# passed via the environment so they never appear in the logged command, into a
# throwaway DOCKER_CONFIG so your own Docker logins are left alone. Re-runs
# whenever the image reference (and so any file in client/docker/) changes.
resource "null_resource" "build_and_push_client_image" {
  triggers = {
    image = local.image
  }

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    environment = {
      REGISTRY = azurerm_container_registry.this.login_server
      ACR_USER = azurerm_container_registry.this.admin_username
      ACR_PASS = azurerm_container_registry.this.admin_password
      IMAGE    = local.image
    }
    command = <<-EOT
      set -euo pipefail
      export DOCKER_CONFIG="$(mktemp -d)"
      trap 'rm -rf "$DOCKER_CONFIG"' EXIT
      printf '%s' "$ACR_PASS" | docker login "$REGISTRY" --username "$ACR_USER" --password-stdin
      docker build --platform linux/amd64 --tag "$IMAGE" ${path.module}/../docker
      docker push "$IMAGE"
    EOT
  }
}

module "client" {
  for_each = toset(var.client_names)
  source   = "./modules/client"

  name                = each.value
  name_prefix         = var.name_prefix
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location

  image                 = local.image
  registry_login_server = azurerm_container_registry.this.login_server
  registry_username     = azurerm_container_registry.this.admin_username
  registry_password     = azurerm_container_registry.this.admin_password

  cdp_port   = var.cdp_port
  novnc_port = var.cdp_port + var.novnc_port_offset

  container_cpu       = var.container_cpu
  container_memory_gb = var.container_memory_gb

  depends_on = [null_resource.build_and_push_client_image]
}
