.PHONY: bootstrap-check bootstrap-strict bootstrap-lock bootstrap-update-baseline

# Detect platform: prefer PowerShell on Windows, fall back to bash
ifeq ($(OS),Windows_NT)
  SHELL := powershell
  RUNNER := powershell -ExecutionPolicy Bypass -File scripts/bootstrap-check.ps1
else
  RUNNER := bash scripts/bootstrap-check.sh
endif

bootstrap-check:
	$(RUNNER)

bootstrap-strict:
	$(RUNNER) --strict

bootstrap-lock:
	$(RUNNER) --strict --lock

bootstrap-update-baseline:
	$(RUNNER) --strict --update-baseline
