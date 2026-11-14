# Avrea driver

Native [Avrea](https://avrea.com) VM driver over the customer VM REST API (`/orgs/{org}/vms`) and
OpenSSH. Opt-in; not part of the default benchmark matrix.

## Artifact

Avrea VMs boot Avrea's Ubuntu 26.04 runner image; there is no OCI boot. The bake creates a fresh
`4-vcpu` VM, installs the shared toolchain recipe natively (`packages/templates/src/avrea.ts`),
then pauses it, forks it and pauses the fork. The paused fork is the artifact: every benchmark VM
forks it, inheriting its disk, size and SSH keys. The build VM is deleted as the builder requires.

Differences from the Debian 13 OCI image, disclosed in the provider metadata:

- Ubuntu 26.04 with GCC 15, whose C23 default breaks PostgreSQL 17.0; pgbench's build is pinned to
  `-std=gnu17 -O2`.
- Fixed sizes at 3840 MiB per vCPU: the 4 vCPU / 8 GiB target runs on 4 vCPU / 15 GiB, 150 GB disk.

## Configuration

- `AVR_TOKEN` (secret): a token that can create, pause, fork and delete VMs in the organization.
- `AVR_ORG` (variable): the organization id (`org-...`).
- `AVREA_SSH_KEY` (secret): OpenSSH private key. A bake installs its public half; forks inherit it.
- `AVREA_SNAPSHOT_VM` (variable): the paused artifact VM id (`cvm-...`) the bake reported.
- `AVR_HOST` (variable, optional): API host; defaults to `https://api.avrea.com`.

Bake locally, then pin the reported id:

```sh
BAKE_REPORT_FILE=/tmp/avrea-bake.json bun apps/cli/src/bin/bake.ts --provider avrea --require avrea
```

A paused artifact is deleted at its `deletes_at` unless its TTL is extended
(`avr vm update <id> --ttl 7d`).

## Behaviour

- Exec runs as `runner` (passwordless sudo) over SSH with the host key the control plane publishes
  pinned; a VM that publishes none is refused. Commands run in `bash --noprofile --norc` with a
  clean system PATH. An SSH transport failure (exit 255) is an error, never a guest exit status.
- Each benchmark VM is named `sandbox-benchmarks-<attempt uuid>`; artifact VMs are named
  `sandbox-benchmarks-artifact-<ms>` so no inventory claims one as a leftover.
- PAUSED and FAILED VMs keep their disk and are torn down; only DELETED or a 404 proves removal.
