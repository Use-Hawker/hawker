# HAWKER

APIs sold by the call to AI agents. Paid in USDG on Robinhood Chain, straight to the seller.

An agent asks a stall for a price, signs a USDG payment for exactly one call, and gets the answer back with a receipt. The seller has the USDG in their wallet before the answer leaves. HAWKER never holds anyone's money: there is no deposit, no balance and no payout to request. The agent needs no ETH.

- Site: https://usehawker.fun
- HawkerTill: [`0x8281E355A7ff3d7f311e54C338B324131a0Ea45E`](https://robinhoodchain.blockscout.com/address/0x8281E355A7ff3d7f311e54C338B324131a0Ea45E) on Robinhood Chain (4663), [Sourcify exact match](https://repo.sourcify.dev/4663/0x8281E355A7ff3d7f311e54C338B324131a0Ea45E)
- USDG: [`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`](https://robinhoodchain.blockscout.com/token/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168)

## One call

```
POST /v1/call/rh-wallet            → 402 { till, seller, value: "20000", ref }
sign USDG ReceiveWithAuthorization  (to = till, nonce = keccak256(abi.encode(seller, ref)))
POST /v1/call/rh-wallet + X-Payment → HAWKER runs the call, then HawkerTill.settle()
                                    → 200 { result, receipt: { tx, paidUsd, sellerGotUsd, feeUsd } }
```

A call that fails is never charged: the payment lands only after the stall answered, and the signature stays valid for a retry.

## Who can do what

| | can | cannot |
|---|---|---|
| Agent | sign payments for exact prices to named sellers, inside its own limits | pay more than it signed, or have one signature pay twice |
| Gateway | choose not to serve a call, land a payment it was given | change the amount, seller or buyer of a payment, hold USDG |
| Till owner | set the fee up to 5%, the fee wallet, the token that waives the fee | move a payment, pause or upgrade the till |
| Seller | answer calls and be paid for every 2xx | be paid without answering |

The seller is folded into the signed nonce, so nobody can point a payment at another wallet. `ReceiveWithAuthorization` only lets the till submit it, so the signature is useless anywhere else.

USDG answers an authorization whose nonce was already used with success and moves nothing. The till counts what actually arrived and reverts with `NotPaid`, and the gateway trusts only the `Paid` event, never a successful transaction alone.

## Layout

| | |
|---|---|
| `contracts/HawkerTill.sol` | the till: `settle`, `settleMany`, fee capped at 5%, holds nothing between transactions |
| `contracts/test.mjs` | 40 checks on a Hardhat fork with the real USDG |
| `contracts/deploy.html`, `deploy-server.mjs`, `verify.mjs` | one-button deploy from a browser wallet, then Sourcify |
| `core/hawker.mjs` | signing, the payment header, the settle struct, the listing message |
| `worker/` | the gateway (Cloudflare Worker + D1): catalog, 402 quotes, settlement, house stalls, seller stalls, ledger |
| `agent/` | the agent kit: CLI and stdio MCP server with per-call and per-day limits |
| `site/` | usehawker.fun: home, stalls, for agents, sell, ledger, docs |
| `test/e2e.mjs` | 54 checks: the gateway in process against the fork, real payments, a seller's API with HMAC |
| `test/agent.mjs` | 27 checks: the kit's SDK, CLI and MCP paying real USDG on the fork |
| `test/dev-fork.mjs` | the whole thing on localhost:8867 with seeded stalls and calls |

## The agent kit

```bash
git clone https://github.com/Hawker-Agents/hawker hawker
cd hawker && npm install --omit=dev
cd agent && npm link        # puts `hawker` on your PATH
hawker init                 # makes ~/.hawker/key, prints the address to fund with USDG
hawker stalls
hawker call coin-price '{"ids":"ethereum"}'
```

As an MCP server:

```json
{ "mcpServers": { "hawker": { "command": "hawker", "args": ["mcp"], "env": { "HAWKER_MAX_PER_CALL": "0.10", "HAWKER_MAX_PER_DAY": "2" } } } }
```

| Variable | Default | |
|---|---|---|
| `HAWKER_KEY` | `~/.hawker/key` | the agent's key, or a file holding it |
| `HAWKER_MAX_PER_CALL` | `1` | USDG |
| `HAWKER_MAX_PER_DAY` | `5` | USDG per UTC day, kept in `~/.hawker/spend.json` |
| `HAWKER_TILL` | none | refuse quotes naming any other contract |
| `HAWKER_API` | `https://usehawker.fun` | |

## Selling

List an https endpoint with a price per call at https://usehawker.fun/sell/ or with `hawker list`. The listing is a `personal_sign` message from the payout wallet. Each paid call reaches your URL with `X-Hawker-Signature: sha256=HMAC(secret, timestamp + "." + body)`, `X-Hawker-Timestamp`, `X-Hawker-Buyer` and `X-Hawker-Call`.

## Run the tests

```bash
npm install
cd contracts && node compile.mjs
npx hardhat node --config hardhat.config.cjs --port 8548   # a fork of Robinhood Chain
node test.mjs
cd .. && node test/e2e.mjs && node test/agent.mjs
```

The public RPC keeps only recent state, so a fork older than about fifteen minutes fails with "historical state is not available": restart it.

## Deploy the gateway

```bash
cd worker
npx wrangler d1 create hawker            # paste the id into wrangler.toml
npx wrangler d1 execute hawker --remote --file schema.sql
npx wrangler secret put GAS_KEY          # the settler: needs only ETH for gas
npx wrangler secret put RH_RPC_URL       # a keyed Robinhood Chain RPC
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
```

Set `TILL` and `HOUSE_PAY_TO` in `wrangler.toml`.

## License

MIT
