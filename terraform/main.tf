locals {
  spec    = jsondecode(file("${path.module}/../lab-spec.json"))
  project = local.spec.project_tag
  az      = local.spec.az
}

provider "aws" {
  region  = local.spec.region
  profile = var.use_emulator ? null : local.spec.seed_profile

  allowed_account_ids = var.use_emulator ? null : [var.account_id]

  # Emulator mode: dummy credentials, everything routed to Moto.
  access_key                  = var.use_emulator ? "testing" : null
  secret_key                  = var.use_emulator ? "testing" : null
  skip_credentials_validation = var.use_emulator
  skip_metadata_api_check     = var.use_emulator
  s3_use_path_style           = var.use_emulator

  dynamic "endpoints" {
    for_each = var.use_emulator ? [var.emulator_endpoint] : []
    content {
      ec2        = endpoints.value
      s3         = endpoints.value
      iam        = endpoints.value
      sts        = endpoints.value
      ssm        = endpoints.value
      cloudwatch = endpoints.value
    }
  }

  default_tags {
    tags = {
      Project = local.project
    }
  }
}

data "aws_caller_identity" "current" {}

# Real AWS and the emulator must never share a state file: the "emulator"
# workspace is the only one allowed to talk to Moto, and it may not talk to AWS.
resource "terraform_data" "mode_guard" {
  lifecycle {
    precondition {
      condition     = var.use_emulator == (terraform.workspace == "emulator")
      error_message = "use_emulator=true requires the 'emulator' workspace, and the 'emulator' workspace requires use_emulator=true. Run Terraform through scripts/tf.sh."
    }
  }
}
