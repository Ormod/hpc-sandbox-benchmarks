// Avrea's vendor adapter: translation only, over the customer VM REST API
// (`/orgs/{org}/vms`) and plain OpenSSH for the data plane. Readiness, cleanup confirmation,
// recovery, inventory and the disk proof live in the driver kit.
//
// Avrea VMs boot Avrea's own Ubuntu runner image; there is no OCI boot. The benchmark artifact is a
// PAUSED VM holding the native toolchain install, and every benchmark VM is a fork of it. A fork
// copies the source's size, SSH keys and disk, so the bake's public key reaches every fork.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateRequest, DriverContext, ExecOptions } from "@sandbox-benchmarks/driver";
import { shellQuote } from "@sandbox-benchmarks/driver";
import type {
	ExecOutcome,
	Phase,
	Vendor,
	VendorPage,
	VendorRecord,
} from "@sandbox-benchmarks/driver/vendor";
import {
	abortableDelay,
	bounded,
	httpClassifiers,
	httpStatus,
	LEAK_EXPIRY_MS,
	markerSpelling,
} from "@sandbox-benchmarks/driver/vendor";
import { type } from "arktype";

export const AVREA_DEFAULT_HOST = "https://api.avrea.com";
/** The stock base a candidate bake boots: a fresh Ubuntu VM, not a fork. */
export const AVREA_STOCK_BASE = "avrea/ubuntu-26.04";
const STOCK_OS_VERSION = "ubuntu-26.04";
export const AVREA_VM_ID = type(/^cvm-[0-9a-f]{32}$/);
export const AVREA_GUEST_USER = "runner";
/** Every benchmark VM is named by its attempt; ownership keys on the name. */
export const AVREA_NAME = markerSpelling("sandbox-benchmarks-");
/** Artifact VMs carry a different prefix, so no inventory ever claims one as a leftover. */
const ARTIFACT_NAME_PREFIX = "sandbox-benchmarks-artifact-";
export const CONTROL_TIMEOUT_MS = 30_000;
/** Fixed sizes: `<n>-vcpu` with 3840 MiB per vCPU (avr vm capabilities, 2026-11-14). */
export const AVREA_SIZES = [1, 2, 4, 8, 16, 32] as const;
const MEMORY_MB_PER_VCPU = 3840;
/** The longest a paused artifact may wait for its next fork; Avrea's maximum TTL. */
const ARTIFACT_TTL_SECONDS = 7 * 24 * 60 * 60;
const EPHEMERAL_SNAPSHOT_TTL_SECONDS = 15 * 60;
const SSH_READY_TIMEOUT_MS = 5 * 60_000;
const STATE_POLL_MS = 3_000;
// Match the shared image's system PATH, without the runner image's login environment.
const GUEST_PATH =
	"/usr/local/share/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export function sizeFor(spec: Pick<CreateRequest["spec"], "vcpus" | "memoryGb">) {
	const vcpus = AVREA_SIZES.find((size) => size === spec.vcpus);
	if (vcpus === undefined || vcpus * MEMORY_MB_PER_VCPU < spec.memoryGb * 1024) return undefined;
	return `${vcpus}-vcpu`;
}

const sshEndpoint = type({
	external_ip: "string >= 1",
	external_port: "number.integer > 0",
	"host_key?": "string | null",
}).onUndeclaredKey("ignore");
const vm = type({
	customer_vm_id: AVREA_VM_ID,
	display_name: "string",
	state: "string",
	"state_reason?": "string | null",
	cpu_count: "number.integer > 0",
	memory_mb: "number.integer > 0",
	disk_gb: "number.integer > 0",
	"forkable?": "boolean",
	"endpoints?": type({ "ssh?": sshEndpoint.or("null") })
		.onUndeclaredKey("ignore")
		.or("null"),
}).onUndeclaredKey("ignore");
export type AvreaVm = typeof vm.infer;
type SshEndpoint = typeof sshEndpoint.infer;
const one = type({ data: vm }).onUndeclaredKey("ignore");
const many = type({
	data: vm.array(),
	"pagination?": type({ "next_cursor?": "string | null" }).onUndeclaredKey("ignore").or("null"),
}).onUndeclaredKey("ignore");
const errorBody = type({ "detail?": "unknown" }).onUndeclaredKey("ignore");

/** A non-2xx answer from the Avrea API. */
export class AvreaApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(`Avrea API ${status}: ${message}`);
		this.name = "AvreaApiError";
	}
}
const status = httpStatus(AvreaApiError, (error) => error.status);
const classifiers = httpClassifiers(status);
/** A request that reached no HTTP status (a dropped connection or its own bound) is asked again. */
const transient = (error: unknown) =>
	status(error) === undefined
		? error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError")
		: classifiers.transient(error);

/**
 * PAUSED and FAILED VMs keep their disk until deleted; STOPPING and PAUSING are on the way there.
 * Only a 404 (a DELETED VM leaves the API) or DELETED proves removal. RUNNING is ready once the
 * control plane publishes the SSH endpoint the data plane needs.
 */
export function avreaPhase(row: Pick<AvreaVm, "state" | "endpoints">): Phase {
	switch (row.state) {
		case "PENDING":
		case "STARTING":
			return "pending";
		case "RUNNING":
			return row.endpoints?.ssh ? "ready" : "pending";
		case "PAUSING":
		case "PAUSED":
		case "STOPPING":
		case "FAILED":
			return "failed";
		case "DELETING":
			return "deleting";
		case "DELETED":
			return "gone";
		default:
			throw new Error(`Avrea returned an unknown VM state ${row.state}`);
	}
}

function record(row: AvreaVm): VendorRecord<AvreaVm> {
	const marker = AVREA_NAME.fromVendor(row.display_name);
	const owned = marker !== undefined && !row.display_name.startsWith(ARTIFACT_NAME_PREFIX);
	return {
		id: row.customer_vm_id,
		phase: avreaPhase(row),
		...(owned && { marker }),
		...((row.state === "PAUSED" || row.state === "PAUSING") && { stopped: true }),
		...(row.state_reason && { detail: row.state_reason }),
		raw: row,
	};
}

/** The connected data plane of one VM; the endpoint is resolved once the VM runs. */
export interface AvreaNative {
	readonly id: string;
	endpoint?: SshEndpoint;
}

/** One private key file per process, written from the environment with owner-only access. */
let keyDir: string | undefined;
function keyFile(privateKey: string): string {
	keyDir ??= mkdtempSync(join(tmpdir(), "sandbox-benchmarks-avrea-"));
	const path = join(keyDir, "id");
	writeFileSync(path, privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

/** Pin the host key the control plane publishes; a VM without one is refused, never trusted. */
function knownHosts(endpoint: SshEndpoint): string {
	if (!endpoint.host_key) throw new Error("Avrea published no SSH host key for the VM");
	keyDir ??= mkdtempSync(join(tmpdir(), "sandbox-benchmarks-avrea-"));
	const path = join(keyDir, `known_hosts-${endpoint.external_ip}-${endpoint.external_port}`);
	writeFileSync(
		path,
		`[${endpoint.external_ip}]:${endpoint.external_port} ${endpoint.host_key.trim()}\n`,
		{ mode: 0o600 },
	);
	return path;
}

/** The guest command, run without the runner image's shell startup files and with a clean PATH. */
export function guestCommand(command: string): string {
	const script = `export MISE_DATA_DIR=/usr/local/share/mise MISE_CONFIG_DIR=/etc/mise; ${command}`;
	return `env -u BASH_ENV -u ENV -u NODE_PATH -u NODE_OPTIONS PATH=${shellQuote(GUEST_PATH)} bash --noprofile --norc -c ${shellQuote(script)}`;
}

export interface AvreaTransport {
	readonly fetch: typeof globalThis.fetch;
	/** Runs one guest command over SSH; production spawns OpenSSH. */
	readonly ssh: (
		endpoint: SshEndpoint,
		remote: string,
		signal?: AbortSignal,
	) => Promise<ExecOutcome & { readonly transportFailed?: boolean }>;
	/** The OpenSSH public key of the configured private key, for a stock create. */
	readonly publicKey: () => Promise<string>;
}

export function openSshTransport(privateKey: string): AvreaTransport {
	const identity = () => keyFile(privateKey);
	return {
		fetch: globalThis.fetch,
		ssh: async (endpoint, remote, signal) => {
			const proc = Bun.spawn(
				[
					"ssh",
					"-i",
					identity(),
					"-p",
					String(endpoint.external_port),
					"-o",
					"BatchMode=yes",
					"-o",
					"IdentitiesOnly=yes",
					"-o",
					`UserKnownHostsFile=${knownHosts(endpoint)}`,
					"-o",
					"StrictHostKeyChecking=yes",
					"-o",
					"ConnectTimeout=20",
					"-o",
					"ServerAliveInterval=15",
					"-o",
					"ServerAliveCountMax=4",
					"-o",
					"LogLevel=ERROR",
					`${AVREA_GUEST_USER}@${endpoint.external_ip}`,
					remote,
				],
				{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
			);
			const kill = () => proc.kill();
			signal?.addEventListener("abort", kill, { once: true });
			try {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				signal?.throwIfAborted();
				// OpenSSH exits 255 for its own failures; the guest's status is then unknown.
				return exitCode === 255
					? { stdout, stderr, transportFailed: true }
					: { stdout, stderr, exitCode };
			} finally {
				signal?.removeEventListener("abort", kill);
			}
		},
		publicKey: async () => {
			const proc = Bun.spawn(["ssh-keygen", "-y", "-f", identity()], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			if (code !== 0) throw new Error("AVREA_SSH_KEY is not a readable OpenSSH private key");
			return out.trim();
		},
	};
}

export function avreaVendor(
	{ env, resolvedArtifact }: Pick<DriverContext<"avrea">, "env" | "resolvedArtifact">,
	transport: AvreaTransport,
	delay: (ms: number, signal?: AbortSignal) => Promise<void> = abortableDelay,
): Vendor<AvreaVm, AvreaNative> {
	const host = (env.AVR_HOST ?? AVREA_DEFAULT_HOST).replace(/\/+$/, "");
	const base = `${host}/orgs/${encodeURIComponent(env.AVR_ORG)}/vms`;
	const request = (
		method: string,
		path: string,
		signal: AbortSignal | undefined,
		body?: unknown,
	): Promise<unknown> =>
		bounded(signal, CONTROL_TIMEOUT_MS, async (within) => {
			const response = await transport.fetch(`${base}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${env.AVR_TOKEN}`,
					Accept: "application/json",
					...(body !== undefined && { "Content-Type": "application/json" }),
				},
				...(body !== undefined && { body: JSON.stringify(body) }),
				signal: within,
			});
			const text = await response.text();
			let parsed: unknown;
			try {
				parsed = text ? JSON.parse(text) : undefined;
			} catch {
				parsed = undefined;
			}
			if (response.ok) return parsed;
			const error = errorBody(parsed);
			const detail = error instanceof type.errors ? undefined : error.detail;
			throw new AvreaApiError(
				response.status,
				typeof detail === "string"
					? detail
					: detail === undefined
						? text.slice(0, 200) || response.statusText
						: JSON.stringify(detail).slice(0, 200),
			);
		});
	const read = async (id: string, signal?: AbortSignal) =>
		one.assert(await request("GET", `/${id}`, signal)).data;
	const listPage = async (
		cursor: string | undefined,
		signal: AbortSignal,
	): Promise<VendorPage<AvreaVm>> => {
		const query = new URLSearchParams({ limit: "100" });
		if (cursor !== undefined) query.set("cursor", cursor);
		const page = many.assert(await request("GET", `?${query}`, signal));
		const next = page.pagination?.next_cursor;
		return { records: page.data.map(record), ...(next ? { next } : {}) };
	};
	/** Wait for `id` to satisfy `done`, failing on a state that can never get there. */
	const awaitState = async (
		id: string,
		label: string,
		done: (row: AvreaVm) => boolean,
		signal: AbortSignal,
	) => {
		for (;;) {
			const row = await read(id, signal);
			if (done(row)) return row;
			if (row.state === "FAILED" || row.state === "DELETING" || row.state === "DELETED")
				throw new Error(
					`Avrea VM ${id} reached ${row.state} while waiting to be ${label}${row.state_reason ? `: ${row.state_reason}` : ""}`,
				);
			await delay(STATE_POLL_MS, signal);
		}
	};
	const paused = (row: AvreaVm) => row.state === "PAUSED" && row.forkable === true;
	const pause = async (id: string, signal: AbortSignal) => {
		await request("POST", `/${id}/pause`, signal, {});
		return awaitState(id, "paused and forkable", paused, signal);
	};
	const endpointOf = async (native: AvreaNative, signal?: AbortSignal) => {
		if (native.endpoint) return native.endpoint;
		const ssh = (await read(native.id, signal)).endpoints?.ssh;
		if (!ssh) throw new Error(`Avrea VM ${native.id} has no SSH endpoint`);
		native.endpoint = ssh;
		return ssh;
	};
	const exec = async (
		native: AvreaNative,
		command: string,
		options?: ExecOptions,
	): Promise<ExecOutcome> => {
		const result = await transport.ssh(
			await endpointOf(native, options?.signal),
			guestCommand(command),
			options?.signal,
		);
		if (result.transportFailed)
			throw new Error(`SSH to Avrea VM ${native.id} failed: ${result.stderr.trim().slice(0, 300)}`);
		const { transportFailed: _, ...outcome } = result;
		return outcome;
	};

	return {
		control: {
			// The 202 carries PENDING: readiness is observed by GET.
			create: async ({ request: { spec }, marker }, { signal }) => {
				const display_name = AVREA_NAME.toVendor(marker);
				const ttl_seconds = Math.ceil(LEAK_EXPIRY_MS / 1000);
				const body =
					resolvedArtifact.ref === AVREA_STOCK_BASE
						? {
								display_name,
								os_type: "linux",
								os_version: STOCK_OS_VERSION,
								architecture: "x86_64",
								size: sizeFor(spec),
								ssh_public_keys: [await transport.publicKey()],
								ttl_seconds,
							}
						: { display_name, ttl_seconds };
				const path =
					resolvedArtifact.ref === AVREA_STOCK_BASE ? "" : `/${resolvedArtifact.ref}/fork`;
				const created = one.assert(await request("POST", path, signal, body)).data;
				return { ...record(created), phase: "pending" };
			},
			get: async (id, { signal }) => record(await read(id, signal)),
			// 202 is an acknowledgement; the kit reads on until DELETED or a 404.
			remove: async (id, { signal }) => {
				await request("DELETE", `/${id}`, signal);
				return "accepted";
			},
			page: (cursor, { signal }) => listPage(cursor, signal),
			// Names are unique among live VMs, and every create is named by its marker.
			find: async (marker, cursor, { signal }) => {
				const page = await listPage(cursor, signal);
				const name = AVREA_NAME.toVendor(marker);
				return { ...page, records: page.records.filter((row) => row.raw.display_name === name) };
			},
			...classifiers,
			transient,
		},
		data: {
			attach: ({ id }) => ({ id }),
			// The size is fixed by the fork source (or the stock create); prove it, then prove SSH.
			prepare: async ({ record: { raw }, native }, { spec }, { signal }) => {
				if (raw.cpu_count !== spec.vcpus || raw.memory_mb < spec.memoryGb * 1024)
					return {
						status: "unsupported",
						detail: `requested ${spec.vcpus} vCPU / ${spec.memoryGb} GiB but the VM reports ${raw.cpu_count} vCPU / ${raw.memory_mb} MiB`,
					};
				if (raw.endpoints?.ssh) native.endpoint = raw.endpoints.ssh;
				const deadline = Date.now() + SSH_READY_TIMEOUT_MS;
				for (;;) {
					try {
						const ready = await exec(native, "true", { signal });
						if (ready.exitCode === 0) break;
						throw new Error(`guest readiness command exited ${ready.exitCode}`);
					} catch (error) {
						// sshd can lag the RUNNING state by a few seconds after boot.
						if (signal.aborted || Date.now() > deadline) throw error;
						await delay(STATE_POLL_MS, signal);
					}
				}
				return { status: "honored" };
			},
			exec,
		},
		snapshots: {
			// Avrea's snapshot is a PAUSED VM, and the builder destroys its build VM after capture.
			// So pause the build VM, fork it, and pause the fork: the paused fork is the artifact and
			// outlives the build VM. Every benchmark VM is a fork of it.
			create: async ({ record: { id } }, { signal }, retention) => {
				await pause(id, signal);
				const ttl_seconds =
					retention === "durable" ? ARTIFACT_TTL_SECONDS : EPHEMERAL_SNAPSHOT_TTL_SECONDS;
				const fork = one.assert(
					await request("POST", `/${id}/fork`, signal, {
						display_name: `${ARTIFACT_NAME_PREFIX}${Date.now()}`,
						ttl_seconds,
					}),
				).data;
				try {
					await awaitState(
						fork.customer_vm_id,
						"running",
						(row) => row.state === "RUNNING",
						signal,
					);
					await pause(fork.customer_vm_id, signal);
				} catch (error) {
					await request("DELETE", `/${fork.customer_vm_id}`, undefined).catch(() => {});
					throw error;
				}
				return { snapshotId: fork.customer_vm_id };
			},
			delete: async (snapshotId, { signal }) => {
				try {
					await request("DELETE", `/${snapshotId}`, signal);
				} catch (error) {
					if (!classifiers.absent(error)) throw error;
				}
			},
		},
	};
}
