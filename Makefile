.PHONY: bootstrap-check bootstrap-strict bootstrap-lock bootstrap-update-baseline bootstrap-selfhost test-stage2

# Detect platform: prefer PowerShell on Windows, fall back to bash
ifeq ($(OS),Windows_NT)
  SHELL := powershell
  RUNNER := powershell -ExecutionPolicy Bypass -File scripts/bootstrap-check.ps1
  STAGE2 := powershell -ExecutionPolicy Bypass -File scripts/test-stage2.ps1
else
  RUNNER := bash scripts/bootstrap-check.sh
  STAGE2 := bash scripts/test-stage2.sh
endif

bootstrap-check:
	$(RUNNER)

bootstrap-strict:
	$(RUNNER) --strict

bootstrap-lock:
	$(RUNNER) --strict --lock

bootstrap-update-baseline:
	$(RUNNER) --strict --update-baseline

bootstrap-selfhost:
	bash scripts/bootstrap-selfhost.sh

bootstrap-native:
	bash scripts/bootstrap-native.sh

test-stage2:
	$(STAGE2)
