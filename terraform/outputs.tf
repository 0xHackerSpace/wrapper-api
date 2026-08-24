output "worker_names" {
  description = "Deployed Worker script names by logical key."
  value       = { for key, worker in module.worker : key => worker.script_name }
}

output "resource_ids" {
  description = "Provisioned resource IDs, keyed by logical name."
  value = {
    kv = { for key, resource in module.kv : key => resource.id }
    r2 = { for key, resource in module.r2 : key => resource.id }
    d1 = { for key, resource in module.d1 : key => resource.id }
    q  = { for key, resource in module.queues : key => resource.id }
  }
}
