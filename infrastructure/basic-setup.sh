#!/bin/bash

# All 3 machines: the basic tools and the bashrc. Runs as root when the machine first boots.

set -ex

apt-get update
apt-get install -y vim build-essential git gdb net-tools ifstat sysstat iotop curl zip unzip

curl -fsSL https://raw.githubusercontent.com/Cododev-Technology/weer/1m-rps/infrastructure/bashrc -o /home/ubuntu/.bashrc
chown ubuntu:ubuntu /home/ubuntu/.bashrc

# Room for many connections: Ubuntu lets a user open only 1024 files (and so sockets) at once
echo "* soft nofile 1048576" >> /etc/security/limits.d/weer.conf
echo "* hard nofile 1048576" >> /etc/security/limits.d/weer.conf
