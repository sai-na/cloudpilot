variable "budget_email" {
  description = "Email address that receives the budget alerts."
  type        = string
}

variable "account_id" {
  description = "AWS account the lab may be created in. Terraform refuses to run against any other account."
  type        = string
}

variable "use_emulator" {
  description = "Point the AWS provider at a local Moto server instead of AWS, and skip the budget."
  type        = bool
  default     = false
}

variable "emulator_endpoint" {
  description = "Moto server URL, used only when use_emulator is true."
  type        = string
  default     = "http://localhost:5050"
}

variable "ami_id" {
  description = "AMI for the W4 and W5 instances. Empty means the latest Amazon Linux 2023 x86_64 AMI."
  type        = string
  default     = ""
}
