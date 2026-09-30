#!/usr/bin/env bash
# Tests the upstream proxy configured by `upstream_proxy` in
# client/terraform/terraform.tfvars, asking Terraform for the values so they're
# exactly what a deploy would use.
#
# Usage: test-proxy.sh [COUNT] [URL]
#   COUNT  how many consecutive ports to test, starting at upstream_proxy.port
#          (default: one per entry in client_names)
#   URL    what to fetch through each port (default https://api.ipify.org,
#          which returns the exit IP)
#
# Credentials go to curl on stdin, so they never show up in `ps`.
set -uo pipefail
cd "$(dirname "$0")/../terraform"

# One line: the console evaluates its input line by line.
expr='nonsensitive(jsonencode({ proxy = var.upstream_proxy, clients = length(var.client_names) }))'
if ! config=$(echo "$expr" | terraform console 2>&1); then
  echo "error: couldn't read the Terraform config:" >&2
  echo "$config" >&2
  exit 2
fi
# The console prints the JSON as a quoted string; unwrap it and check it parses.
if ! config=$(jq -r . <<<"$config" 2>/dev/null) || ! jq -e . >/dev/null 2>&1 <<<"$config"; then
  echo "error: unexpected output from terraform console:" >&2
  echo "$config" >&2
  exit 2
fi
if [ "$(jq -r .proxy <<<"$config")" = "null" ]; then
  echo "error: upstream_proxy is not set in client/terraform/terraform.tfvars" >&2
  exit 2
fi

{
  read -r PROXY_HOST
  read -r PROXY_PORT
  read -r PROXY_USERNAME
  read -r PROXY_PASSWORD
  read -r CLIENTS
} < <(jq -r '.proxy.host, .proxy.port, .proxy.username, .proxy.password, .clients' <<<"$config")

COUNT="${1:-$CLIENTS}"
URL="${2:-https://api.ipify.org}"

# curl config lines, fed on stdin via -K -. Quoted so special characters in the
# password survive.
curl_config() {
  printf 'proxy = "http://%s:%s"\n' "$PROXY_HOST" "$1"
  printf 'proxy-user = "%s:%s"\n' "$PROXY_USERNAME" "$PROXY_PASSWORD"
}

failed=0
for ((i = 0; i < COUNT; i++)); do
  port=$((PROXY_PORT + i))
  printf '%s:%s  ' "$PROXY_HOST" "$port"

  body_file=$(mktemp)
  err_file=$(mktemp)
  read -r connect code secs < <(curl_config "$port" | curl -K - -sS -m 30 -o "$body_file" \
    -w '%{http_connect} %{http_code} %{time_total}\n' "$URL" 2>"$err_file")

  if [ "$code" = "200" ]; then
    printf 'OK    %6.2fs  %s\n' "$secs" "$(head -c 200 "$body_file" | tr -d '\n')"
  else
    failed=$((failed + 1))
    reason=$(head -n1 "$err_file")
    if [ "$connect" != "000" ] && [ "$connect" != "200" ]; then
      # The proxy refused the HTTPS tunnel, and curl hides its explanation.
      # Ask again over plain HTTP, where the proxy's error page is the body.
      reason=$(curl_config "$port" | curl -K - -s -m 30 http://api.ipify.org | head -c 200 | tr -d '\n')
    elif [ -s "$body_file" ]; then
      reason=$(head -c 200 "$body_file" | tr -d '\n')
    fi
    printf 'FAIL  proxy=%s http=%s  %s\n' "$connect" "$code" "$reason"
  fi
  rm -f "$body_file" "$err_file"
done

[ "$failed" -eq 0 ]
