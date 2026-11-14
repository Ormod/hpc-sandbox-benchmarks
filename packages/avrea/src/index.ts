// The Avrea DriverModule: the kit's driver over Avrea's adapter, bound to `fetch` and OpenSSH here
// and nowhere else, plus the options its native-snapshot artifact builder is derived with.

import type { SnapshotBuildOptions } from "@sandbox-benchmarks/driver/artifact";
import type { VendorHandle } from "@sandbox-benchmarks/driver/vendor";
import { coverage, defineVendorDriver } from "@sandbox-benchmarks/driver/vendor";
import { AVREA_PROVENANCE } from "./provenance.ts";
import type { AvreaNative, AvreaVm } from "./vendor.ts";
import {
	AVREA_NAME,
	AVREA_SIZES,
	AVREA_STOCK_BASE,
	AVREA_VM_ID,
	avreaVendor,
	CONTROL_TIMEOUT_MS,
	openSshTransport,
	sizeFor,
} from "./vendor.ts";

export { AVREA_PROVENANCE, AVREA_STOCK_BASE, AVREA_VM_ID };

/** A fork boots a copied disk; a stock create also provisions the runner image. */
const READY_TIMEOUT_MS = 10 * 60_000;
const DELETE_TIMEOUT_MS = 5 * 60_000;
/** Pause, fork, boot and pause again; each pause archives the whole disk. */
const SNAPSHOT_TIMEOUT_MS = 45 * 60_000;

const avrea = defineVendorDriver("avrea", {
	provenance: AVREA_PROVENANCE,
	sandboxId: AVREA_VM_ID,
	// Sizes are fixed (3840 MiB per vCPU) and a fork takes its source's: `prepare` proves the
	// reported vCPU count and that memory covers the request. Disk is proven after boot.
	coverage: coverage({
		vcpus: "mapped",
		memoryGb: "mapped",
		diskGb: "runtime-verified",
	}),
	unsupported: ({ artifact, spec }) => {
		if (artifact.kind !== "baked") return "Avrea requires a native baked artifact VM";
		if (artifact.ref !== AVREA_STOCK_BASE && !AVREA_VM_ID.allows(artifact.ref))
			return "Avrea requires the artifact's VM id (cvm-...), not a name";
		if (sizeFor(spec) === undefined)
			return `no Avrea VM size covers ${spec.vcpus} vCPU / ${spec.memoryGb} GiB (offered: ${AVREA_SIZES.join(", ")} vCPU at 3840 MiB each)`;
		return undefined;
	},
	diskProof: {},
	// SSH has no server-side cap, but a long-held connection can drop; long steps detach.
	execution: { syncCapMs: 120_000, durable: "shell-detach" },
	createBudget: {
		owner: "harness",
		timeoutMs: CONTROL_TIMEOUT_MS + READY_TIMEOUT_MS + 5 * 60_000 + DELETE_TIMEOUT_MS,
	},
	timing: {
		pollMs: 2_000,
		readyTimeoutMs: READY_TIMEOUT_MS,
		deleteTimeoutMs: DELETE_TIMEOUT_MS,
		controlTimeoutMs: CONTROL_TIMEOUT_MS,
		snapshotTimeoutMs: SNAPSHOT_TIMEOUT_MS,
	},
	markerKey: "display_name",
	markerSpelling: AVREA_NAME,
	// A lost create response may still allocate; an empty listing proves nothing yet.
	recovery: { provesAbsence: false },
	vendor: (context) => avreaVendor(context, openSshTransport(context.env.AVREA_SSH_KEY)),
});

export default avrea;

/** A candidate bake boots a fresh Ubuntu VM; a version build boots the revalidated candidate. */
export const snapshotBuild: SnapshotBuildOptions<"avrea", VendorHandle<AvreaVm, AvreaNative>> = {
	stockBase: () => AVREA_STOCK_BASE,
};
