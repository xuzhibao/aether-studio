#!/usr/bin/env node
// Real serial round-trip runner for the ESP32-C3 firmware-validation example.
//
// QEMU mode (default) boots the exact merged flash image and drives UART0 through
// QEMU's stdio serial backend. Serial mode drives a physical port through the
// `serialport` dependency that the desktop host already uses. Both modes feed the
// shared pure matcher, which alone decides pass/fail: a mismatch, timeout or
// disconnect is never reported as a pass.
//
// QEMU on Windows cannot open paths that contain non-ASCII characters (its ROM
// data dir lookup is ANSI), so the image is copied into the OS temp directory and
// `--qemu` must point at an ASCII-path installation.
//
// Exit code 0 only when every boot passed and (with --boots >= 2) the identity
// reported by each boot was identical.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FwValSession, type FwValRecord, type FwValTransport } from "../../../shared/firmwareValidation";

interface Options {
  image: string | null;
  firmware: string | null;
  qemu: string | null;
  port: string | null;
  transport: FwValTransport;
  boots: number;
  expectFw: string | null;
  jsonOut: string | null;
}

interface RunResult {
  record: FwValRecord;
  argv?: string[];
}

interface QemuResult {
  runs: RunResult[];
  identityStable: boolean | null;
}

const usage = `Usage:
  node --import tsx examples/esp32c3-firmware-validation/tools/validate.ts --image <flash-qemu.bin> [options]
  node --import tsx examples/esp32c3-firmware-validation/tools/validate.ts --port COM5 --transport usb-serial-jtag

Options:
  --image <path>       Merged 4 MB QEMU flash image (QEMU mode).
  --firmware <path>    App-only firmware.bin, only recorded by SHA-256.
  --qemu <path>        qemu-system-riscv32 binary (ASCII path). Defaults to $QEMU_EXE.
  --port <path>        Physical serial port (hardware mode).
  --transport <name>   qemu-uart0 | uart0 | usb-serial-jtag (default: qemu-uart0 or usb-serial-jtag).
  --boots <n>          Number of identical boots; with n >= 2 the identity must match (default 2).
  --expect-fw <fwid>   Pin the firmware identity reported in READY.
  --json-out <path>    Also write the result document to this path.
  --help               Show this help.`;

function parseArgs(argv: string[]): Options | null {
  const options: Options = {
    image: null,
    firmware: null,
    qemu: null,
    port: null,
    transport: "qemu-uart0",
    boots: 2,
    expectFw: null,
    jsonOut: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case "--image": options.image = value(); break;
      case "--firmware": options.firmware = value(); break;
      case "--qemu": options.qemu = value(); break;
      case "--port": options.port = value(); break;
      case "--transport": options.transport = value() as FwValTransport; break;
      case "--boots": options.boots = Number(value()); break;
      case "--expect-fw": options.expectFw = value(); break;
      case "--json-out": options.jsonOut = value(); break;
      case "--help":
      case "-h":
        console.log(usage);
        return null;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.port !== null) {
    if (options.transport === "qemu-uart0") options.transport = "usb-serial-jtag";
  } else if (options.image === null) {
    throw new Error("QEMU mode needs --image; hardware mode needs --port");
  }
  if (!["qemu-uart0", "uart0", "usb-serial-jtag"].includes(options.transport)) {
    throw new Error(`unknown transport: ${options.transport}`);
  }
  if (!Number.isInteger(options.boots) || options.boots < 1) {
    throw new Error("--boots must be a positive integer");
  }
  return options;
}

async function sha256(file: string): Promise<string> {
  const data = await readFile(file);
  return createHash("sha256").update(data).digest("hex");
}

/** Drives one session: issues the fresh challenge after READY, enforces deadlines. */
function drive(session: FwValSession, write: (text: string) => void, kill: () => void, hardTimeoutMs: number): Promise<FwValRecord> {
  return new Promise((resolve) => {
    let challengeIssued = false;
    const started = Date.now();
    const timer = setInterval(() => {
      if (session.currentPhase === "ready" && !challengeIssued) {
        const token = randomBytes(8).toString("hex");
        try {
          session.issueChallenge(token);
          challengeIssued = true;
          write(`CHALLENGE token=${token}\n`);
        } catch {
          // Phase changed underneath us; the state machine stays authoritative.
        }
      }
      session.tick();
      if (session.currentPhase === "passed" || session.currentPhase === "failed") {
        clearInterval(timer);
        kill();
        resolve(session.finish());
      } else if (Date.now() - started > hardTimeoutMs) {
        session.disconnect("host hard deadline reached");
        clearInterval(timer);
        kill();
        resolve(session.finish());
      }
    }, 20);
  });
}

function qemuArgv(image: string): string[] {
  return [
    "-M", "esp32c3",
    "-nographic",
    "-monitor", "none",
    "-serial", "stdio",
    "-icount", "3",
    "-drive", `file=${image},format=raw,if=mtd`,
    "-global", "driver=timer.esp32c3.timg,property=wdt_disable,value=true",
  ];
}

async function runQemuSession(options: Options, qemu: string, image: string): Promise<RunResult> {
  const argv = qemuArgv(image);
  const child: ChildProcess = spawn(qemu, argv, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const session = new FwValSession({
    runId: `qemu-${randomBytes(4).toString("hex")}`,
    transport: "qemu-uart0",
    expectedFwid: options.expectFw ?? undefined,
  });
  const result = drive(
    session,
    (text) => child.stdin?.write(text),
    () => { child.kill(); },
    60_000,
  );
  child.stdout?.on("data", (chunk: Buffer) => session.feed(new Uint8Array(chunk)));
  child.on("error", (error) => session.disconnect(`qemu failed to start: ${error.message}`));
  child.on("close", (code) => session.disconnect(`qemu exited with code ${code}`));
  const record = await result;
  return { record, argv };
}

async function runSerialSession(options: Options, portPath: string): Promise<RunResult> {
  const { SerialPort } = await import("serialport");
  const port = new SerialPort({ path: portPath, baudRate: 115200, autoOpen: false });
  const session = new FwValSession({
    runId: `serial-${randomBytes(4).toString("hex")}`,
    transport: options.transport === "uart0" ? "uart0" : "usb-serial-jtag",
    expectedFwid: options.expectFw ?? undefined,
  });
  await new Promise<void>((resolve, reject) => {
    port.open((error) => (error ? reject(error) : resolve()));
  });
  const result = drive(
    session,
    (text) => port.write(text),
    () => { port.close(() => undefined); },
    60_000,
  );
  port.on("data", (chunk: Buffer) => session.feed(new Uint8Array(chunk)));
  port.on("error", (error: Error) => session.disconnect(`serial error: ${error.message}`));
  port.on("close", () => session.disconnect("serial port closed"));
  const record = await result;
  return { record };
}

function sameIdentity(a: FwValRecord, b: FwValRecord): boolean {
  return JSON.stringify(a.device) === JSON.stringify(b.device);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) return 0;

  const document: Record<string, unknown> = {
    tool: "aether-fwval-validate",
    startedAt: new Date().toISOString(),
  };

  let runs: RunResult[];
  let identityStable: boolean | null = null;

  if (options.port !== null) {
    if (options.image !== null) {
      console.error("note: --image is ignored in hardware mode");
    }
    runs = [];
    for (let i = 0; i < options.boots; i++) {
      if (options.boots > 1) {
        console.error(`hardware runs must be triggered one boot at a time; use --boots 1 with a manual reset`);
        break;
      }
      runs.push(await runSerialSession(options, options.port));
    }
  } else {
    const qemu = options.qemu ?? process.env.QEMU_EXE ?? "qemu-system-riscv32";
    if (/[^\x20-\x7e]/.test(qemu)) {
      console.error("error: the QEMU path contains non-ASCII characters; use an ASCII-path copy");
      return 2;
    }
    // QEMU must be able to open the image by path, and its own install path must be ASCII.
    const workdir = await mkdtemp(path.join(tmpdir(), "aether-fwval-"));
    const staged = path.join(workdir, "flash.bin");
    await copyFile(options.image as string, staged);
    runs = [];
    for (let i = 0; i < options.boots; i++) {
      runs.push(await runQemuSession(options, qemu, staged));
    }
    if (runs.length >= 2) {
      identityStable = runs.every((run) => sameIdentity(run.record, runs[0].record));
    }
  }

  const allPassed = runs.length > 0 && runs.every((run) => run.record.verdict === "pass");
  const verdict = allPassed && (identityStable === null || identityStable) ? "pass" : "fail";

  document.firmware = options.firmware === null ? null : { path: options.firmware, sha256: await sha256(options.firmware) };
  document.image = options.image === null ? null : { path: options.image, sha256: await sha256(options.image) };
  document.runs = runs.map((run) => run.record);
  document.identityStable = identityStable;
  document.verdict = verdict;
  document.finishedAt = new Date().toISOString();

  const text = JSON.stringify(document, null, 2);
  console.log(text);
  if (options.jsonOut !== null) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(options.jsonOut, text + "\n", "utf8");
  }

  for (const run of runs) {
    const { record } = run;
    console.error(
      `[${record.evidence}/${record.transport}] ${record.verdict}` +
        (record.failure === null ? "" : ` (${record.failure.code}: ${record.failure.detail})`),
    );
  }
  return verdict === "pass" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
