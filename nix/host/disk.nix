# The disk layout of a fresh install with nixos-anywhere, on any provider. It
# writes the same file system labels as the official NixOS EC2 image (ESP and
# nixos), and default.nix mounts them by label. So disko only formats the disk
# here (enableConfig = false), and an EC2 instance that started from the
# official image takes this configuration without a new install.
{ lib, ... }:
{
  disko.enableConfig = false;
  disko.devices.disk.main = {
    type = "disk";
    # NVMe on EC2 and most Nitro-like VMs. Override it at install time for a
    # provider that names its disk otherwise (DEPLOYMENT.md).
    device = lib.mkDefault "/dev/nvme0n1";
    content = {
      type = "gpt";
      partitions = {
        ESP = {
          type = "EF00";
          size = "512M";
          content = {
            type = "filesystem";
            format = "vfat";
            extraArgs = [
              "-n"
              "ESP"
            ];
            mountpoint = "/boot";
            mountOptions = [ "umask=0077" ];
          };
        };
        root = {
          size = "100%";
          content = {
            type = "filesystem";
            format = "ext4";
            extraArgs = [
              "-L"
              "nixos"
            ];
            mountpoint = "/";
          };
        };
      };
    };
  };
}
