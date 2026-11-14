// Build an Avrea native snapshot through the builder derived from packages/avrea's driver: a fresh
// Ubuntu VM gets the shared recipe, then a paused fork of it becomes the artifact VM.
import { AVREA_VM_ID } from "@sandbox-benchmarks/avrea";
import { buildProviderArtifact, describeReplacement } from "./build-provider-artifact.ts";
import type { Log } from "./types.ts";

export async function bakeAvreaSnapshot(
	name: string,
	_baseImage: string,
	log: Log,
): Promise<string> {
	// Benchmarks pin the candidate's VM id (AVREA_SNAPSHOT_VM); there is no named version to promote.
	if (!name.endsWith("-candidate"))
		throw new Error(
			"Avrea has no version promotion: pin the candidate's artifact VM id as AVREA_SNAPSHOT_VM",
		);
	const result = await buildProviderArtifact("avrea", {
		phase: "candidate",
		replace: "allowed",
		log,
	});
	if (!AVREA_VM_ID.allows(result.ref))
		throw new Error(`Avrea bake returned ${result.ref}, not an artifact VM id`);
	log(describeReplacement("avrea", name, result));
	log(`avrea artifact VM built: ${result.ref}; pin AVREA_SNAPSHOT_VM=${result.ref}`);
	return result.ref;
}
