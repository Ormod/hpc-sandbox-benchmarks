import { defineProviderMeta } from "../provider-meta.ts";

export default defineProviderMeta("avrea", {
	displayName: "Avrea",
	vendor: "Avrea",
	website: "https://avrea.com",
	// No client library: the adapter targets the customer VM REST API and OpenSSH.
	sdkPackage: "Avrea VM API",
	// A native install in Avrea's Ubuntu image, captured as a PAUSED VM that every sandbox forks.
	artifact: { kind: "baked", source: "native-snapshot" },
	inputs: [
		{
			name: "AVR_TOKEN",
			description:
				"Scoped token (avs_...): avr token create --allow-vm-create --vm-create-limit <n> --vm <artifact VM id>",
		},
		{ name: "AVR_ORG", source: { kind: "variable" } },
		{
			name: "AVREA_SSH_KEY",
			description:
				"OpenSSH private key; the bake installs its public half and every fork inherits it.",
		},
		{
			name: "AVR_HOST",
			source: { kind: "variable" },
			required: false,
			description: "Optional API host; empty uses https://api.avrea.com.",
		},
		{
			name: "AVREA_SNAPSHOT_VM",
			source: { kind: "variable" },
			required: false,
			description:
				"Required for benchmark execution: the paused artifact VM id (cvm-...) from the native bake. Not needed to bake.",
		},
	],
	runtimeIdentity: "unprivileged",
	isolation: {
		class: "microVM",
		technology: "Cloud Hypervisor microVM (KVM)",
		notes:
			"Full Linux microVMs (Ubuntu 26.04, Avrea kernel) forked from a paused native snapshot holding the shared pinned toolchain, run as the passwordless-sudo runner user with a clean system PATH. This is an Ubuntu VM, while OCI-based providers use Debian 13; GCC 15's C23 default needs pgbench's PostgreSQL built with -std=gnu17.",
	},
	pricing: {
		model: "unavailable",
		reason: "unpublished",
		notes: "No per-VM CPU or memory rate is cited here yet.",
	},
	maturity: {
		status: "beta",
		notes: "Opt-in. Validated from a private fork; not part of the default benchmark matrix.",
	},
	// Fixed sizes at 3840 MiB per vCPU: the 4 vCPU / 8 GiB target runs on 4 vCPU / 15 GiB.
	specPinning: "fixed",
	transport: { streaming: false, syncCapMs: 120_000, detachedPoll: true },
});
