locals {
  description = coalesce(var.description, "Vectorize index ${var.name} managed by Terraform.")
}

# The Cloudflare provider has no Vectorize resource yet (see docs/decisions/0003-vectorize-api-provisioning.md),
# so the index is provisioned through the Cloudflare API. The token is read from the environment and never
# enters Terraform state. Any change to triggers_replace recreates the index and drops its vectors.
resource "terraform_data" "index" {
  input = {
    account_id   = var.account_id
    name         = var.name
    dimensions   = var.dimensions
    metric       = var.metric
    api_base_url = var.api_base_url
  }

  triggers_replace = {
    account_id       = var.account_id
    name             = var.name
    dimensions       = var.dimensions
    metric           = var.metric
    description      = local.description
    metadata_indexes = jsonencode(var.metadata_indexes)
    api_base_url     = var.api_base_url
  }

  provisioner "local-exec" {
    interpreter = ["/bin/sh", "-c"]
    environment = {
      CF_ACCOUNT_ID  = var.account_id
      CF_INDEX_NAME  = var.name
      CF_DIMENSIONS  = tostring(var.dimensions)
      CF_METRIC      = var.metric
      CF_DESCRIPTION = local.description
      CF_API_BASE    = var.api_base_url
    }
    command = <<-EOT
      set -eu

      if [ -z "$${CLOUDFLARE_API_TOKEN:-}" ]; then
        echo "CLOUDFLARE_API_TOKEN must be exported to manage Vectorize indexes." >&2
        exit 1
      fi

      indexes="$CF_API_BASE/accounts/$CF_ACCOUNT_ID/vectorize/v2/indexes"

      call() {
        if [ "$#" -eq 3 ]; then
          curl -sS -X "$1" "$2" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" --data "$3"
        else
          curl -sS -X "$1" "$2" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
        fi
      }

      succeeded() {
        printf '%s' "$1" | grep -q '"success":[[:space:]]*true'
      }

      existing="$(call GET "$indexes/$CF_INDEX_NAME")"
      if succeeded "$existing"; then
        if ! printf '%s' "$existing" | grep -Eq "\"dimensions\"[[:space:]]*:[[:space:]]*$CF_DIMENSIONS([^0-9]|$)"; then
          echo "Vectorize index $CF_INDEX_NAME exists with different dimensions than $CF_DIMENSIONS." >&2
          exit 1
        fi
        echo "Vectorize index $CF_INDEX_NAME already exists; adopting it."
      else
        created="$(call POST "$indexes" "{\"name\":\"$CF_INDEX_NAME\",\"description\":\"$CF_DESCRIPTION\",\"config\":{\"dimensions\":$CF_DIMENSIONS,\"metric\":\"$CF_METRIC\"}}")"
        if ! succeeded "$created"; then
          echo "Failed to create Vectorize index $CF_INDEX_NAME: $created" >&2
          exit 1
        fi
        echo "Created Vectorize index $CF_INDEX_NAME."
      fi

      metadata_index() {
        result="$(call POST "$indexes/$CF_INDEX_NAME/metadata_index/create" "{\"propertyName\":\"$1\",\"indexType\":\"$2\"}")"
        if succeeded "$result"; then
          echo "Metadata index $1 created."
        elif printf '%s' "$result" | grep -qi 'already'; then
          echo "Metadata index $1 already exists."
        else
          echo "Failed to create metadata index $1: $result" >&2
          exit 1
        fi
      }

      %{~for property, kind in var.metadata_indexes}
      metadata_index "${property}" "${kind}"
      %{~endfor}
    EOT
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["/bin/sh", "-c"]
    environment = {
      CF_ACCOUNT_ID = self.input.account_id
      CF_INDEX_NAME = self.input.name
      CF_API_BASE   = self.input.api_base_url
    }
    command = <<-EOT
      set -eu

      if [ -z "$${CLOUDFLARE_API_TOKEN:-}" ]; then
        echo "CLOUDFLARE_API_TOKEN must be exported to delete Vectorize indexes." >&2
        exit 1
      fi

      deleted="$(curl -sS -X DELETE "$CF_API_BASE/accounts/$CF_ACCOUNT_ID/vectorize/v2/indexes/$CF_INDEX_NAME" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")"
      if printf '%s' "$deleted" | grep -q '"success":[[:space:]]*true'; then
        echo "Deleted Vectorize index $CF_INDEX_NAME."
      elif printf '%s' "$deleted" | grep -Eqi 'not_found|does not exist|vectorize index not found'; then
        echo "Vectorize index $CF_INDEX_NAME is already absent."
      else
        echo "Failed to delete Vectorize index $CF_INDEX_NAME: $deleted" >&2
        exit 1
      fi
    EOT
  }
}
