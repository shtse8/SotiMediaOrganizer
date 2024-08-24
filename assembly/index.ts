function popcount64(x: u64): i32 {
  x = x - ((x >> 1) & 0x5555555555555555);
  x = (x & 0x3333333333333333) + ((x >> 2) & 0x3333333333333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f0f0f0f0f;
  return i32((x * 0x0101010101010101) >> 56);
}

export function hammingDistanceSIMD(hash1: Uint8Array, hash2: Uint8Array): i32 {
  let distance: i32 = 0;
  const length: i32 = min<i32>(hash1.length, hash2.length);
  const simdSize: i32 = 16; // Each SIMD vector can hold 16 bytes (128 bits)

  let i: i32 = 0;

  // Process 16 bytes at a time using SIMD
  for (; i <= length - simdSize; i += simdSize) {
    // Load 16 bytes from each array into SIMD vectors
    const vec1: v128 = v128.load(hash1.dataStart + i);
    const vec2: v128 = v128.load(hash2.dataStart + i);

    // Compute the bitwise XOR of the two vectors
    const xor: v128 = v128.xor(vec1, vec2);

    // Process the XOR result using 64-bit chunks and popcount64
    distance += popcount64(v128.extract_lane<u64>(xor, 0));
    distance += popcount64(v128.extract_lane<u64>(xor, 1));
  }

  // Process remaining bytes
  const remainingBytes = length - i;

  if (remainingBytes >= 8) {
    // Process 8 bytes as a 64-bit integer
    const remainingVec1: u64 = load<u64>(hash1.dataStart + i);
    const remainingVec2: u64 = load<u64>(hash2.dataStart + i);
    distance += popcount64(remainingVec1 ^ remainingVec2);
    i += 8;
  }

  // Process any remaining individual bytes
  for (; i < length; i++) {
    distance += popcount64(hash1[i] ^ hash2[i]);
  }

  return distance;
}
