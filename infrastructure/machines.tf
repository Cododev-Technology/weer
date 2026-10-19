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

  # Just for our peace of mind: The most each machine may cost per hour, so the worst case is $2.87/hour instead of on-demand's
  # $6.81. Above a cap the machine doesn't start (apply fails at once), or AWS takes it back.
  server_max_price = "1.20" # the 90-day Spot high was 1.13, on-demand is 2.84
  tester_max_price = "1.20"
  db_max_price     = "0.30" # the 90-day Spot high was 0.25, on-demand is 0.95
}

# Every machine runs setup/basic.sh first (with setup/bashrc in it), then its own script
locals {
  basic_setup = templatefile("setup/basic.sh", { bashrc = file("setup/bashrc") })
}

resource "aws_instance" "db" {
  ami                    = local.ami
  instance_type          = local.db_type
  availability_zone      = local.zone
  key_name               = local.key
  vpc_security_group_ids = [aws_security_group.load_test.id]
  placement_group        = aws_placement_group.load_test.name
  user_data              = "${local.basic_setup}\n${file("setup/db.sh")}"
  tags                   = { Name = "db" }

  instance_market_options {
    market_type = "spot"
    spot_options {
      max_price = local.db_max_price
    }
  }

  root_block_device {
    volume_size = 500 # GB: a minute of 1M req/s adds about 8 GB of views (133 bytes each; 16 GB with real browser rows), plus up to 16 GB of WAL and Ubuntu. About an hour of 1M
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
  vpc_security_group_ids = [aws_security_group.load_test.id]
  placement_group        = aws_placement_group.load_test.name
  user_data              = "${local.basic_setup}\n${file("setup/server.sh")}"
  tags                   = { Name = "server" }

  instance_market_options {
    market_type = "spot"
    spot_options {
      max_price = local.server_max_price
    }
  }

  root_block_device {
    volume_size = 500 # GB: a minute of 1M req/s adds about 5.7 GB of request logs (95 bytes each), plus 7 GB of the rest. About 85 minutes of 1M
    volume_type = "gp3"
    throughput  = 250 # MB/s: the logs write 95 MB/s at 1M (the default is 125). 30 minutes: the same
  }
}

resource "aws_instance" "tester" {
  ami                    = local.ami
  instance_type          = local.tester_type
  availability_zone      = local.zone
  key_name               = local.key
  vpc_security_group_ids = [aws_security_group.load_test.id]
  placement_group        = aws_placement_group.load_test.name
  user_data              = "${local.basic_setup}\n${file("setup/tester.sh")}"
  tags                   = { Name = "tester" }

  instance_market_options {
    market_type = "spot"
    spot_options {
      max_price = local.tester_max_price
    }
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

# Ready to paste
output "ssh" {
  value = {
    server = "ssh -i ~/.ssh/key.pem ubuntu@${aws_instance.server.public_ip}"
    tester = "ssh -i ~/.ssh/key.pem ubuntu@${aws_instance.tester.public_ip}"
    db     = "ssh -i ~/.ssh/key.pem ubuntu@${aws_instance.db.public_ip}"
  }
}
