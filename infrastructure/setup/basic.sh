#!/bin/bash

# All 3 machines: the basic tools and the bashrc. Runs as root when the machine first boots.
# A Terraform template: machines.tf puts setup/bashrc in below. Terraform reads a dollar or percent
# sign followed by a brace in this file as its own, so double the sign to write one.

set -ex

apt-get update
apt-get install -y vim build-essential git gdb net-tools ifstat sysstat iotop curl zip unzip

cat > /home/ubuntu/.bashrc <<'BASHRC'
${bashrc}
BASHRC
chown ubuntu:ubuntu /home/ubuntu/.bashrc

# Room for many connections: Ubuntu lets a user open only 1024 files (and so sockets) at once
echo "* soft nofile 1048576" >> /etc/security/limits.d/weer.conf
echo "* hard nofile 1048576" >> /etc/security/limits.d/weer.conf
