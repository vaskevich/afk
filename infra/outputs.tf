output "static_ip" {
  description = "Static IP address of the afk Lightsail instance."
  value       = aws_lightsail_static_ip.afk.ip_address
}

output "instance_name" {
  description = "Lightsail instance name (for `aws lightsail get-instance` / SSH)."
  value       = aws_lightsail_instance.afk.name
}

output "ssh_command" {
  description = "Convenience SSH command using the generated key pair."
  value       = "ssh ${var.ssh_login_user}@${aws_lightsail_static_ip.afk.ip_address}"
}

output "url" {
  description = "Public URL the dashboard/ingest API is served on."
  value       = "https://${var.domain_name}"
}

output "s3_bucket_name" {
  description = "Name of the session-storage S3 bucket, if enabled."
  value       = var.enable_s3_storage ? aws_s3_bucket.sessions[0].id : null
}
