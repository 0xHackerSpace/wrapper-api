# worker

Publishes one ES Module Worker from a `.mjs` file and optional routes. Inputs: account ID, script name/path, compatibility date, bindings and routes. Outputs: script ID and name.

```hcl
module "worker" {
  source             = "../../worker"
  account_id         = var.account_id
  script_name        = "example"
  script_path        = "${path.root}/../../workers/api/index.mjs"
  compatibility_date = "2026-08-24"
}
```
