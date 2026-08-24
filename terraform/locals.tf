locals {
  worker_script_paths = {
    for key, worker in var.workers : key => abspath("${path.root}/../${worker.script_path}")
  }

  worker_bindings = {
    for key, worker in var.workers : key => concat(
      [for binding in worker.bindings : merge(
        { name = binding.name, type = binding.type },
        binding.type == "kv_namespace" ? { namespace_id = module.kv[binding.resource_key].id } : {},
        binding.type == "r2_bucket" ? { bucket_name = module.r2[binding.resource_key].name } : {},
        binding.type == "d1" ? { database_id = module.d1[binding.resource_key].id } : {},
        binding.type == "queue" ? { queue_name = module.queues[binding.resource_key].name } : {}
      )],
      worker.additional_bindings
    )
  }
}
