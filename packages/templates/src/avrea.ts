import { nativeUbuntuSetupScript } from "./freestyle.ts";
import { validatedPins } from "./pins.ts";

/**
 * GCC 15 (Ubuntu 26.04) defaults to C23, where `bool` is a keyword, and PostgreSQL 17.0 predates
 * that: pgbench's build fails in src/common. Pin that one profile's configure to the C17 dialect
 * at the optimization level configure picks on its own, the way the fio profile is patched.
 */
export function avreaPgbenchPatch(pgbench: string): string {
	const install = `/var/lib/phoronix-test-suite/test-profiles/pts/${pgbench}/install.sh`;
	return [
		`sed -i 's|^\\./configure --prefix|CFLAGS="-O2 -std=gnu17" ./configure --prefix|' '${install}'`,
		`grep -q -- '-std=gnu17' '${install}'`,
	].join("\n");
}

/** The native install for Avrea's Ubuntu 26.04 runner image; benchmarks run as `runner`. */
export function avreaSetupScript(): string {
	const pgbench = validatedPins()
		.ptsInstallTests.split(/\s+/)
		.find((test) => test.startsWith("pgbench-"));
	if (pgbench === undefined) throw new Error("No pgbench profile is pinned");
	return nativeUbuntuSetupScript({
		runtimeUser: "runner",
		beforePtsInstall: avreaPgbenchPatch(pgbench),
	});
}

if (import.meta.main) process.stdout.write(avreaSetupScript());
