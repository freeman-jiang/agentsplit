# The production build, as the Dockerfile makes it: the client build, the
# server bundle and the SQL migrations, plus a launcher that runs the bundle on
# the flake's Bun. The output holds only dist/, because the server bundle needs
# no node_modules at run time.
#
# Dependencies: node_modules is a fixed-output derivation (FOD) that runs
# `bun install --frozen-lockfile` with network access, and Nix checks its
# output against the hash below. We chose this over a generator such as
# bun2nix because it needs no extra flake input and no generated file to keep
# in step with bun.lock: bun.lock stays the one source of truth, and a changed
# lockfile only changes the hash. The cost is that the hash must be updated by
# hand after each dependency change (see `nodeModulesHashes`). Each system
# installs its own native optional packages (Rolldown, Lightning CSS, the
# Tailwind oxide), so each system has its own hash; `--cpu` and `--os` make
# the install the same on every build machine.
{
  lib,
  stdenvNoCC,
  bun,
  cacert,
  makeWrapper,
}:
let
  # After a change to package.json or bun.lock: set the hash of the dev box's
  # system to lib.fakeHash, build .#agentsplit, and copy the hash that Nix
  # reports. The x86_64 hash was taken on aarch64 with `--cpu=x64`
  # (`nix build .#agentsplit.nodeModules-x86_64`), which installs the same files.
  nodeModulesHashes = {
    aarch64-linux = "sha256-irQfSQ6Df6qKzZ+JKcD5YnY/3FS8i4tq+hBmhw9rrGY=";
    x86_64-linux = "sha256-8/AVv8+atfbXLJXeLm7kxNuV/b7l7X3bs+ncCRoSI3U=";
  };
  bunCpu = {
    aarch64-linux = "arm64";
    x86_64-linux = "x64";
  };

  root = ../.;
  # Only the files that the build reads, so a change to docs or tests does not rebuild the package.
  installSrc = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/bun.lock")
      (root + "/bunfig.toml")
    ];
  };
  buildSrc = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/bun.lock")
      (root + "/bunfig.toml")
      (root + "/tsconfig.json")
      (root + "/vite.config.ts")
      (root + "/index.html")
      (root + "/public")
      (root + "/src")
      (root + "/db")
      (root + "/scripts/build-server.ts")
    ];
  };
  version = (lib.importJSON (root + "/package.json")).version;

  nodeModulesFor =
    { system, hash }:
    stdenvNoCC.mkDerivation {
      pname = "agentsplit-node-modules";
      inherit version;
      src = installSrc;
      nativeBuildInputs = [
        bun
        cacert
      ];
      dontConfigure = true;
      buildPhase = ''
        runHook preBuild
        export HOME="$TMPDIR"
        # package.json trusts no lifecycle scripts, as in the Dockerfile.
        bun install --frozen-lockfile --ignore-scripts --no-progress \
          --cache-dir="$TMPDIR/bun-cache" --os=linux --cpu=${bunCpu.${system}}
        runHook postBuild
      '';
      installPhase = ''
        runHook preInstall
        # Bun's own cache folder holds install times, which would change the hash.
        rm -rf node_modules/.cache
        mkdir -p "$out"
        cp -R node_modules "$out/"
        runHook postInstall
      '';
      # A fixed output must not refer to the store, so no shebang patching.
      dontFixup = true;
      outputHashMode = "recursive";
      outputHashAlgo = "sha256";
      outputHash = hash;
    };

  system = stdenvNoCC.hostPlatform.system;
  nodeModules = nodeModulesFor {
    inherit system;
    hash = nodeModulesHashes.${system};
  };
in
stdenvNoCC.mkDerivation {
  pname = "agentsplit";
  inherit version;
  src = buildSrc;
  nativeBuildInputs = [
    bun
    makeWrapper
  ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR"
    cp -R ${nodeModules}/node_modules node_modules
    chmod -R u+w node_modules
    # The .bin launchers start with `#!/usr/bin/env node`, and the sandbox has
    # no /usr/bin/env. Point them at Bun, as the Bun image's `node` link does.
    mkdir -p "$TMPDIR/bin"
    ln -s ${lib.getExe bun} "$TMPDIR/bin/node"
    export PATH="$TMPDIR/bin:$PATH"
    for launcher in node_modules/.bin/*; do
      patchShebangs "$(readlink -f "$launcher")"
    done
    bun run build
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/agentsplit" "$out/bin"
    cp -R dist/server dist/client dist/migrations "$out/share/agentsplit/"
    # The settings that the Dockerfile sets; the service adds the rest.
    makeWrapper ${lib.getExe bun} "$out/bin/agentsplit-server" \
      --add-flags "$out/share/agentsplit/server/server.js" \
      --set-default NODE_ENV production \
      --set-default TZ UTC \
      --set-default CLIENT_DIR "$out/share/agentsplit/client" \
      --set-default MIGRATIONS_DIR "$out/share/agentsplit/migrations"
    runHook postInstall
  '';
  passthru = {
    inherit nodeModules;
    # The x86_64 install on any build machine, to take its hash (see nodeModulesHashes).
    nodeModules-x86_64 = nodeModulesFor {
      system = "x86_64-linux";
      hash = nodeModulesHashes.x86_64-linux;
    };
  };
  meta = {
    description = "AgentSplit server and client build";
    mainProgram = "agentsplit-server";
    platforms = builtins.attrNames nodeModulesHashes;
  };
}
