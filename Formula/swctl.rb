class Swctl < Formula
  desc "Manage Shopware 6 worktrees with Docker, Traefik, and an ANSI TUI"
  homepage "https://github.com/your-org/swctl"
  url "file:///Users/ytran/Shopware/swctl/dist/swctl-0.1.0.tar.gz"
  sha256 "9d4213d527879d89706043a395efb580a8e44263fb28558240b62eeac5bcc725"
  license "MIT"
  version "0.1.0"

  depends_on "docker"
  depends_on "git"
  depends_on "mariadb"

  def install
    libexec.install "swctl"
    bin.env_script_all_files(libexec, SWCTL_TEMPLATE_DIR: pkgshare)
    pkgshare.install ".swctl.conf.example", "docker-compose.swctl.yml", "README.md"

    # Placeholder for future shell completion support:
    # bash_completion.install "completions/swctl.bash" => "swctl"
  end

  def caveats
    <<~EOS
      Copy the example config into your Shopware project root:
        cp #{pkgshare}/.swctl.conf.example /path/to/your/project/.swctl.conf

      The bundled compose template lives at:
        #{pkgshare}/docker-compose.swctl.yml

      Update the `url` and `sha256` in Formula/swctl.rb when switching from local file testing
      to GitHub Releases.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/swctl --version")
  end
end
