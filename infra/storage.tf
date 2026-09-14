/**
 * Future session storage in S3 (BACKLOG.md "Storage & retention"). Disabled by
 * default -- sessions currently live on the instance's local disk at
 * var.data_dir. Set enable_s3_storage = true once the server actually writes
 * to S3, then wire AFK_* env vars / IAM access as a follow-up.
 */

resource "aws_s3_bucket" "sessions" {
  count = var.enable_s3_storage ? 1 : 0

  bucket = var.s3_bucket_name

  tags = {
    Project = "afk"
  }
}

resource "aws_s3_bucket_public_access_block" "sessions" {
  count = var.enable_s3_storage ? 1 : 0

  bucket = aws_s3_bucket.sessions[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "sessions" {
  count = var.enable_s3_storage ? 1 : 0

  bucket = aws_s3_bucket.sessions[0].id

  rule {
    id     = "expire-sessions"
    status = "Enabled"

    filter {}

    expiration {
      days = var.s3_lifecycle_expiration_days
    }
  }
}
