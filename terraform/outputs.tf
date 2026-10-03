output "account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "readonly_role_arn" {
  value = aws_iam_role.readonly.arn
}

output "w1_volume_ids" {
  value = aws_ebs_volume.w1[*].id
}

output "w2_volume_id" {
  value = aws_ebs_volume.w2.id
}

output "w3_allocation_id" {
  value = aws_eip.w3.allocation_id
}

output "w4_instance_id" {
  value = aws_instance.w4.id
}

output "w5_instance_id" {
  value = aws_instance.w5.id
}

output "w7_ami_id" {
  value = aws_ami_from_instance.w7.id
}

output "w8_bucket" {
  value = aws_s3_bucket.w8.id
}
