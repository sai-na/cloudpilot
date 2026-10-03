/**
 * The read-only IAM policy a scan needs, carried in the package so that
 * `cloudpilot init --print-policy` works wherever CloudPilot was installed.
 * It is a copy of docs/cloudpilot-readonly-policy.json; a test fails if the
 * two ever differ.
 */
export const READ_ONLY_POLICY = {
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Ec2Describe",
      "Effect": "Allow",
      "Action": [
        "ec2:Describe*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "S3BucketMetadata",
      "Effect": "Allow",
      "Action": [
        "s3:ListAllMyBuckets",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:GetLifecycleConfiguration",
        "s3:ListBucketMultipartUploads",
        "s3:ListMultipartUploadParts",
        "s3:GetBucketTagging"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudWatchMetricsRead",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:GetMetricData",
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:ListMetrics"
      ],
      "Resource": "*"
    },
    {
      "Sid": "PriceListRead",
      "Effect": "Allow",
      "Action": [
        "pricing:GetProducts",
        "pricing:DescribeServices"
      ],
      "Resource": "*"
    }
  ]
} as const;
