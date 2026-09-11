resource "cloudflare_d1_database" "this" {
  account_id            = var.account_id
  name                  = var.name
  primary_location_hint = var.primary_location_hint
}

# Note: Migrations are best run locally or via CI/CD with direct file access
# HCP Terraform cannot access local files, so use manual approach:
# 1. terraform apply (creates database)
# 2. Export CLOUDFLARE_API_TOKEN and run locally:
#    for f in terraform/migrations/*.sql; do
#      wrangler d1 execute dev-auth --file="$f" --remote
#    done
# Or use GitHub Actions with wrangler deployed

# Uncomment below for local runs (terraform apply from your machine)
# resource "terraform_data" "migrations" {
#   count = var.run_migrations ? 1 : 0
#
#   triggers_replace = [
#     for migration in var.migrations : filesha256(migration)
#   ]
#
#   provisioner "local-exec" {
#     command = <<-EOT
#       for migration in ${join(" ", var.migrations)}; do
#         echo "Applying migration: $migration"
#         npx wrangler d1 execute ${cloudflare_d1_database.this.name} --file="$migration" --remote
#       done
#     EOT
#     environment = {
#       CLOUDFLARE_API_TOKEN = var.cloudflare_api_token
#     }
#   }
#
#   depends_on = [
#     cloudflare_d1_database.this
#   ]
# }
