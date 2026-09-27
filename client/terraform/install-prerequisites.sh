#!/usr/bin/env bash
# Installs what's needed to run this Terraform config: the Azure CLI and
# Terraform itself. Idempotent — safe to re-run, skips anything already
# installed. apt-based Linux only (Debian/Ubuntu); see the README for other
# platforms.
set -euo pipefail

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script only supports apt-based Linux (Debian/Ubuntu)." >&2
  echo "Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli" >&2
  echo "Terraform: https://developer.hashicorp.com/terraform/install" >&2
  exit 1
fi

install_azure_cli() {
  if command -v az >/dev/null 2>&1; then
    echo "Azure CLI already installed ($(az version --query '\"azure-cli\"' -o tsv))."
    return
  fi
  echo "Installing Azure CLI..."
  curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
}

install_terraform() {
  if command -v terraform >/dev/null 2>&1; then
    echo "Terraform already installed ($(terraform version -json | grep -o '"terraform_version":"[^"]*"' | cut -d'"' -f4))."
    return
  fi
  echo "Installing Terraform..."
  sudo apt-get update
  sudo apt-get install -y curl gnupg lsb-release
  curl -fsSL https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
    | sudo tee /etc/apt/sources.list.d/hashicorp.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y terraform
}

install_azure_cli
install_terraform

echo
missing=()
for v in ARM_CLIENT_ID ARM_CLIENT_SECRET ARM_SUBSCRIPTION_ID ARM_TENANT_ID; do
  [[ -n "${!v:-}" ]] || missing+=("$v")
done
if (( ${#missing[@]} == 0 )); then
  echo "Service principal credentials found (ARM_CLIENT_ID=$ARM_CLIENT_ID)."
else
  echo "Not set yet: ${missing[*]} — export them before running terraform."
fi

echo
echo "Prerequisites installed. Next steps:"
echo "  export ARM_CLIENT_ID=... ARM_CLIENT_SECRET=... ARM_SUBSCRIPTION_ID=... ARM_TENANT_ID=..."
echo "  cd client/terraform"
echo "  cp terraform.tfvars.example terraform.tfvars       # then edit it"
echo "  terraform init"
echo "  terraform apply"
