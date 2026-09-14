output "container_service_url" {
  description = "Lightsail-generated URL for the container service (works once a deployment exists, independent of the custom domain/certificate)."
  value       = aws_lightsail_container_service.afk.url
}

output "url" {
  description = "Public URL the dashboard/ingest API is served on, once the custom domain is validated and a deployment exists."
  value       = "https://${var.domain_name}"
}

output "bucket_name" {
  description = "Name of the Lightsail bucket sessions are stored in (AFK_S3_BUCKET)."
  value       = aws_lightsail_bucket.sessions.name
}

output "bucket_region" {
  description = "Region the bucket lives in (AFK_S3_REGION)."
  value       = aws_lightsail_bucket.sessions.region
}

output "bucket_access_key_id" {
  description = "Access key id for the bucket (AFK_S3_ACCESS_KEY_ID)."
  value       = aws_lightsail_bucket_access_key.sessions.access_key_id
}

output "bucket_secret_access_key" {
  description = "Secret access key for the bucket (AFK_S3_SECRET_ACCESS_KEY). Sensitive: read it with `tofu output -raw bucket_secret_access_key`, never printed in a plain `tofu output`."
  value       = aws_lightsail_bucket_access_key.sessions.secret_access_key
  sensitive   = true
}
