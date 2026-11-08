# The EC2 hardware profile (Nitro instances such as t4g.small): the parts of
# nixpkgs' amazon-image.nix that the host needs to boot and keep time. We do
# not import amazon-image.nix: it also runs EC2 user data as root at each
# boot, starts sshd and the SSM agent, and takes the host name from EC2, and
# the host wants none of these. On another provider, replace this file.
{ config, pkgs, ... }:
{
  # Nitro: EBS volumes are NVMe disks, and the network is ENA.
  boot.initrd.availableKernelModules = [
    "nvme"
    "ena"
  ];
  boot.extraModulePackages = [ config.boot.kernelPackages.ena ];
  boot.kernelParams = [
    "console=ttyS0,115200n8"
    "random.trust_cpu=on"
    # AWS's value for EBS on kernels from 4.15.
    "nvme_core.io_timeout=4294967295"
  ];
  boot.blacklistedKernelModules = [ "xen_fbfront" ];
  boot.loader.grub.extraConfig = ''
    serial --unit=0 --speed=115200 --word=8 --parity=no --stop=1
    terminal_output console serial
    terminal_input console serial
  '';
  # The EC2 serial console shows the boot. It has no password login.
  systemd.services."serial-getty@ttyS0".enable = true;
  # The hypervisor's time server.
  networking.timeServers = [ "169.254.169.123" ];
  # Stable names for the EBS devices.
  services.udev.packages = [ pkgs.amazon-ec2-utils ];
}
