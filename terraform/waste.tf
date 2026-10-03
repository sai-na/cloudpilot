data "aws_ssm_parameter" "al2023" {
  count = var.ami_id == "" ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  ami_id = var.ami_id != "" ? var.ami_id : data.aws_ssm_parameter.al2023[0].insecure_value
}

# The default VPC's subnet in the lab AZ. Named explicitly so the instances
# can be launched without a public IPv4 address (which is billed hourly).
data "aws_subnet" "default" {
  availability_zone = local.az
  default_for_az    = true
}

# W1: two unattached gp2 volumes.
resource "aws_ebs_volume" "w1" {
  count = local.spec.w1.count

  availability_zone = local.az
  size              = local.spec.w1.size_gb
  type              = local.spec.w1.type

  tags = {
    Name         = "${local.project}-w1-unattached-gp2-${count.index + 1}"
    WastePattern = "W1"
  }

  depends_on = [aws_budgets_budget.lab]
}

# W2: one unattached gp3 volume.
resource "aws_ebs_volume" "w2" {
  availability_zone = local.az
  size              = local.spec.w2.size_gb
  type              = local.spec.w2.type

  tags = {
    Name         = "${local.project}-w2-unattached-gp3"
    WastePattern = "W2"
  }

  depends_on = [aws_budgets_budget.lab]
}

# W3: Elastic IP that is never associated.
resource "aws_eip" "w3" {
  domain = "vpc"

  tags = {
    Name         = "${local.project}-w3-idle-eip"
    WastePattern = "W3"
  }

  depends_on = [aws_budgets_budget.lab]
}

# W4: instance that is stopped right after launch, still paying for its root volume.
resource "aws_instance" "w4" {
  ami                         = local.ami_id
  instance_type               = local.spec.w4.instance_type
  subnet_id                   = data.aws_subnet.default.id
  associate_public_ip_address = false

  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_size           = local.spec.w4.root_gb
    volume_type           = local.spec.w4.root_type
    delete_on_termination = true

    tags = {
      Name         = "${local.project}-w4-stopped-instance-root"
      Project      = local.project
      WastePattern = "W4"
    }
  }

  tags = {
    Name         = "${local.project}-w4-stopped-instance"
    WastePattern = "W4"
  }

  lifecycle {
    # Neither a newer AMI release nor a public-IP readback may replace the
    # instance mid-lab.
    ignore_changes = [ami, associate_public_ip_address]
  }

  depends_on = [aws_budgets_budget.lab]
}

resource "aws_ec2_instance_state" "w4" {
  instance_id = aws_instance.w4.id
  state       = "stopped"
}

# W5: running instance with no workload. CloudWatch collects near-zero CPU.
resource "aws_instance" "w5" {
  ami                         = local.ami_id
  instance_type               = local.spec.w5.instance_type
  subnet_id                   = data.aws_subnet.default.id
  associate_public_ip_address = false

  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_size           = local.spec.w5.root_gb
    volume_type           = local.spec.w5.root_type
    delete_on_termination = true

    tags = {
      Name         = "${local.project}-w5-idle-instance-root"
      Project      = local.project
      WastePattern = "W5"
    }
  }

  tags = {
    Name         = "${local.project}-w5-idle-instance"
    WastePattern = "W5"
  }

  lifecycle {
    # Replacing the instance would throw away its CloudWatch CPU history.
    ignore_changes = [ami, associate_public_ip_address]
  }

  depends_on = [aws_budgets_budget.lab]
}

# W7: AMI of the stopped W4 instance, used by nothing.
resource "aws_ami_from_instance" "w7" {
  name                    = "${local.project}-w7-unused-ami"
  source_instance_id      = aws_instance.w4.id
  snapshot_without_reboot = true

  tags = {
    Name         = "${local.project}-w7-unused-ami"
    WastePattern = "W7"
  }

  depends_on = [aws_ec2_instance_state.w4]
}

# The snapshot behind the AMI is not tagged by the AMI resource; tag it so
# the teardown sweep finds it.
resource "aws_ec2_tag" "w7_snapshot" {
  for_each = {
    Name         = "${local.project}-w7-unused-ami-snapshot"
    Project      = local.project
    WastePattern = "W7"
  }

  resource_id = aws_ami_from_instance.w7.root_snapshot_id
  key         = each.key
  value       = each.value
}

# W8: bucket with a few small objects and no lifecycle configuration.
# W9 (an abandoned multipart upload) is planted in it by scripts/seed.sh.
resource "aws_s3_bucket" "w8" {
  bucket        = "${local.spec.bucket_prefix}-${data.aws_caller_identity.current.account_id}"
  force_destroy = true

  tags = {
    Name         = "${local.project}-w8-no-lifecycle"
    WastePattern = "W8"
  }

  depends_on = [aws_budgets_budget.lab]
}

resource "aws_s3_object" "w8" {
  for_each = local.spec.w8.objects

  bucket  = aws_s3_bucket.w8.id
  key     = each.key
  content = each.value

  tags = {
    WastePattern = "W8"
  }
}
