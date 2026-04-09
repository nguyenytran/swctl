SHELL := /usr/bin/env bash
VERSION ?= 0.1.0
DIST_DIR := dist
PACKAGE := swctl-$(VERSION)
ARTIFACT := $(DIST_DIR)/$(PACKAGE).tar.gz
SHA_CMD := $$(command -v sha256sum >/dev/null 2>&1 && echo "sha256sum" || echo "shasum -a 256")

.PHONY: release validate clean

validate:
	@bash -n swctl
	@chmod +x swctl
	@printf "Validated swctl syntax.\n"

release: validate
	@mkdir -p $(DIST_DIR)
	@tmpdir=$$(mktemp -d); \
	  mkdir -p "$$tmpdir/$(PACKAGE)"; \
	  cp swctl .swctl.conf.example docker-compose.swctl.yml README.md "$$tmpdir/$(PACKAGE)/"; \
	  tar -C "$$tmpdir" -czf "$(ARTIFACT)" "$(PACKAGE)"; \
	  rm -rf "$$tmpdir"; \
	  printf "Created %s\n" "$(ARTIFACT)"; \
	  eval $(SHA_CMD) "$(ARTIFACT)"

clean:
	@rm -rf $(DIST_DIR)
	@printf "Removed dist artifacts.\n"
