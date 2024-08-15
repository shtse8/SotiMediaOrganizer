import { performance } from 'perf_hooks';

// Utility functions
function generateRandomBinaryString(length: number): string {
  return Array.from({ length }, () => Math.random() > 0.5 ? '1' : '0').join('');
}

function binaryStringToBuffer(binaryString: string): Buffer {
  const buffer = Buffer.alloc(binaryString.length / 8);
  for (let i = 0; i < binaryString.length; i += 8) {
    buffer[i / 8] = parseInt(binaryString.slice(i, i + 8), 2);
  }
  return buffer;
}

function hammingDistanceString(hash1: string, hash2: string): number {
  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) distance++;
  }
  return distance;
}

function hammingDistanceBuffer(hash1: Buffer, hash2: Buffer): number {
  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    const xor = hash1[i] ^ hash2[i];
    distance += popcount(xor);
  }
  return distance;
}

function popcount(x: number): number {
  x -= (x >> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  x += x >> 8;
  x += x >> 16;
  return x & 0x7f;
}

// Benchmark function
function runBenchmark(name: string, fn: () => void, iterations: number = 1000000): void {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${((end - start) / iterations).toFixed(6)} ms per operation`);
}

// Benchmark suite
function runBenchmarks(hashLength: number): void {
  console.log(`\nRunning benchmarks for hash length: ${hashLength}`);

  const stringHash1 = generateRandomBinaryString(hashLength);
  const stringHash2 = generateRandomBinaryString(hashLength);
  const bufferHash1 = binaryStringToBuffer(stringHash1);
  const bufferHash2 = binaryStringToBuffer(stringHash2);

  // Creation benchmarks
  runBenchmark('String hash creation', () => generateRandomBinaryString(hashLength), 10000);
  runBenchmark('Buffer hash creation', () => binaryStringToBuffer(generateRandomBinaryString(hashLength)), 10000);

  // Comparison benchmarks
  runBenchmark('String hash comparison', () => hammingDistanceString(stringHash1, stringHash2));
  runBenchmark('Buffer hash comparison', () => hammingDistanceBuffer(bufferHash1, bufferHash2));

  // Storage benchmarks (simulated with Map operations)
  const stringMap = new Map<string, number>();
  const bufferMap = new Map<Buffer, number>();

  runBenchmark('String hash Map set', () => stringMap.set(generateRandomBinaryString(hashLength), 1), 100000);
  runBenchmark('Buffer hash Map set', () => bufferMap.set(binaryStringToBuffer(generateRandomBinaryString(hashLength)), 1), 100000);

  runBenchmark('String hash Map get', () => stringMap.get(stringHash1), 1000000);
  runBenchmark('Buffer hash Map get', () => bufferMap.get(bufferHash1), 1000000);
}

// Run benchmarks for different hash lengths
[64, 256, 1024, 4096, 20480].forEach(runBenchmarks);