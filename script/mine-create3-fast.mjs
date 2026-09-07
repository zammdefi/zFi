#!/usr/bin/env node
// The same CREATE3 vanity search as mine-create3.mjs, in native keccak over
// preallocated buffers.
//
// WHY. `create3-derive.mjs` derives an address with three ethers keccak calls,
// each of which parses a hex STRING and allocates a fresh one for the result.
// That costs ~53k attempts/sec across eight workers, and four leading zero
// bytes is 16^8 attempts expected - about a day. The arithmetic is identical
// here; only the plumbing changes: the `keccak` native addon, three fixed
// buffers mutated in place, and no hex anywhere in the loop.
//
// It is checked against `create3Address` on startup and refuses to run if the
// two disagree, because a miner that is fast and wrong finds an address nobody
// can deploy to.
//
//   node script/mine-create3-fast.mjs <deployer> <zeroBytes> [workers] [label]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { cpus } from 'node:os'
import { createRequire } from 'node:module'
import { create3Address } from './create3-derive.mjs'

const require = createRequire(import.meta.url)
const createKeccak = require('keccak')
const kec = (buf) => createKeccak('keccak256').update(buf).digest()

const CREATEX = Buffer.from('ba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed', 'hex')
const PROXY_HASH = kec(Buffer.from('67363d3d37363d34f03d5260086018f3', 'hex'))

/** One search state: three buffers, reused for every attempt. */
function makeDeriver(deployerBuf) {
  const gIn = Buffer.alloc(64)           // 32-byte padded deployer || 32-byte salt
  deployerBuf.copy(gIn, 12)
  deployerBuf.copy(gIn, 32)              // salt bytes 0..19 are the deployer
  // gIn[52] is salt byte 20, the guard byte: 0x00 keeps block.chainid out of
  // the derivation, which is the whole reason one address exists on every chain.
  const pIn = Buffer.alloc(85)           // 0xff || CreateX || guarded || proxyHash
  pIn[0] = 0xff
  CREATEX.copy(pIn, 1)
  PROXY_HASH.copy(pIn, 53)
  const aIn = Buffer.alloc(23)           // 0xd6 0x94 || proxy || 0x01
  aIn[0] = 0xd6; aIn[1] = 0x94; aIn[22] = 0x01
  return {
    salt: gIn.subarray(32),              // a view: writing here writes the input
    derive() {
      kec(gIn).copy(pIn, 21)
      kec(pIn).copy(aIn, 2, 12)
      return kec(aIn)                    // address is the last 20 bytes
    },
  }
}

if (isMainThread) {
  const [deployerArg, zerosArg, workersArg, labelArg] = process.argv.slice(2)
  if (!deployerArg) { console.error('usage: <deployer> <zeroBytes> [workers] [label]'); process.exit(1) }
  const deployer = deployerArg.toLowerCase().replace(/^0x/, '')
  if (deployer.length !== 40) throw Error('deployer must be 20 bytes')
  const zeros = Number(zerosArg || 3)
  const workers = Number(workersArg) || Math.max(1, cpus().length)

  // Agreement check against the reference derivation, on a salt of the shape
  // this miner produces. A fast miner that disagrees finds nothing usable.
  {
    const d = makeDeriver(Buffer.from(deployer, 'hex'))
    d.salt[20] = 0
    Buffer.from('0102030405060708090a0b', 'hex').copy(d.salt, 21)
    const mine = d.derive().subarray(12).toString('hex')
    const ref = create3Address(deployer, d.salt.toString('hex')).address
    if (mine !== ref) throw Error(`derivation disagrees: ${mine} vs ${ref}`)
    console.log(`derivation agrees with create3-derive.mjs (${ref})`)
  }

  console.log(`mining ${zeros} zero bytes for 0x${deployer} on ${workers} workers`)
  console.log(`~${Math.pow(256, zeros).toLocaleString()} attempts expected`)
  let total = 0, done = false
  const t0 = Date.now()
  for (let i = 0; i < workers; i++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { deployer, zeros, seed: i, label: labelArg || '' } })
    w.on('message', (m) => {
      if (m.tried) {
        total += m.tried
        if (!done) {
          const s = (Date.now() - t0) / 1000
          process.stdout.write(`\r  ${(total / 1e6).toFixed(1)}M tried  ${(total / s / 1e3).toFixed(0)}k/s  ${s.toFixed(0)}s`)
        }
        return
      }
      if (done) return
      done = true
      const ref = create3Address(deployer, m.salt)
      console.log(`\n\nFOUND after ~${total.toLocaleString()} attempts in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
      console.log(`  salt        0x${m.salt}`)
      console.log(`  guardedSalt 0x${ref.guarded}`)
      console.log(`  address     0x${ref.address}`)
      if (ref.address !== m.address) console.log('  MISMATCH against create3-derive.mjs — do not use')
      process.exit(0)
    })
  }
} else {
  const { deployer, zeros, seed, label } = workerData
  const d = makeDeriver(Buffer.from(deployer, 'hex'))
  d.salt[20] = 0
  d.salt[21] = seed
  let base = 0
  for (const ch of label) base = (base * 131 + ch.charCodeAt(0)) & 0xffff
  d.salt.writeUInt16BE(base, 22)
  let counter = 0n, tried = 0
  for (;;) {
    d.salt.writeBigUInt64BE(++counter, 24)
    const a = d.derive()
    let ok = true
    for (let i = 12; i < 12 + zeros; i++) if (a[i] !== 0) { ok = false; break }
    if (ok) {
      parentPort.postMessage({ salt: d.salt.toString('hex'), address: a.subarray(12).toString('hex') })
      break
    }
    if (++tried % 50000 === 0) parentPort.postMessage({ tried: 50000 })
  }
}
