class Swctl < Formula
  desc "Manage Shopware 6 worktrees with Docker, OrbStack, and an ANSI TUI"
  homepage "https://github.com/nguyenytran/swctl"
  url "https://github.com/nguyenytran/swctl/releases/download/v0.2.0/swctl-0.2.0.tar.gz"
  sha256 "634fb5c31cb742f7022883f055e7cf0def0da835fdab25e512d0f85f303295d1"
  license "MIT"
  version "0.2.0"

  depends_on "docker"
  depends_on "git"

  def install
    libexec.install "swctl"
    chmod 0755, libexec/"swctl"
    pkgshare.install ".swctl.conf.example",
                     "docker-compose.swctl.yml",
                     "docker-compose.swctl.orbstack.yml",
                     "ui",
                     "README.md"

    # Create a wrapper that sets SWCTL_TEMPLATE_DIR so swctl can find
    # the compose templates and ui/ directory installed into pkgshare.
    (bin/"swctl").write <<~SH
      #!/bin/bash
      export SWCTL_TEMPLATE_DIR="#{pkgshare}"
      exec "#{libexec}/swctl" "$@"
    SH
    chmod 0755, bin/"swctl"
  end

  def caveats
    <<~EOS
      Copy the example config into your Shopware project root:
        cp #{pkgshare}/.swctl.conf.example /path/to/your/project/.swctl.conf

      Compose templates are at:
        #{pkgshare}/docker-compose.swctl.yml          (Traefik)
        #{pkgshare}/docker-compose.swctl.orbstack.yml (OrbStack)

      Start the web UI with:
        swctl ui

      Requires Docker (or OrbStack) to be installed and running.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/swctl --version")
  end
end
