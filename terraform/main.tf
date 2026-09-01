module "kv" {
  source     = "./modules/kv"
  for_each   = var.kv_namespaces
  account_id = var.account_id
  title      = coalesce(each.value.title, "${var.environment}-${each.key}")
}

module "r2" {
  source        = "./modules/r2"
  for_each      = var.r2_buckets
  account_id    = var.account_id
  name          = coalesce(each.value.name, "${var.environment}-${each.key}")
  location      = each.value.location
  jurisdiction  = each.value.jurisdiction
  storage_class = each.value.storage_class
}

module "d1" {
  source                = "./modules/d1"
  for_each              = var.d1_databases
  account_id            = var.account_id
  name                  = coalesce(each.value.name, "${var.environment}-${each.key}")
  primary_location_hint = each.value.primary_location_hint
}

module "queues" {
  source     = "./modules/queues"
  for_each   = var.queues
  account_id = var.account_id
  name       = coalesce(each.value.name, "${var.environment}-${each.key}")
}

module "dns" {
  source   = "./modules/dns"
  for_each = var.dns_records
  record   = each.value
}

module "worker" {
  source             = "./modules/worker"
  for_each           = var.workers
  account_id         = var.account_id
  script_name        = coalesce(each.value.script_name, "${var.environment}-${each.key}")
  script_path        = local.worker_script_paths[each.key]
  compatibility_date = each.value.compatibility_date
  bindings           = local.worker_bindings[each.key]
  routes             = each.value.routes
  domains            = each.value.domains
}
