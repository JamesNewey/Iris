variable "location" {
  description = "Azure region to deploy into."
  type        = string
  default     = "uksouth"
}

variable "resource_group_name" {
  description = "Name of the resource group Iris's Azure resources live in."
  type        = string
  default     = "iris"
}

variable "name_prefix" {
  description = "Short prefix used to name every resource (must be globally-unique-safe once combined with a client name, since it feeds each client's public DNS label)."
  type        = string
  default     = "iris"
}

variable "image_tag" {
  description = "Prefix for the client image tag; a hash of client/docker/ is appended (e.g. latest-3f9a1c2b7d4e)."
  type        = string
  default     = "latest"
}

variable "client_names" {
  description = "One entry per client to provision, e.g. [\"lab-1\", \"lab-2\"]. Each becomes its own container group with its own public IP."
  type        = list(string)
}

variable "cdp_port" {
  description = "Port the CDP proxy listens on inside every client container. Every client can share the same value since each gets its own public IP — no collision. Must stay in sync with `novnc_port_offset` below and NOVNC_PORT_OFFSET in host/src/main.ts."
  type        = number
  default     = 9225
}

variable "novnc_port_offset" {
  description = "How far above cdp_port the noVNC port is exposed. MUST match NOVNC_PORT_OFFSET in host/src/main.ts — Iris derives each connection's noVNC admin URL by adding this to the CDP endpoint's port, it doesn't ask for a separate noVNC URL."
  type        = number
  default     = 100
}

variable "upstream_proxy" {
  description = "Authenticated HTTP proxy the clients' Chrome browses through; null means browse directly. `port` is the first client's port, and each later entry in client_names gets the next port up (port+1, port+2, ...), so reordering or removing names shifts the others' ports."
  type = object({
    host     = string
    port     = number
    username = string
    password = string
  })
  default   = null
  sensitive = true
}

variable "container_cpu" {
  description = "vCPU cores per client container (Chromium + Xvfb + VNC needs headroom)."
  type        = number
  default     = 2
}

variable "container_memory_gb" {
  description = "Memory (GB) per client container."
  type        = number
  default     = 4
}
