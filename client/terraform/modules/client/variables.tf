variable "name" {
  description = "This client's short name, e.g. \"lab-1\"."
  type        = string
}

variable "name_prefix" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "image" {
  description = "Full image reference (registry/repo:tag) to run."
  type        = string
}

variable "registry_login_server" {
  type = string
}

variable "registry_username" {
  type = string
}

variable "registry_password" {
  type      = string
  sensitive = true
}

variable "cdp_port" {
  type = number
}

variable "novnc_port" {
  type = number
}

variable "upstream_proxy" {
  type      = string
  default   = ""
  sensitive = true
}

variable "container_cpu" {
  type    = number
  default = 2
}

variable "container_memory_gb" {
  type    = number
  default = 4
}
