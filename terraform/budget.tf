# Created before every other resource: everything else depends_on this.
resource "aws_budgets_budget" "lab" {
  count = var.use_emulator ? 0 : 1

  name         = "${local.project}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(local.spec.budget.limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Track spend before credits, otherwise an account running on credits
  # reports $0 actual cost and the alerts never fire.
  cost_types {
    include_credit = false
    include_refund = false
  }

  dynamic "notification" {
    for_each = local.spec.budget.thresholds_percent
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.budget_email]
    }
  }

  tags = {
    WastePattern = "none"
  }

  depends_on = [terraform_data.mode_guard]
}
