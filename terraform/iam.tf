# Read-only role CloudPilot runs under. Only the seed user can assume it.
resource "aws_iam_role" "readonly" {
  name = local.spec.readonly_role

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = data.aws_caller_identity.current.arn }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    WastePattern = "none"
  }

  depends_on = [aws_budgets_budget.lab]
}

resource "aws_iam_role_policy" "readonly" {
  name   = local.spec.readonly_role
  role   = aws_iam_role.readonly.id
  policy = file("${path.module}/../docs/cloudpilot-readonly-policy.json")
}
