# Iris client deployment (Azure)

Terraform that provisions Iris clients on Azure: one [Azure Container
Registry](https://learn.microsoft.com/azure/container-registry/) holding the
built [`client/docker/`](../docker) image, and one **Azure Container Instance (ACI)
container group per client**, each with its own public IP/FQDN.

## Why one container group per client

Locally, `docker run -p` lets many containers share one host by remapping
ports (see [`client/README.md`](../README.md)'s `+100` noVNC
convention). Azure Container Instances can't remap ports — whatever port a
container listens on is the port exposed on its public IP. So instead of
sharing a host, every client here gets its **own** public IP via its own
container group, and every client listens on the same pair of ports
internally (`9225` CDP / `9325` noVNC by default — see `cdp_port` and
`novnc_port_offset` in [`variables.tf`](variables.tf)). No collision is
possible since each is on a different IP, and Iris's existing
`NOVNC_PORT_OFFSET`-based URL derivation (`host/src/main.ts`) keeps working
unchanged.

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- Azure CLI (`az`) — the image build (`az acr build`, an ACR Tasks remote
  build, no local Docker daemon needed) shells out to it directly from
  Terraform via `local-exec`.
- A service principal with permission to create resource groups, an Azure
  Container Registry, and container groups in the target subscription
  (e.g. `Contributor` on it), exported as:

  ```bash
  export ARM_CLIENT_ID=...        # the service principal's appId
  export ARM_CLIENT_SECRET=...    # its client secret
  export ARM_SUBSCRIPTION_ID=...
  export ARM_TENANT_ID=...
  ```

  The `azurerm` provider reads these on its own, and the image build signs
  the CLI in as the same principal (into a throwaway `AZURE_CONFIG_DIR`, so
  your own `az login`, if any, is left alone). Don't have one yet?
  `az ad sp create-for-rbac --role Contributor --scopes /subscriptions/<id>`
  prints all four values (`appId`, `password`, `tenant`).

Two ways to get there:

- **VS Code devcontainer** (any host OS): export the four `ARM_*` variables
  in the shell VS Code is launched from, then open the repo, run "Dev
  Containers: Reopen in Container", and pick **Iris — Terraform (Azure
  deploy)** (`.devcontainer/terraform/devcontainer.json` at the repo root —
  a separate config from any future one for `host/`, since that needs a real
  GUI and this doesn't). The container forwards the `ARM_*` variables from
  your host via `remoteEnv`; Azure CLI and Terraform are preinstalled, and
  nothing touches your host machine. Changed a variable? Rebuild the
  container to pick it up.
- **Directly on an apt-based host**: `./install-prerequisites.sh` installs
  the Azure CLI and Terraform (skipping anything already present) and tells
  you whether the `ARM_*` variables are set.

On other platforms/setups, install both manually via the links above, then
export the `ARM_*` variables.

## Usage

```bash
cd client/terraform
cp terraform.tfvars.example terraform.tfvars   # edit client_names, name_prefix, etc.
terraform init
terraform apply
```

`name_prefix` feeds every client's public DNS label
(`<name_prefix>-<client-name>.<region>.azurecontainer.io`), which is globally
unique across all of Azure in that region — pick something more distinctive
than the `iris` default if you don't want a name clash with someone else's
deployment.

After it applies:

```bash
terraform output -json clients
```

gives you, per client, the `cdp_endpoint` for Iris's "Add connection" dialog
(plus its current `ip_address` — which changes whenever the container group
is replaced, so connect by the endpoint's hostname instead).

To add them all at once, save the output to a file and use **Import from
file…** in Iris's "Add connection" dialog:

```bash
terraform output -json clients > ~/iris-clients.json
```

Each client becomes a connection named after it; endpoints Iris already has
are skipped, so re-importing after adding clients is safe.

(`novnc_url` is also printed, but only so you can sanity-check it against
what Iris derives on its own — you never paste it anywhere.)

## Security notes

- **Transport is unencrypted (`http://`/`ws://`).** Iris will show its
  "insecure" badge on these connections — that's accurate, not a bug. Adding
  TLS termination (e.g. an Azure Front Door or Application Gateway in front
  of each container group) is a reasonable follow-up but out of scope here.
- **There is currently no authentication.** Each client's CDP endpoint is
  full remote-debugging control of a real browser, and noVNC gives full
  control of its screen — both reachable by anyone on the internet who finds
  the address. The earlier per-client token was removed pending a security
  review (options under consideration: TLS + token, or a private network
  such as Tailscale). Keep deployments short-lived, and `terraform destroy`
  when you're done.
- **Registry credentials**: ACR admin credentials (not a per-user identity)
  are used to let ACI pull images, since it's the most broadly-compatible
  Terraform pattern. They're marked `sensitive` and only ever touch
  Terraform state — switching to a managed-identity + `AcrPull` role
  assignment instead is a reasonable hardening step if your threat model
  cares about that (Terraform state access implies registry access either
  way).

## Layout

```
terraform/
  versions.tf              # provider requirements
  variables.tf              # root inputs (region, client_names, ports, sizing)
  main.tf                    # resource group, ACR, image build, one module.client per client
  outputs.tf                 # per-client connection info for Iris
  modules/client/             # one Azure Container Instance container group
```

## Tearing down

```bash
terraform destroy
```

Removes the resource group and everything in it (container groups + the
registry, including the image).
