class Swctl < Formula
  desc "Manage Shopware 6 worktrees with Docker, OrbStack, and an ANSI TUI"
  homepage "https://github.com/nguyenytran/swctl"
  url "https://github.com/nguyenytran/swctl/releases/download/v0.3.2/swctl-0.3.2.tar.gz"
  sha256 "PLACEHOLDER"
  license "MIT"
  version "0.3.2"

  depends_on "docker"
  depends_on "git"

  def install
    libexec.install "swctl"
    chmod 0755, libexec/"swctl"
    pkgshare.install ".swctl.conf.example",
                     "docker-compose.swctl.yml",
                     "docker-compose.swctl.orbstack.yml",
                     "app",
                     "README.md"

    # Also copy swctl into pkgshare so the Docker container can find it
    # at /swctl/swctl (SWCTL_SCRIPT_DIR is mounted at /swctl).
    cp libexec/"swctl", pkgshare/"swctl"
    chmod 0755, pkgshare/"swctl"

    # Create a wrapper that sets SWCTL_TEMPLATE_DIR so swctl can find
    # the compose templates and app/ directory installed into pkgshare.
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
