/**
 * Session storage: a Lightsail object storage bucket (S3-compatible), used by
 * packages/server/src/store/s3-storage.ts via AFK_STORAGE=s3.
 *
 * Lightsail's "resource access" (bucket <-> compute) only wires up instances, not
 * container services, so the container gets credentials the ordinary way: an access
 * key handed to it as environment variables (AFK_S3_ACCESS_KEY_ID /
 * AFK_S3_SECRET_ACCESS_KEY), read from `tofu output` by deploy.sh. Lightsail buckets
 * have no lifecycle rules, so expiry is the server's own sweeper (see BACKLOG.md),
 * not a bucket setting.
 */

resource "aws_lightsail_bucket" "sessions" {
  name      = var.bucket_name
  bundle_id = "small_1_0" # smallest bundle: 5 GB storage / 25 GB transfer, plenty for NDJSON session files

  tags = {
    Project = "afk"
  }
}

resource "aws_lightsail_bucket_access_key" "sessions" {
  bucket_name = aws_lightsail_bucket.sessions.name
}
