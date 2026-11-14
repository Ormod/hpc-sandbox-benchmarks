// Avrea tested at the vendor seam: the adapter's translation and the port contract over a fake
// customer VM API, with the SSH data plane standing in as a local shell so guest-command quoting
// runs for real. Kit behaviour is tested once in the driver package.

import { describe, expect, test } from "bun:test";
import type { DriverContext } from "@sandbox-benchmarks/driver";
import { restStub, vendorContract } from "@sandbox-benchmarks/driver/vendor/testing";
import avrea from "./index.ts";
import type { AvreaTransport } from "./vendor.ts";
import { AVREA_STOCK_BASE, avreaPhase, avreaVendor, guestCommand, sizeFor } from "./vendor.ts";

const ORG = "org-0000000000000000000000000000000a";
const ARTIFACT = "cvm-0000000000000000000000000000abcd";
const MARKER = "benchmark-00000000-0000-4000-8000-000000000001";
const op = { signal: new AbortController().signal };
const request = {
	spec: { vcpus: 4, memoryGb: 8 },
	artifact: { kind: "baked", ref: ARTIFACT },
	deadlineMs: 1,
} as const;
const contextFor = (ref: string): DriverContext<"avrea"> => ({
	env: { AVR_TOKEN: "avs_test", AVR_ORG: ORG, AVREA_SSH_KEY: "unused" },
	artifact: { kind: "baked", source: "native-snapshot" },
	resolvedArtifact: { kind: "baked", ref },
});

interface Row {
	readonly id: string;
	readonly display_name: string;
	state: string;
	forkable: boolean;
	readonly source?: string;
	readonly size?: string;
	readonly keys?: readonly string[];
}

const ENDPOINT = { external_ip: "192.0.2.10", external_port: 30001, host_key: "ssh-ed25519 AAAA" };

/** A fake `/orgs/{org}/vms` API. Creates and forks answer PENDING; the next GET reads RUNNING. */
function avreaServer() {
	const vm = (row: Row) => ({
		customer_vm_id: row.id,
		display_name: row.display_name,
		state: row.state,
		cpu_count: 4,
		memory_mb: 15360,
		disk_gb: 150,
		forkable: row.forkable,
		endpoints: { ssh: row.state === "RUNNING" ? ENDPOINT : null },
	});
	const base = `/orgs/${ORG}/vms`;
	const gone = () => Response.json({ detail: "Virtual machine not found" }, { status: 404 });
	const stub = restStub<Row>(
		{
			[`POST ${base}`]: ({ body, add }) => {
				const { display_name, size, ssh_public_keys } = body as {
					display_name: string;
					size: string;
					ssh_public_keys: string[];
				};
				return Response.json(
					{
						data: vm(
							add({
								display_name,
								state: "PENDING",
								forkable: false,
								size,
								keys: ssh_public_keys,
							}),
						),
					},
					{ status: 202 },
				);
			},
			[`POST ${base}/:id/fork`]: ({ row, body, add }) => {
				if (row.state !== "PAUSED" || !row.forkable)
					return Response.json({ detail: "not PAUSED" }, { status: 409 });
				const { display_name } = body as { display_name: string };
				return Response.json(
					{ data: vm(add({ display_name, state: "PENDING", forkable: false, source: row.id })) },
					{ status: 202 },
				);
			},
			[`POST ${base}/:id/pause`]: ({ row }) => {
				row.state = "PAUSING";
				return Response.json({ data: vm(row) }, { status: 202 });
			},
			[`GET ${base}`]: ({ rows, url }) => {
				const all = [...rows.values()].filter((row) => row.state !== "DELETED");
				const offset = Number(url.searchParams.get("cursor") ?? "0");
				const page = all.slice(offset, offset + 2);
				const next = offset + 2 < all.length ? String(offset + 2) : null;
				return { data: page.map(vm), pagination: { next_cursor: next } };
			},
			[`GET ${base}/:id`]: ({ row, rows }) => {
				if (row.state === "DELETING") {
					rows.delete(row.id);
					return gone();
				}
				if (row.state === "PENDING") row.state = "RUNNING";
				else if (row.state === "PAUSING") {
					row.state = "PAUSED";
					row.forkable = true;
				}
				return { data: vm(row) };
			},
			[`DELETE ${base}/:id`]: ({ row }) => {
				row.state = "DELETING";
				return Response.json({ data: { state: "DELETING" } }, { status: 202 });
			},
		},
		{
			newId: (n) => `cvm-${n.toString(16).padStart(32, "0")}`,
			missing: gone,
		},
	);
	stub.rows.set(ARTIFACT, {
		id: ARTIFACT,
		display_name: "sandbox-benchmarks-artifact-1",
		state: "PAUSED",
		forkable: true,
	});
	return stub;
}

/** The SSH data plane as a local shell: the remote string is exactly what sshd would run. */
const localShell: AvreaTransport["ssh"] = async (_endpoint, remote) => {
	const proc = Bun.spawn(["bash", "-c", remote], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
};
const noDelay = () => Promise.resolve();
const vendorOver = (
	server: ReturnType<typeof avreaServer>,
	ref = ARTIFACT,
	ssh: AvreaTransport["ssh"] = localShell,
) =>
	avreaVendor(
		contextFor(ref),
		{ fetch: server.fetch, ssh, publicKey: async () => "ssh-ed25519 AAAAtest bench" },
		noDelay,
	);

vendorContract("avrea adapter", avrea, () => vendorOver(avreaServer()));

test("only fixed sizes with enough memory are offered", () => {
	expect(sizeFor({ vcpus: 4, memoryGb: 8 })).toBe("4-vcpu");
	expect(sizeFor({ vcpus: 4, memoryGb: 15 })).toBe("4-vcpu");
	expect(sizeFor({ vcpus: 4, memoryGb: 16 })).toBeUndefined();
	expect(sizeFor({ vcpus: 3, memoryGb: 4 })).toBeUndefined();
});

test("a running VM is ready only once its SSH endpoint is published", () => {
	expect(avreaPhase({ state: "RUNNING", endpoints: { ssh: null } })).toBe("pending");
	expect(avreaPhase({ state: "RUNNING", endpoints: { ssh: ENDPOINT } })).toBe("ready");
	expect(avreaPhase({ state: "PAUSED" })).toBe("failed");
	expect(avreaPhase({ state: "DELETED" })).toBe("gone");
	expect(() => avreaPhase({ state: "HIBERNATING" })).toThrow("unknown VM state");
});

describe("create", () => {
	test("a benchmark VM forks the artifact under its attempt's name", async () => {
		const server = avreaServer();
		const created = await vendorOver(server).control.create({ request, marker: MARKER }, op);
		const call = server.calls.find((entry) => entry.method === "POST");
		expect(call?.path).toBe(`/orgs/${ORG}/vms/${ARTIFACT}/fork`);
		expect(call?.headers.get("authorization")).toBe("Bearer avs_test");
		expect(server.rows.get(created.id)?.source).toBe(ARTIFACT);
		expect(server.rows.get(created.id)?.display_name).toBe(
			"sandbox-benchmarks-00000000-0000-4000-8000-000000000001",
		);
		expect(created.marker).toBe(MARKER);
	});

	test("a candidate bake boots a fresh Ubuntu VM carrying the benchmark's public key", async () => {
		const server = avreaServer();
		const created = await vendorOver(server, AVREA_STOCK_BASE).control.create(
			{ request, marker: MARKER },
			op,
		);
		const row = server.rows.get(created.id);
		expect(row?.source).toBeUndefined();
		expect(row?.size).toBe("4-vcpu");
		expect(row?.keys).toEqual(["ssh-ed25519 AAAAtest bench"]);
	});

	test("artifact VMs are never claimed by an inventory", async () => {
		const page = await vendorOver(avreaServer()).control.page(undefined, op);
		expect(page.records.find((row) => row.id === ARTIFACT)?.marker).toBeUndefined();
	});
});

describe("exec", () => {
	test("runs as a clean non-login shell and passes the guest's exit status and quoting", async () => {
		const server = avreaServer();
		const vendor = vendorOver(server);
		const created = await vendor.control.create({ request, marker: MARKER }, op);
		await vendor.control.get(created.id, op);
		const native = await vendor.data.attach(created, op);
		const result = await vendor.data.exec(
			native,
			`printf '%s|%s' "$MISE_DATA_DIR" "it's"; echo "$NODE_OPTIONS" >&2; exit 3`,
		);
		expect(result).toEqual({ stdout: "/usr/local/share/mise|it's", stderr: "\n", exitCode: 3 });
	});

	test("an SSH failure is not a guest exit status", async () => {
		const server = avreaServer();
		const vendor = vendorOver(server, ARTIFACT, async () => ({
			stdout: "",
			stderr: "Connection refused",
			transportFailed: true,
		}));
		const created = await vendor.control.create({ request, marker: MARKER }, op);
		await vendor.control.get(created.id, op);
		const native = await vendor.data.attach(created, op);
		await expect(vendor.data.exec(native, "true")).rejects.toThrow("Connection refused");
	});

	test("the guest command resets PATH without startup files", () => {
		expect(guestCommand("true")).toContain("bash --noprofile --norc -c");
		expect(guestCommand("true")).toContain("PATH='/usr/local/share/mise/shims:");
	});
});

test("a snapshot pauses the build VM and keeps a paused fork of it as the artifact", async () => {
	const server = avreaServer();
	const vendor = vendorOver(server, AVREA_STOCK_BASE);
	const created = await vendor.control.create({ request, marker: MARKER }, op);
	const record = await vendor.control.get(created.id, op);
	if (!record) throw new Error("created VM vanished");
	const native = await vendor.data.attach(record, op);
	const snapshots = vendor.snapshots;
	if (!snapshots) throw new Error("Avrea declares no snapshot capability");
	const { snapshotId } = await snapshots.create({ record, native }, op, "durable");
	const artifact = server.rows.get(snapshotId);
	expect(artifact?.source).toBe(created.id);
	expect(artifact?.state).toBe("PAUSED");
	expect(artifact?.display_name.startsWith("sandbox-benchmarks-artifact-")).toBe(true);
	// The builder then destroys the build VM; the artifact must not depend on it.
	await vendor.control.remove(created.id, op);
	expect(server.rows.get(snapshotId)?.state).toBe("PAUSED");
	await snapshots.delete(snapshotId, op);
	expect(server.rows.get(snapshotId)?.state).toBe("DELETING");
	await snapshots.delete("cvm-ffffffffffffffffffffffffffffffff", op);
});
