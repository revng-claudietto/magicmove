{
  description = "magicmove: render shiki-magic-move code transitions to video";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        magicmove = pkgs.buildNpmPackage {
          pname = "magicmove";
          version = "0.2.0";
          src = ./.;

          # Filled in by nix on first build; copy the suggested hash here.
          npmDepsHash = "sha256-IhaW1eWyvtXXW1i7XPrsKKP3D2IvW1ujpqbwYw+b+3I=";

          # Skip postinstall scripts so the playwright npm package doesn't try
          # to download Chromium at install time — we provide it via nixpkgs.
          npmFlags = [ "--ignore-scripts" ];

          # Disable Playwright's browser download during the build.
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

          # `npm run build` invokes esbuild to produce bundled.js
          buildPhase = ''
            runHook preBuild
            npm run build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/magicmove $out/bin
            cp magicmove.mjs bundled.js package.json $out/lib/magicmove/
            cp -r node_modules $out/lib/magicmove/
            cp -r examples $out/lib/magicmove/ 2>/dev/null || true

            cat > $out/bin/magicmove <<EOF
            #!${pkgs.runtimeShell}
            export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
            export PATH="${pkgs.lib.makeBinPath [ pkgs.ffmpeg ]}:\$PATH"
            exec ${pkgs.nodejs_22}/bin/node $out/lib/magicmove/magicmove.mjs "\$@"
            EOF
            chmod +x $out/bin/magicmove

            runHook postInstall
          '';

          dontFixup = true;
        };
      in {
        packages.default = magicmove;

        apps.default = {
          type = "app";
          program = "${magicmove}/bin/magicmove";
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [ nodejs_22 ffmpeg ];
          shellHook = ''
            export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
          '';
        };
      });
}
