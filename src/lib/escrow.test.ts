import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { generateApiSecret, hashApiSecret, type ApiKeyRecord, type ApiKeyRuntime } from "./apiKeys";
import { API_SCOPES } from "./apiScopes";
import { escrowAbi } from "./escrowAbi";
import { addressWord, approveCall, idCall, manualCalldata, openCall, uintWord, voidCall } from "./escrowCall";
import {
  applyEscrowTransition,
  deriveEscrowId,
  deriveEscrowIdManual,
  escrowActionTypedData,
  type EscrowRecord,
  type EscrowTxEvidence,
} from "./escrowTerms";
import {
  cancelEscrow,
  createEscrow,
  fundEscrow,
  asEscrowRecord,
  openEscrow,
  getEscrow,
  listEscrows,
  escrowProof,
  liveEscrowDeps,
  refundEscrow,
  releaseEscrow,
  type EscrowDeps,
} from "./escrowService";
import { upsertRecord, type PayRecord } from "./payStore";

const CREATOR = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const PAYER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const RECIPIENT = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const OTHER = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const CONTRACT = getAddress("0x1111111111111111111111111111111111111111");
const NOW = 1_700_000_000;
const PEPPER = "escrow-test-pepper";
const NONCE = ("0x" + "44".repeat(32)) as Hex;
const FUND_TX = ("0x" + "aa".repeat(32)) as Hex;
const RELEASE_TX = ("0x" + "bb".repeat(32)) as Hex;
const REFUND_TX = ("0x" + "cc".repeat(32)) as Hex;
const CANCEL_TX = ("0x" + "dd".repeat(32)) as Hex;
const OPEN_TX = ("0x" + "ee".repeat(32)) as Hex;

function issue(merchant: Address): { secret: string; row: ApiKeyRecord } {
  const secret = generateApiSecret();
  return {
    secret,
    row: {
      id: `key_${secret.slice(-8)}`,
      merchant,
      name: "escrow",
      prefix: secret.slice(0, 16),
      hash: hashApiSecret(secret, PEPPER),
      scopes: [...API_SCOPES],
      enabled: true,
      revoked: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
    },
  };
}

function runtime(row: ApiKeyRecord, now = NOW): ApiKeyRuntime {
  const keys = [row];
  return {
    nowSeconds: () => now,
    pepper: PEPPER,
    listKeys: async () => keys,
    upsertKey: async () => undefined,
    touchLastUsed: async () => undefined,
  };
}

function bearer(secret: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function log(
  eventName: "EscrowOpened" | "EscrowFunded" | "EscrowReleased" | "EscrowRefunded" | "EscrowCancelled",
  args: Record<string, unknown>,
  dataArgs: readonly { type: string }[],
  dataValues: readonly unknown[],
) {
  return {
    address: CONTRACT,
    topics: encodeEventTopics({ abi: escrowAbi, eventName, args }),
    data: dataArgs.length === 0 ? ("0x" as Hex) : encodeAbiParameters([...dataArgs], [...dataValues]),
  };
}

function evidence(blockTimestamp: number, logs: EscrowTxEvidence["logs"], status: "success" | "reverted" = "success"): EscrowTxEvidence {
  return { status, blockTimestamp, logs };
}

function harness(now = NOW) {
  const rows = new Map<string, EscrowRecord>();
  const events: string[] = [];
  const txs = new Map<string, EscrowTxEvidence>();
  let saves = 0;
  const key = issue(CREATOR.address);
  const deps: EscrowDeps = {
    nowSeconds: () => now,
    chain: {
      contractAddress: CONTRACT,
      loadTx: async (hash) => {
        const found = txs.get(hash.toLowerCase());
        if (!found) return { ok: false, code: "not_found" };
        return { ok: true, evidence: found };
      },
    },
    list: async () => [...rows.values()],
    save: async (row) => {
      saves += 1;
      rows.set(row.escrowId.toLowerCase(), row);
    },
    emit: (type) => {
      events.push(type);
    },
    runtime: runtime(key.row, now),
  };
  return { deps, rows, events, txs, key, saves: () => saves };
}

const createBody = {
  payer: PAYER.address,
  recipient: RECIPIENT.address,
  amountBaseUnits: "1000000",
  expiresAt: NOW + 3600,
  state: "RELEASED",
  fundingTxHash: FUND_TX,
};

function code(body: Record<string, unknown>): string {
  return (body.error as { code: string }).code;
}

test("escrow id changes with expiry and matches manual abi words", () => {
  const base = {
    chainId: 5042,
    token: getAddress("0x3600000000000000000000000000000000000000"),
    payer: PAYER.address,
    recipient: RECIPIENT.address,
    creator: CREATOR.address,
    amountBaseUnits: "1000000",
    expiresAt: NOW + 3600,
  };
  assert.equal(deriveEscrowId(base), deriveEscrowIdManual(base));
  assert.notEqual(deriveEscrowId(base), deriveEscrowId({ ...base, expiresAt: base.expiresAt + 1 }));
});

test("create validates terms, ignores client state, and does not emit payment.paid", async () => {
  const { deps, events, key, rows } = harness();
  const badAmount = await createEscrow(
    bearer(key.secret, "https://example.test/api/v1/escrows", { ...createBody, amountBaseUnits: "1.5" }),
    deps,
  );
  assert.equal(badAmount.status, 400);
  assert.equal(code(badAmount.body), "invalid_amount");
  const badAddress = await createEscrow(
    bearer(key.secret, "https://example.test/api/v1/escrows", { ...createBody, payer: "nope" }),
    deps,
  );
  assert.equal(code(badAddress.body), "invalid_address");
  const badChain = await createEscrow(
    bearer(key.secret, "https://example.test/api/v1/escrows", { ...createBody, chainId: 1 }),
    deps,
  );
  assert.equal(code(badChain.body), "invalid_chain");
  const badToken = await createEscrow(
    bearer(key.secret, "https://example.test/api/v1/escrows", { ...createBody, token: OTHER.address }),
    deps,
  );
  assert.equal(code(badToken.body), "invalid_token");
  const expired = await createEscrow(
    bearer(key.secret, "https://example.test/api/v1/escrows", { ...createBody, expiresAt: NOW - 1 }),
    deps,
  );
  assert.equal(code(expired.body), "invalid_expiry");
  const created = await createEscrow(bearer(key.secret, "https://example.test/api/v1/escrows", createBody), deps);
  assert.equal(created.status, 200);
  const escrow = created.body.escrow as EscrowRecord & { contractDeployed: boolean };
  assert.equal(escrow.state, "CREATED");
  assert.equal(escrow.fundingTxHash, null);
  assert.equal(escrow.contractDeployed, true);
  assert.deepEqual(events, ["escrow.created"]);
  assert.equal(rows.size, 1);
});

test("another merchant cannot read or move the escrow", async () => {
  const box = harness();
  const created = await createEscrow(bearer(box.key.secret, "https://example.test", createBody), box.deps);
  const id = (created.body.escrow as { escrowId: string }).escrowId;
  const other = issue(OTHER.address);
  box.deps.runtime = runtime(other.row);
  const read = await getEscrow(bearer(other.secret, "https://example.test"), id, box.deps);
  assert.equal(read.status, 404);
  const listed = await listEscrows(bearer(other.secret, "https://example.test"), box.deps);
  assert.equal((listed.body.escrows as unknown[]).length, 0);
  const released = await releaseEscrow(bearer(other.secret, "https://example.test", { txHash: RELEASE_TX }), id, box.deps);
  assert.equal(released.status, 404);
  const refunded = await refundEscrow(bearer(other.secret, "https://example.test", { txHash: REFUND_TX }), id, box.deps);
  assert.equal(refunded.status, 404);
});

test("app transition rejects illegal moves and uses block time at expiry", () => {
  assert.equal(applyEscrowTransition({ state: "CREATED", action: "fund", blockTimestamp: 1, expiresAt: 10, logOk: true }).ok, false);
  assert.equal(applyEscrowTransition({ state: "CREATED", action: "open", blockTimestamp: 1, expiresAt: 10, logOk: true }).ok, true);
  assert.equal(applyEscrowTransition({ state: "OPEN", action: "fund", blockTimestamp: 1, expiresAt: 10, logOk: true }).ok, true);
  assert.equal(applyEscrowTransition({ state: "CREATED", action: "release", blockTimestamp: 1, expiresAt: 10, logOk: true }).ok, false);
  assert.equal(applyEscrowTransition({ state: "OPEN", action: "release", blockTimestamp: 1, expiresAt: 10, logOk: true }).ok, false);
  assert.equal(applyEscrowTransition({ state: "FUNDED", action: "cancel", blockTimestamp: 1, expiresAt: 10, logOk: true }).ok, false);
  assert.equal(applyEscrowTransition({ state: "OPEN", action: "cancel", blockTimestamp: 1, expiresAt: 10, logOk: true }).ok, true);
  assert.equal(
    applyEscrowTransition({ state: "CANCELLED", action: "fund", blockTimestamp: 1, expiresAt: 10, logOk: true }).ok,
    false,
  );
  assert.equal(
    applyEscrowTransition({ state: "RELEASED", action: "refund", blockTimestamp: 11, expiresAt: 10, logOk: true }).ok,
    false,
  );
  assert.equal(
    applyEscrowTransition({ state: "REFUNDED", action: "release", blockTimestamp: 1, expiresAt: 10, logOk: true }).ok,
    false,
  );
  const atExpiry = applyEscrowTransition({
    state: "FUNDED",
    action: "release",
    blockTimestamp: 10,
    expiresAt: 10,
    logOk: true,
  });
  assert.equal(atExpiry.ok, false);
  if (!atExpiry.ok) assert.equal(atExpiry.code, "expired");
  const refundAt = applyEscrowTransition({
    state: "FUNDED",
    action: "refund",
    blockTimestamp: 10,
    expiresAt: 10,
    logOk: true,
  });
  assert.equal(refundAt.ok, true);
  const before = applyEscrowTransition({
    state: "FUNDED",
    action: "refund",
    blockTimestamp: 9,
    expiresAt: 10,
    logOk: true,
  });
  assert.equal(before.ok, false);
});


function openedLog(id: string, patch?: { creator?: Address; payer?: Address; recipient?: Address; amount?: bigint; expiresAt?: bigint }) {
  const amount = patch?.amount ?? 1000000n;
  const expiresAt = patch?.expiresAt ?? BigInt(createBody.expiresAt);
  return log(
    "EscrowOpened",
    { escrowId: id, creator: patch?.creator ?? CREATOR.address },
    [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
    [patch?.payer ?? PAYER.address, patch?.recipient ?? RECIPIENT.address, amount, expiresAt],
  );
}

async function markOpen(box: ReturnType<typeof harness>, id: string) {
  box.txs.set(OPEN_TX.toLowerCase(), evidence(NOW + 1, [openedLog(id)]));
  const opened = await openEscrow(bearer(box.key.secret, "https://example.test", { txHash: OPEN_TX }), id, box.deps);
  assert.equal(opened.status, 200);
  assert.equal((opened.body.escrow as { state: string }).state, "OPEN");
  return opened;
}

test("funding requires one matching contract log and a missing contract does not mark funded", async () => {
  const box = harness();
  const created = await createEscrow(bearer(box.key.secret, "https://example.test", createBody), box.deps);
  const id = (created.body.escrow as { escrowId: string }).escrowId;
  const blocked = await fundEscrow(bearer(box.key.secret, "https://example.test", { txHash: FUND_TX }), id, box.deps);
  assert.equal(code(blocked.body), "invalid_state");
  assert.equal((await box.deps.list())[0].state, "CREATED");
  box.deps.chain = { ...box.deps.chain, contractAddress: null };
  const openUnavailable = await openEscrow(bearer(box.key.secret, "https://example.test", {}), id, box.deps);
  assert.equal(openUnavailable.status, 503);
  assert.equal(code(openUnavailable.body), "contract_unavailable");
  assert.equal((await box.deps.list())[0].state, "CREATED");
  box.deps.chain = { ...box.deps.chain, contractAddress: CONTRACT };
  await markOpen(box, id);
  box.deps.chain = { ...box.deps.chain, contractAddress: null };
  const unavailable = await fundEscrow(bearer(box.key.secret, "https://example.test", { txHash: FUND_TX }), id, box.deps);
  assert.equal(unavailable.status, 503);
  assert.equal(code(unavailable.body), "contract_unavailable");
  assert.equal((await box.deps.list())[0].state, "OPEN");
  box.deps.chain = { ...box.deps.chain, contractAddress: CONTRACT };
  const amount = 1000000n;
  box.txs.set(
    FUND_TX.toLowerCase(),
    evidence(NOW + 10, [
      log("EscrowFunded", { escrowId: id, payer: PAYER.address }, [{ type: "uint256" }], [amount]),
      log("EscrowFunded", { escrowId: id, payer: PAYER.address }, [{ type: "uint256" }], [amount]),
    ]),
  );
  const ambiguous = await fundEscrow(bearer(box.key.secret, "https://example.test", { txHash: FUND_TX }), id, box.deps);
  assert.equal(code(ambiguous.body), "ambiguous");
  box.txs.set(
    FUND_TX.toLowerCase(),
    evidence(NOW + 10, [log("EscrowFunded", { escrowId: id, payer: PAYER.address }, [{ type: "uint256" }], [1n])]),
  );
  const wrongAmount = await fundEscrow(bearer(box.key.secret, "https://example.test", { txHash: FUND_TX }), id, box.deps);
  assert.equal(code(wrongAmount.body), "mismatch");
  box.txs.set(
    FUND_TX.toLowerCase(),
    evidence(NOW + 10, [log("EscrowFunded", { escrowId: id, payer: PAYER.address }, [{ type: "uint256" }], [amount])]),
  );
  const funded = await fundEscrow(bearer(box.key.secret, "https://example.test", { txHash: FUND_TX }), id, box.deps);
  assert.equal(funded.status, 200);
  assert.equal((funded.body.escrow as { state: string }).state, "FUNDED");
  assert.equal(box.events.includes("escrow.funded"), true);
  assert.equal(box.events.includes("payment.paid"), false);
  const again = await fundEscrow(bearer(box.key.secret, "https://example.test", { txHash: RELEASE_TX }), id, box.deps);
  assert.equal(code(again.body), "invalid_state");
});

async function sign(
  account: ReturnType<typeof privateKeyToAccount>,
  escrowId: Hex,
  action: "release" | "refund" | "cancel",
  nonce: Hex = NONCE,
) {
  return account.signTypedData(
    escrowActionTypedData({
      escrowId,
      action,
      chainId: 5042,
      nonce,
      deadline: NOW + 500,
      verifyingContract: CONTRACT,
    }),
  );
}

test("release signature does not refund, does not replay, and ignores the client clock", async () => {
  const box = harness();
  const created = await createEscrow(bearer(box.key.secret, "https://example.test", createBody), box.deps);
  const id = (created.body.escrow as { escrowId: string }).escrowId as Hex;
  const amount = 1000000n;
  box.txs.set(
    FUND_TX.toLowerCase(),
    evidence(NOW + 5, [log("EscrowFunded", { escrowId: id, payer: PAYER.address }, [{ type: "uint256" }], [amount])]),
  );
  await markOpen(box, id);
  await fundEscrow(bearer(box.key.secret, "https://example.test", { txHash: FUND_TX }), id, box.deps);
  const releaseSig = await sign(RECIPIENT, id, "release");
  const refundSig = await sign(PAYER, id, "refund", ("0x" + "55".repeat(32)) as Hex);
  box.txs.set(
    RELEASE_TX.toLowerCase(),
    evidence(NOW + 10, [
      log("EscrowReleased", { escrowId: id, recipient: RECIPIENT.address }, [{ type: "uint256" }], [amount]),
    ]),
  );
  const wrongAction = await releaseEscrow(
    bearer(box.key.secret, "https://example.test", {
      txHash: RELEASE_TX,
      signature: refundSig,
      nonce: "0x" + "55".repeat(32),
      deadline: NOW + 500,
    }),
    id,
    box.deps,
  );
  assert.equal(code(wrongAction.body), "wrong_signer");
  const otherId = ("0x" + "99".repeat(32)) as Hex;
  const wrongEscrowSig = await sign(RECIPIENT, otherId, "release");
  const wrongEscrow = await releaseEscrow(
    bearer(box.key.secret, "https://example.test", {
      txHash: RELEASE_TX,
      signature: wrongEscrowSig,
      nonce: NONCE,
      deadline: NOW + 500,
    }),
    id,
    box.deps,
  );
  assert.equal(code(wrongEscrow.body), "wrong_signer");
  box.deps.nowSeconds = () => createBody.expiresAt + 10;
  const released = await releaseEscrow(
    bearer(box.key.secret, "https://example.test", {
      txHash: RELEASE_TX,
      signature: releaseSig,
      nonce: NONCE,
      deadline: NOW + 500,
    }),
    id,
    box.deps,
  );
  assert.equal(code(released.body), "expired_authorization");
  box.deps.nowSeconds = () => NOW;
  const ok = await releaseEscrow(
    bearer(box.key.secret, "https://example.test", {
      txHash: RELEASE_TX,
      signature: releaseSig,
      nonce: NONCE,
      deadline: NOW + 500,
    }),
    id,
    box.deps,
  );
  assert.equal((ok.body.escrow as { state: string }).state, "RELEASED");
  const replay = await releaseEscrow(
    bearer(box.key.secret, "https://example.test", {
      txHash: RELEASE_TX,
      signature: releaseSig,
      nonce: NONCE,
      deadline: NOW + 500,
    }),
    id,
    box.deps,
  );
  assert.equal(code(replay.body), "replayed");
  const refundAfter = await refundEscrow(
    bearer(box.key.secret, "https://example.test", {
      txHash: REFUND_TX,
      signature: refundSig,
      nonce: "0x" + "55".repeat(32),
      deadline: NOW + 500,
    }),
    id,
    box.deps,
  );
  assert.equal(code(refundAfter.body), "invalid_state");
});

test("refund is rejected before expiry and after release is impossible once refunded", async () => {
  const box = harness();
  const created = await createEscrow(bearer(box.key.secret, "https://example.test", createBody), box.deps);
  const id = (created.body.escrow as { escrowId: string }).escrowId as Hex;
  const amount = 1000000n;
  box.txs.set(
    FUND_TX.toLowerCase(),
    evidence(NOW + 1, [log("EscrowFunded", { escrowId: id, payer: PAYER.address }, [{ type: "uint256" }], [amount])]),
  );
  await markOpen(box, id);
  await fundEscrow(bearer(box.key.secret, "https://example.test", { txHash: FUND_TX }), id, box.deps);
  const refundSig = await sign(PAYER, id, "refund");
  box.txs.set(
    REFUND_TX.toLowerCase(),
    evidence(NOW + 10, [log("EscrowRefunded", { escrowId: id, payer: PAYER.address }, [{ type: "uint256" }], [amount])]),
  );
  const early = await refundEscrow(
    bearer(box.key.secret, "https://example.test", {
      txHash: REFUND_TX,
      signature: refundSig,
      nonce: NONCE,
      deadline: NOW + 500,
    }),
    id,
    box.deps,
  );
  assert.equal(code(early.body), "too_early");
  box.txs.set(
    REFUND_TX.toLowerCase(),
    evidence(createBody.expiresAt, [
      log("EscrowRefunded", { escrowId: id, payer: PAYER.address }, [{ type: "uint256" }], [amount]),
    ]),
  );
  const refunded = await refundEscrow(
    bearer(box.key.secret, "https://example.test", {
      txHash: REFUND_TX,
      signature: refundSig,
      nonce: NONCE,
      deadline: NOW + 500,
    }),
    id,
    box.deps,
  );
  assert.equal((refunded.body.escrow as { state: string }).state, "REFUNDED");
  const releaseSig = await sign(RECIPIENT, id, "release", ("0x" + "66".repeat(32)) as Hex);
  const after = await releaseEscrow(
    bearer(box.key.secret, "https://example.test", {
      txHash: RELEASE_TX,
      signature: releaseSig,
      nonce: "0x" + "66".repeat(32),
      deadline: NOW + 500,
    }),
    id,
    box.deps,
  );
  assert.equal(code(after.body), "invalid_state");
});

test("cancel consumes a creator signature and then funding is rejected", async () => {
  const box = harness();
  const created = await createEscrow(bearer(box.key.secret, "https://example.test", createBody), box.deps);
  const id = (created.body.escrow as { escrowId: string }).escrowId as Hex;
  const signature = await sign(CREATOR, id, "cancel");
  box.txs.set(CANCEL_TX.toLowerCase(), evidence(NOW, [log("EscrowCancelled", { escrowId: id }, [], [])]));
  const cancelled = await cancelEscrow(
    bearer(box.key.secret, "https://example.test", {
      txHash: CANCEL_TX,
      signature,
      nonce: NONCE,
      deadline: NOW + 500,
    }),
    id,
    box.deps,
  );
  assert.equal((cancelled.body.escrow as { state: string }).state, "CANCELLED");
  assert.equal(box.events.includes("escrow.cancelled"), true);
  const funded = await fundEscrow(bearer(box.key.secret, "https://example.test", { txHash: FUND_TX }), id, box.deps);
  assert.equal(code(funded.body), "invalid_state");
});

test("proof reads logs and does not change state or emit", async () => {
  const box = harness();
  const created = await createEscrow(bearer(box.key.secret, "https://example.test", createBody), box.deps);
  const id = (created.body.escrow as { escrowId: string }).escrowId;
  const before = box.saves();
  const eventsBefore = box.events.length;
  const proof = await escrowProof(bearer(box.key.secret, "https://example.test"), id, box.deps);
  assert.equal(proof.status, 200);
  assert.equal((proof.body.verification as { fundingValid: null; openValid: null }).fundingValid, null);
  assert.equal((proof.body.verification as { openValid: null }).openValid, null);
  assert.equal(box.saves(), before);
  assert.equal(box.events.length, eventsBefore);
  assert.match(String(proof.body.note), /does not prove a payment request is paid/);
});

test("escrow storage does not drop payment records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "final-escrow-"));
  const previous = process.env.FINAL_PAY_STORE;
  process.env.FINAL_PAY_STORE = join(dir, "store.json");
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    const pay: PayRecord = {
      token: "pay-token",
      id: "id",
      to: CREATOR.address,
      amount: "1",
      memo: "keep",
      createdAt: "2026-01-01T00:00:00.000Z",
      views: 0,
      lastViewedAt: null,
      cancelled: false,
      cancelledAt: null,
      paidTx: null,
      webhookUrl: null,
    };
    await upsertRecord(pay);
    const deps = liveEscrowDeps(runtime(issue(CREATOR.address).row));
    await deps.save({
      escrowId: ("0x" + "12".repeat(32)) as Hex,
      version: 1,
      chainId: 5042,
      token: getAddress("0x3600000000000000000000000000000000000000"),
      payer: PAYER.address,
      recipient: RECIPIENT.address,
      creator: CREATOR.address,
      amountBaseUnits: "1",
      expiresAt: NOW + 10,
      createdAt: "2026-01-01T00:00:00.000Z",
      state: "CREATED",
      openTxHash: null,
      fundingTxHash: null,
      releaseTxHash: null,
      refundTxHash: null,
      cancelTxHash: null,
      usedNonces: [],
    });
    const raw = JSON.parse(await readFile(process.env.FINAL_PAY_STORE, "utf8")) as {
      records: Record<string, { memo: string }>;
      webhooks?: { endpoints: Record<string, { url: string }>; deliveries: Record<string, unknown> };
      apiKeys?: { keys: Record<string, { hash: string }> };
      escrows: { records: Record<string, unknown> };
    };
    assert.equal(raw.records["pay-token"].memo, "keep");
    assert.equal(Object.keys(raw.escrows.records).length, 1);
    raw.webhooks = { endpoints: { hook: { url: "https://example.test/hook" } }, deliveries: {} };
    raw.apiKeys = { keys: { key: { hash: "hashed-secret" } } };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(process.env.FINAL_PAY_STORE, JSON.stringify(raw));
    await deps.save({
      escrowId: ("0x" + "13".repeat(32)) as Hex,
      version: 1,
      chainId: 5042,
      token: getAddress("0x3600000000000000000000000000000000000000"),
      payer: PAYER.address,
      recipient: RECIPIENT.address,
      creator: CREATOR.address,
      amountBaseUnits: "2",
      expiresAt: NOW + 11,
      createdAt: "2026-01-01T00:00:00.000Z",
      state: "CREATED",
      openTxHash: null,
      fundingTxHash: null,
      releaseTxHash: null,
      refundTxHash: null,
      cancelTxHash: null,
      usedNonces: [],
    });
    const kept = JSON.parse(await readFile(process.env.FINAL_PAY_STORE, "utf8")) as {
      records: Record<string, { memo: string }>;
      webhooks: { endpoints: Record<string, { url: string }> };
      apiKeys: { keys: Record<string, { hash: string }> };
      escrows: { records: Record<string, unknown> };
    };
    assert.equal(kept.records["pay-token"].memo, "keep");
    assert.equal(kept.webhooks.endpoints.hook.url, "https://example.test/hook");
    assert.equal(kept.apiKeys.keys.key.hash, "hashed-secret");
    assert.equal(Object.keys(kept.escrows.records).length, 2);
  } finally {
    if (previous === undefined) delete process.env.FINAL_PAY_STORE;
    else process.env.FINAL_PAY_STORE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("escrow modules do not call payment reconciliation", () => {
  const files = [
    "src/lib/escrowService.ts",
    "src/lib/escrowTerms.ts",
    "src/lib/escrowChain.ts",
    "src/lib/escrowAbi.ts",
    "src/lib/escrowCall.ts",
    "src/app/api/v1/escrows/route.ts",
    "src/app/api/v1/escrows/[id]/open/route.ts",
    "src/app/api/v1/escrows/[id]/fund/route.ts",
    "src/app/api/v1/escrows/[id]/cancel/route.ts",
    "src/app/api/v1/escrows/[id]/release/route.ts",
    "src/app/api/v1/escrows/[id]/refund/route.ts",
    "src/app/api/v1/escrows/[id]/proof/route.ts",
    "src/components/escrow/EscrowPanels.tsx",
  ];
  const source = files.map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
  assert.equal(source.includes("reconcilePaymentRecord"), false);
  assert.equal(source.includes("markPaid"), false);
  assert.equal(source.includes("findSettlementProof"), false);
  assert.equal(source.includes("verifyArcTransaction"), false);
});

test("open calldata matches viem and manual abi words and ignores client terms", async () => {
  const box = harness();
  const created = await createEscrow(bearer(box.key.secret, "https://example.test", createBody), box.deps);
  const id = (created.body.escrow as { escrowId: string }).escrowId;
  const saves = box.saves();
  const prepared = await openEscrow(
    bearer(box.key.secret, "https://example.test", {
      amountBaseUnits: "2",
      payer: OTHER.address,
      recipient: OTHER.address,
      expiresAt: NOW + 9,
      escrowId: "0x" + "11".repeat(32),
      chainId: 1,
      contractAddress: OTHER.address,
      state: "FUNDED",
    }),
    id,
    box.deps,
  );
  assert.equal(prepared.status, 400);
  assert.equal((await box.deps.list())[0].state, "CREATED");
  const ok = await openEscrow(bearer(box.key.secret, "https://example.test", {}), id, box.deps);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.prepared, true);
  assert.equal(ok.body.chainId, 5042);
  assert.equal(ok.body.contractAddress, CONTRACT);
  const tx = ok.body.transaction as { to: string; data: Hex; value: string };
  assert.equal(tx.to, CONTRACT);
  assert.equal(tx.value, "0");
  const expected = openCall(CONTRACT, {
    payer: PAYER.address,
    recipient: RECIPIENT.address,
    amountBaseUnits: "1000000",
    expiresAt: createBody.expiresAt,
  });
  assert.equal(tx.data, expected.data);
  const manual = manualCalldata("open(address,address,uint256,uint256)", [
    addressWord(PAYER.address),
    addressWord(RECIPIENT.address),
    uintWord(1000000n),
    uintWord(BigInt(createBody.expiresAt)),
  ]);
  assert.equal(tx.data, manual);
  assert.equal(
    tx.data,
    encodeFunctionData({
      abi: escrowAbi,
      functionName: "open",
      args: [PAYER.address, RECIPIENT.address, 1000000n, BigInt(createBody.expiresAt)],
    }),
  );
  assert.equal(box.saves(), saves);
  assert.equal(box.events.includes("escrow.opened"), false);
  const other = issue(OTHER.address);
  box.deps.runtime = runtime(other.row);
  const hidden = await openEscrow(bearer(other.secret, "https://example.test", {}), id, box.deps);
  assert.equal(hidden.status, 404);
});

test("open verification accepts one EscrowOpened log and rejects mismatches", async () => {
  const box = harness();
  const created = await createEscrow(bearer(box.key.secret, "https://example.test", createBody), box.deps);
  const id = (created.body.escrow as { escrowId: string }).escrowId;
  const post = (hash: string) => openEscrow(bearer(box.key.secret, "https://example.test", { txHash: hash }), id, box.deps);
  const missing = await post(OPEN_TX);
  assert.equal(code(missing.body), "transaction_not_found");
  box.deps.chain.loadTx = async () => ({ ok: false, code: "unavailable" });
  const down = await post(OPEN_TX);
  assert.equal(code(down.body), "verification_unavailable");
  assert.notEqual(code(down.body), "not_found");
  box.deps.chain.loadTx = async (hash) => {
    const found = box.txs.get(hash.toLowerCase());
    if (!found) return { ok: false, code: "not_found" };
    return { ok: true, evidence: found };
  };
  box.txs.set(OPEN_TX.toLowerCase(), evidence(NOW, []));
  assert.equal(code((await post(OPEN_TX)).body), "mismatch");
  box.txs.set(OPEN_TX.toLowerCase(), evidence(NOW, [openedLog(id), openedLog(id)]));
  assert.equal(code((await post(OPEN_TX)).body), "ambiguous");
  box.txs.set(OPEN_TX.toLowerCase(), evidence(NOW, [openedLog(id, { creator: OTHER.address })]));
  assert.equal(code((await post(OPEN_TX)).body), "mismatch");
  box.txs.set(OPEN_TX.toLowerCase(), evidence(NOW, [openedLog(id, { payer: OTHER.address })]));
  assert.equal(code((await post(OPEN_TX)).body), "mismatch");
  box.txs.set(OPEN_TX.toLowerCase(), evidence(NOW, [openedLog(id, { recipient: OTHER.address })]));
  assert.equal(code((await post(OPEN_TX)).body), "mismatch");
  box.txs.set(OPEN_TX.toLowerCase(), evidence(NOW, [openedLog(id, { amount: 1n })]));
  assert.equal(code((await post(OPEN_TX)).body), "mismatch");
  box.txs.set(OPEN_TX.toLowerCase(), evidence(NOW, [openedLog(id, { expiresAt: BigInt(createBody.expiresAt + 1) })]));
  assert.equal(code((await post(OPEN_TX)).body), "mismatch");
  const wrongContract = openedLog(id);
  wrongContract.address = OTHER.address;
  box.txs.set(OPEN_TX.toLowerCase(), evidence(NOW, [wrongContract]));
  assert.equal(code((await post(OPEN_TX)).body), "mismatch");
  box.txs.set(OPEN_TX.toLowerCase(), evidence(NOW, [openedLog(id)], "reverted"));
  assert.equal(code((await post(OPEN_TX)).body), "transaction_failed");
  assert.equal((await box.deps.list())[0].state, "CREATED");
  box.txs.set(("0x" + "ab".repeat(32)).toLowerCase(), evidence(NOW, [openedLog("0x" + "99".repeat(32))]));
  assert.equal(code((await post("0x" + "ab".repeat(32))).body), "mismatch");
  box.txs.set(OPEN_TX.toLowerCase(), evidence(NOW, [openedLog(id)]));
  const opened = await post(OPEN_TX);
  assert.equal((opened.body.escrow as { state: string }).state, "OPEN");
  assert.equal(box.events.includes("escrow.opened"), true);
  assert.equal(box.events.includes("escrow.funded"), false);
});

test("fund prepare is blocked before open and approval is not funding", async () => {
  const box = harness();
  const created = await createEscrow(bearer(box.key.secret, "https://example.test", createBody), box.deps);
  const id = (created.body.escrow as { escrowId: string }).escrowId;
  const early = await fundEscrow(bearer(box.key.secret, "https://example.test", {}), id, box.deps);
  assert.equal(code(early.body), "invalid_state");
  await markOpen(box, id);
  const prepared = await fundEscrow(bearer(box.key.secret, "https://example.test", { prepare: true }), id, box.deps);
  assert.equal(prepared.body.prepared, true);
  const approval = prepared.body.approval as { to: string; data: Hex; value: string; amountBaseUnits: string; note: string };
  const fundTx = prepared.body.transaction as { to: string; data: Hex; value: string };
  assert.equal(approval.to, getAddress("0x3600000000000000000000000000000000000000"));
  assert.equal(approval.amountBaseUnits, "1000000");
  assert.equal(approval.value, "0");
  assert.match(approval.note, /not funding/i);
  assert.equal(approval.data, approveCall(CONTRACT, "1000000").data);
  const manualApprove = manualCalldata("approve(address,uint256)", [addressWord(CONTRACT), uintWord(1000000n)]);
  assert.equal(approval.data, manualApprove);
  const unlimited = manualCalldata("approve(address,uint256)", [addressWord(CONTRACT), uintWord((1n << 256n) - 1n)]);
  assert.notEqual(approval.data, unlimited);
  assert.equal(fundTx.to, CONTRACT);
  assert.equal(fundTx.data, idCall(CONTRACT, "fund", id as Hex).data);
  assert.equal(fundTx.data, manualCalldata("fund(bytes32)", [id as Hex]));
  assert.equal((await box.deps.list())[0].state, "OPEN");
  assert.equal(box.events.includes("escrow.funded"), false);
  const eventsBefore = box.events.length;
  box.txs.set(FUND_TX.toLowerCase(), evidence(NOW, []));
  const failed = await fundEscrow(bearer(box.key.secret, "https://example.test", { txHash: FUND_TX }), id, box.deps);
  assert.equal(code(failed.body), "mismatch");
  assert.equal(box.events.length, eventsBefore);
  box.txs.set(
    FUND_TX.toLowerCase(),
    evidence(NOW, [log("EscrowFunded", { escrowId: id, payer: OTHER.address }, [{ type: "uint256" }], [1000000n])]),
  );
  assert.equal(code((await fundEscrow(bearer(box.key.secret, "https://example.test", { txHash: FUND_TX }), id, box.deps)).body), "mismatch");
});

test("cancel prepare uses void before open and cancel after open, and funded cannot cancel", async () => {
  const box = harness();
  const created = await createEscrow(bearer(box.key.secret, "https://example.test", createBody), box.deps);
  const id = (created.body.escrow as { escrowId: string }).escrowId as Hex;
  const voided = await cancelEscrow(bearer(box.key.secret, "https://example.test", {}), id, box.deps);
  assert.equal(voided.body.action, "void");
  const voidTx = voided.body.transaction as { data: Hex };
  assert.equal(
    voidTx.data,
    voidCall(CONTRACT, {
      payer: PAYER.address,
      recipient: RECIPIENT.address,
      amountBaseUnits: "1000000",
      expiresAt: createBody.expiresAt,
    }).data,
  );
  assert.equal(voidTx.data, manualCalldata("voidEscrow(address,address,uint256,uint256)", [
    addressWord(PAYER.address),
    addressWord(RECIPIENT.address),
    uintWord(1000000n),
    uintWord(BigInt(createBody.expiresAt)),
  ]));
  assert.notEqual(voidTx.data, idCall(CONTRACT, "cancel", id).data);
  assert.equal((await box.deps.list())[0].state, "CREATED");
  await markOpen(box, id);
  const openedCancel = await cancelEscrow(bearer(box.key.secret, "https://example.test", {}), id, box.deps);
  assert.equal(openedCancel.body.action, "cancel");
  assert.equal((openedCancel.body.transaction as { data: Hex }).data, manualCalldata("cancel(bytes32)", [id]));
  const amount = 1000000n;
  box.txs.set(
    FUND_TX.toLowerCase(),
    evidence(NOW + 1, [log("EscrowFunded", { escrowId: id, payer: PAYER.address }, [{ type: "uint256" }], [amount])]),
  );
  await fundEscrow(bearer(box.key.secret, "https://example.test", { txHash: FUND_TX }), id, box.deps);
  const blocked = await cancelEscrow(bearer(box.key.secret, "https://example.test", {}), id, box.deps);
  assert.equal(code(blocked.body), "invalid_state");
  const signature = await sign(CREATOR, id, "cancel");
  box.txs.set(CANCEL_TX.toLowerCase(), evidence(NOW, [log("EscrowCancelled", { escrowId: id }, [], [])]));
  const confirmed = await cancelEscrow(
    bearer(box.key.secret, "https://example.test", { txHash: CANCEL_TX, signature, nonce: NONCE, deadline: NOW + 500 }),
    id,
    box.deps,
  );
  assert.equal(code(confirmed.body), "invalid_state");
  assert.equal((await box.deps.list())[0].state, "FUNDED");
});

test("verified lifecycles and a throwing webhook do not roll state back", async () => {
  const released = harness();
  const created = await createEscrow(bearer(released.key.secret, "https://example.test", createBody), released.deps);
  const id = (created.body.escrow as { escrowId: string }).escrowId as Hex;
  const amount = 1000000n;
  released.deps.emit = () => {
    throw new Error("webhook down");
  };
  released.txs.set(OPEN_TX.toLowerCase(), evidence(NOW + 1, [openedLog(id)]));
  const opened = await openEscrow(bearer(released.key.secret, "https://example.test", { txHash: OPEN_TX }), id, released.deps);
  assert.equal(opened.status, 200);
  assert.equal((await released.deps.list())[0].state, "OPEN");
  released.txs.set(
    FUND_TX.toLowerCase(),
    evidence(NOW + 2, [log("EscrowFunded", { escrowId: id, payer: PAYER.address }, [{ type: "uint256" }], [amount])]),
  );
  const funded = await fundEscrow(bearer(released.key.secret, "https://example.test", { txHash: FUND_TX }), id, released.deps);
  assert.equal((funded.body.escrow as { state: string }).state, "FUNDED");
  released.txs.set(
    RELEASE_TX.toLowerCase(),
    evidence(NOW + 3, [log("EscrowReleased", { escrowId: id, recipient: RECIPIENT.address }, [{ type: "uint256" }], [amount])]),
  );
  const releaseSig = await sign(RECIPIENT, id, "release");
  const done = await releaseEscrow(
    bearer(released.key.secret, "https://example.test", {
      txHash: RELEASE_TX,
      signature: releaseSig,
      nonce: NONCE,
      deadline: NOW + 500,
    }),
    id,
    released.deps,
  );
  assert.equal((done.body.escrow as { state: string }).state, "RELEASED");
  const refundBox = harness();
  const second = await createEscrow(bearer(refundBox.key.secret, "https://example.test", createBody), refundBox.deps);
  const refundId = (second.body.escrow as { escrowId: string }).escrowId as Hex;
  await markOpen(refundBox, refundId);
  refundBox.txs.set(
    FUND_TX.toLowerCase(),
    evidence(NOW + 2, [log("EscrowFunded", { escrowId: refundId, payer: PAYER.address }, [{ type: "uint256" }], [amount])]),
  );
  await fundEscrow(bearer(refundBox.key.secret, "https://example.test", { txHash: FUND_TX }), refundId, refundBox.deps);
  refundBox.txs.set(
    REFUND_TX.toLowerCase(),
    evidence(createBody.expiresAt, [log("EscrowRefunded", { escrowId: refundId, payer: PAYER.address }, [{ type: "uint256" }], [amount])]),
  );
  const refundSig = await sign(PAYER, refundId, "refund");
  const refunded = await refundEscrow(
    bearer(refundBox.key.secret, "https://example.test", {
      txHash: REFUND_TX,
      signature: refundSig,
      nonce: NONCE,
      deadline: NOW + 500,
    }),
    refundId,
    refundBox.deps,
  );
  assert.equal((refunded.body.escrow as { state: string }).state, "REFUNDED");
  const releaseAfter = await releaseEscrow(
    bearer(refundBox.key.secret, "https://example.test", {
      txHash: RELEASE_TX,
      signature: await sign(RECIPIENT, refundId, "release", ("0x" + "77".repeat(32)) as Hex),
      nonce: "0x" + "77".repeat(32),
      deadline: NOW + 500,
    }),
    refundId,
    refundBox.deps,
  );
  assert.equal(code(releaseAfter.body), "invalid_state");
});

test("old escrow rows without openTxHash still load and tampered terms do not", () => {
  const terms = {
    chainId: 5042,
    token: getAddress("0x3600000000000000000000000000000000000000"),
    payer: PAYER.address,
    recipient: RECIPIENT.address,
    creator: CREATOR.address,
    amountBaseUnits: "1000000",
    expiresAt: NOW + 3600,
  };
  const escrowId = deriveEscrowId(terms);
  const legacy = {
    ...terms,
    escrowId,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "CREATED",
    fundingTxHash: null,
    releaseTxHash: null,
    refundTxHash: null,
    cancelTxHash: null,
    usedNonces: [],
  };
  const loaded = asEscrowRecord(legacy);
  assert.equal(loaded?.openTxHash, null);
  assert.equal(loaded?.state, "CREATED");
  const tampered = { ...legacy, openTxHash: null, amountBaseUnits: "2" };
  assert.equal(asEscrowRecord(tampered), null);
});

test("a submitted hash does not cancel and two cancel logs are rejected", async () => {
  const box = harness();
  const created = await createEscrow(bearer(box.key.secret, "https://example.test", createBody), box.deps);
  const id = (created.body.escrow as { escrowId: string }).escrowId as Hex;
  const signature = await sign(CREATOR, id, "cancel");
  const body = { txHash: CANCEL_TX, signature, nonce: NONCE, deadline: NOW + 500 };
  const missing = await cancelEscrow(bearer(box.key.secret, "https://example.test", body), id, box.deps);
  assert.equal(code(missing.body), "transaction_not_found");
  assert.equal((await box.deps.list())[0].state, "CREATED");
  box.txs.set(
    CANCEL_TX.toLowerCase(),
    evidence(NOW, [log("EscrowCancelled", { escrowId: id }, [], []), log("EscrowCancelled", { escrowId: id }, [], [])]),
  );
  const ambiguous = await cancelEscrow(bearer(box.key.secret, "https://example.test", body), id, box.deps);
  assert.equal(code(ambiguous.body), "ambiguous");
  assert.equal(box.events.includes("escrow.cancelled"), false);
  box.txs.set(CANCEL_TX.toLowerCase(), evidence(NOW, [log("EscrowCancelled", { escrowId: id }, [], [])]));
  const cancelled = await cancelEscrow(bearer(box.key.secret, "https://example.test", body), id, box.deps);
  assert.equal((cancelled.body.escrow as { state: string }).state, "CANCELLED");
  const fundAfter = await fundEscrow(bearer(box.key.secret, "https://example.test", { txHash: FUND_TX }), id, box.deps);
  assert.equal(code(fundAfter.body), "invalid_state");
});
