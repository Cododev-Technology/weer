# The load test machines: the weer server, a tester and a PostgreSQL machine, as Spot instances.
#
#   terraform init      once
#   terraform apply     start the 3 machines and print their addresses
#   terraform destroy   stop paying for them
#
# Each machine sets itself up when it boots (basic-setup.sh, then its own script), which takes a
# few minutes. ssh in and run "cloud-init status --wait" to know when it's done.

# Sized for 1M req/s for 2 minutes (120M requests), from our load test measurements.
# The comments say what changes for 30 minutes (1.8 billion requests).
locals {
  server_type = "c8gn.12xlarge" # about 30 busy cores at 1M (server-turbo, 12 Redis masters, network). 30 minutes: the same
  tester_type = "c8gn.12xlarge" # about 31 busy cores at 1M (32,000 req/s per core). 30 minutes: the same
  db_type     = "c8gn.4xlarge"  # 1.1M views/s on 16 cores with COPY. 30 minutes: the same

  #   type            vCPUs  memory   network       Spot $/hour  queues
  #   c8gn.medium         1    2 GB   up to 25 Gbit       0.006       1
  #   c8gn.large          2    4 GB   up to 30 Gbit       0.017       2
  #   c8gn.xlarge         4    8 GB   up to 40 Gbit       0.049       4
  #   c8gn.2xlarge        8   16 GB   up to 50 Gbit       0.094       8
  #   c8gn.4xlarge       16   32 GB    50 Gbit            0.21       16
  #   c8gn.8xlarge       32   64 GB   100 Gbit            0.50       32
  #   c8gn.12xlarge      48   96 GB   150 Gbit            0.88       32
  #   c8gn.16xlarge      64  128 GB   200 Gbit            1.02       64
  #   c8gn.24xlarge      96  192 GB   300 Gbit            1.11       64
  #   c8gn.48xlarge     192  384 GB   600 Gbit            1.45      128

  ami             = "ami-0c8db2e74523f6b6b" # Ubuntu 26.04 for ARM
  zone            = "us-east-2a"
  key             = "key"                  # key.pem
  security_group  = "sg-05c53562fdfc60265" # allow-all
  placement_group = "GroupA"
}

provider "aws" {
  region = "us-east-2"
}

resource "aws_instance" "db" {
  ami                    = local.ami
  instance_type          = local.db_type
  availability_zone      = local.zone
  key_name               = local.key
  vpc_security_group_ids = [local.security_group]
  placement_group        = local.placement_group
  user_data              = "${file("basic-setup.sh")}\n${file("db-setup.sh")}"
  tags                   = { Name = "db" }

  instance_market_options {
    market_type = "spot"
  }

  root_block_device {
    volume_size = 50 # GB: 16 GB of views (133 bytes each) + 16 GB of WAL + Ubuntu. 30 minutes: 300 (240 GB of views)
    volume_type = "gp3"
    iops        = 8000 # it did up to 4,700 writes/s; at least 4 per MB/s of throughput. 30 minutes: the same
    throughput  = 1000 # MB/s: 320-540 MB/s at 1M (820 with real browser rows). 30 minutes: the same
  }
}

resource "aws_instance" "server" {
  ami                    = local.ami
  instance_type          = local.server_type
  availability_zone      = local.zone
  key_name               = local.key
  vpc_security_group_ids = [local.security_group]
  placement_group        = local.placement_group
  user_data              = "${file("basic-setup.sh")}\n${file("server-setup.sh")}"
  tags                   = { Name = "server" }

  instance_market_options {
    market_type = "spot"
  }

  root_block_device {
    volume_size = 25 # GB: 11 GB of request logs (95 bytes each) + 7 GB of the rest. 30 minutes: 200 (171 GB of logs)
    volume_type = "gp3"
    throughput  = 250 # MB/s: the logs write 95 MB/s at 1M (the default is 125). 30 minutes: the same
  }
}

resource "aws_instance" "tester" {
  ami                    = local.ami
  instance_type          = local.tester_type
  availability_zone      = local.zone
  key_name               = local.key
  vpc_security_group_ids = [local.security_group]
  placement_group        = local.placement_group
  user_data              = "${file("basic-setup.sh")}\n${file("tester-setup.sh")}"
  tags                   = { Name = "tester" }

  instance_market_options {
    market_type = "spot"
  }

  root_block_device {
    volume_size = 8 # GB: the tester writes almost nothing. 30 minutes: the same
  }
}

# Public addresses, for ssh
output "server" { value = aws_instance.server.public_ip }
output "tester" { value = aws_instance.tester.public_ip }
output "db" { value = aws_instance.db.public_ip }

# Private addresses: DB_HOST in the server's .env, and --url http://<server_private_ip>:2080 on the tester
output "server_private_ip" { value = aws_instance.server.private_ip }
output "db_private_ip" { value = aws_instance.db.private_ip }
