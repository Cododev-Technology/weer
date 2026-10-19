# The load test machines: the weer server, a tester and a PostgreSQL machine, as Spot instances.
#
#   terraform init      once
#   terraform apply     start the 3 machines and print their addresses
#   terraform destroy   stop paying for them
#
# Each machine sets itself up when it boots (setup/basic.sh, then its own script), which takes a
# few minutes. ssh in and run "cloud-init status --wait" to know when it's done.
#
# Before the first apply:
#   - AWS credentials for Terraform (aws configure)
#   - A key pair named "key" in us-east-2 (Ohio): EC2 console > Key pairs > Create key pair, .pem format.
#     Then: mv ~/Downloads/key.pem ~/.ssh/ && chmod 400 ~/.ssh/key.pem
#   - A Spot quota of at least 112 vCPUs in us-east-2 (48 + 48 + 16). New accounts get less: Service Quotas >
#     Amazon EC2 > "All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests" > Request increase.
#
# This file has what the machines need around them; machines.tf has the machines.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
    }
  }
}

provider "aws" {
  region = "us-east-2"
}

locals {
  ami  = "ami-0c8db2e74523f6b6b" # Ubuntu 26.04 for ARM
  zone = "us-east-2a"
  key  = "key" # key.pem
}

# ssh and 2080 (the app) from anywhere, and everything between the 3 machines (the tester to the
# server, the server to the db). Nothing else from outside: Redis on the server has no password.
resource "aws_security_group" "load_test" {
  name        = "weer-load-test"
  description = "ssh and 2080 from anywhere, everything between the load test machines"

  ingress {
    description = "ssh"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "the app"
    from_port   = 2080
    to_port     = 2080
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "everything between the load test machines"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# The 3 machines close together in one data center, for the fastest network between them
resource "aws_placement_group" "load_test" {
  name     = "weer-load-test"
  strategy = "cluster"
}
