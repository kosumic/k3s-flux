import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
const exec = promisify(execFile);
const path = '/models/abliterated-huihui/UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf';
const { stdout: data } = await exec('kubectl', ['-n', 'llama-qwen38', 'exec', 'deploy/llama-qwen38-flash-next', '-c', 'llama-server', '--', 'head', '-c', '16777216', path], {
  encoding: 'buffer', maxBuffer: 20 * 1024 * 1024,
});
let offset = 0;
function u32() { const n = data.readUInt32LE(offset); offset += 4; return n; }
function u64() { const n = Number(data.readBigUInt64LE(offset)); offset += 8; return n; }
function text() { const n = u64(); const out = data.subarray(offset, offset + n).toString(); offset += n; return out; }
function value(type, keep = false) {
  if (type === 8) return text();
  if (type === 9) {
    const itemType = u32(), count = u64(), out = [];
    for (let i = 0; i < count; i++) { const item = value(itemType, keep); if (keep) out.push(item); }
    return keep ? out : { array_type: itemType, count };
  }
  const [bytes, method] = ({ 0: [1, 'readUInt8'], 1: [1, 'readInt8'], 2: [2, 'readUInt16LE'],
    3: [2, 'readInt16LE'], 4: [4, 'readUInt32LE'], 5: [4, 'readInt32LE'], 6: [4, 'readFloatLE'],
    7: [1, 'readUInt8'], 10: [8, 'readBigUInt64LE'], 11: [8, 'readBigInt64LE'], 12: [8, 'readDoubleLE'] })[type];
  const out = data[method](offset); offset += bytes;
  return typeof out === 'bigint' ? out.toString() : out;
}
if (data.subarray(0, 4).toString() !== 'GGUF') throw new Error('Not GGUF');
offset = 4;
const version = u32(), tensors = u64(), entries = u64(), metadata = {};
for (let i = 0; i < entries; i++) {
  const key = text(), type = u32();
  const out = value(type, key.startsWith('qwen4exp.'));
  if (key.startsWith('qwen4exp.') || ['general.architecture', 'tokenizer.ggml.add_bos_token', 'tokenizer.ggml.add_eos_token'].includes(key)) metadata[key] = out;
}
const inventory = [];
for (let i = 0; i < tensors; i++) {
  const name = text(), rank = u32(), dimensions = Array.from({ length: rank }, u64), type = u32(), position = u64();
  inventory.push({ name, dimensions, type, offset: position });
}
const report = { version, tensors, entries, metadata, first_shard_inventory: inventory };
await writeFile('model-metadata.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ architecture: metadata['general.architecture'], layers: metadata['qwen4exp.block_count'], context: metadata['qwen4exp.context_length'], metadata_bytes: offset, tensors }));
