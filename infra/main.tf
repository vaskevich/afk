/**
 * Lightsail instance running the afk server, fronted by Caddy for TLS.
 */

resource "aws_lightsail_key_pair" "afk" {
  name       = "afk-server"
  public_key = var.ssh_public_key
}

resource "aws_lightsail_instance" "afk" {
  name              = "afk-server"
  availability_zone = var.availability_zone
  blueprint_id      = var.blueprint_id
  bundle_id         = var.lightsail_bundle_id
  key_pair_name     = aws_lightsail_key_pair.afk.name

  # NOTE: changing user_data after the instance exists forces Lightsail to replace
  # the instance, which would wipe the local-disk session data in var.data_dir.
  # Treat this as a one-time bootstrap script; ship app/config changes with
  # deploy.sh instead of editing this and re-applying. See infra/README.md.
  user_data = templatefile("${path.module}/files/user_data.sh.tpl", {
    domain_name     = var.domain_name
    service_user    = var.service_user
    app_dir         = var.app_dir
    data_dir        = var.data_dir
    node_major      = var.node_major_version
    pnpm_version    = var.pnpm_version
    public_base_url = "https://${var.domain_name}"
  })

  tags = {
    Project = "afk"
  }
}

resource "aws_lightsail_static_ip" "afk" {
  name = "afk-server-ip"
}

resource "aws_lightsail_static_ip_attachment" "afk" {
  static_ip_name = aws_lightsail_static_ip.afk.name
  instance_name  = aws_lightsail_instance.afk.name
}

resource "aws_lightsail_instance_public_ports" "afk" {
  instance_name = aws_lightsail_instance.afk.name

  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
    cidrs     = var.ssh_allowed_cidrs
  }

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
    cidrs     = ["0.0.0.0/0"]
  }

  port_info {
    protocol  = "tcp"
    from_port = 443
    to_port   = 443
    cidrs     = ["0.0.0.0/0"]
  }
}
