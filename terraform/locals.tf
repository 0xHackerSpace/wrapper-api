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

  # Worker-scoped secret, unlike jwt_secret_binding (injected into every
  # worker) -- only huggingface-worker needs it. .tfvars files can't reference
  # var.* directly (only literal values), so this can't be expressed via
  # worker.additional_bindings the way non-sensitive bindings are; it has to
  # be wired here instead, same reasoning as jwt_secret_binding.
  hf_token_binding = var.hf_token != "" ? [{
    name = "HF_TOKEN"
    type = "secret_text"
    text = var.hf_token
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
      key == "huggingface" ? local.hf_token_binding : [],
      worker.additional_bindings
    )
  }
}
