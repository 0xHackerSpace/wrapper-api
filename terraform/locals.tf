locals {
  worker_script_paths = {
    for key, worker in var.workers : key => abspath("${path.root}/${worker.script_path}")
  }

  worker_script_names = {
    for key, w in var.workers : key => coalesce(w.script_name, "${var.environment}-${key}")
  }

  jwt_secret_binding = var.jwt_secret != "" ? [{
    name = "JWT_SECRET"
    type = "secret_text"
    text = var.jwt_secret
  }] : []

  worker_bindings = {
    for key, worker in var.workers : key => concat(
      [for binding in worker.bindings : merge(
        { name = binding.name, type = binding.type },
        binding.type == "kv_namespace" ? { namespace_id = module.kv[binding.resource_key].id } : {},
        binding.type == "r2_bucket" ? { bucket_name = module.r2[binding.resource_key].name } : {},
        binding.type == "d1" ? { database_id = module.d1[binding.resource_key].id } : {},
        binding.type == "queue" ? { queue_name = module.queues[binding.resource_key].name } : {}
      )],
      [for sb in worker.service_bindings : merge(
        { name = sb.name, type = "service" },
        sb.target_worker != null ? { service = local.worker_script_names[sb.target_worker] } : {},
        sb.target_rag != null ? { service = local.rag_script_names[sb.target_rag] } : {},
        sb.entrypoint != null ? { entrypoint = sb.entrypoint } : {}
      )],
      local.jwt_secret_binding,
      worker.additional_bindings
    )
  }
}
