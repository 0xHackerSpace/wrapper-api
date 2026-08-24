terraform {
  required_version = ">= 1.5.0"

  cloud {
    organization = "0xHackerSpace"

    workspaces {
      name    = "wrapper-api"
      project = "config"
    }
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.23.0"
    }
  }
}
