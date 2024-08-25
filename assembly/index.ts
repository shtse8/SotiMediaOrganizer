// Optimized SIMD Hamming Distance Function

// Lookup table for popcount of 8-bit integers
const POPCOUNT_TABLE = new StaticArray<u8>(256);
for (let i: i32 = 0; i < 256; i++) {
  POPCOUNT_TABLE[i] = u8(popcnt(i));
}

// SIMD popcount function
function simdPopcount(v: v128): v128 {
  let popcount = v128.splat<u8>(0);

  // Explicitly handle each lane
  popcount = v128.replace_lane<u8>(
    popcount,
    0,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 0))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    1,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 1))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    2,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 2))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    3,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 3))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    4,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 4))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    5,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 5))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    6,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 6))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    7,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 7))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    8,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 8))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    9,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 9))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    10,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 10))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    11,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 11))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    12,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 12))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    13,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 13))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    14,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 14))],
  );
  popcount = v128.replace_lane<u8>(
    popcount,
    15,
    POPCOUNT_TABLE[u8(v128.extract_lane<u8>(v, 15))],
  );

  return popcount;
}

export function hammingDistanceSIMD(hash1: Uint8Array, hash2: Uint8Array): i32 {
  let distance: i32 = 0;
  const length: i32 = min(hash1.length, hash2.length);

  let i: i32 = 0;
  const simdSize: i32 = 16; // 128-bit vector size

  // Accumulator for SIMD popcount results
  let acc = v128.splat<u8>(0);

  // Process 16 bytes at a time using SIMD
  for (; i <= length - simdSize; i += simdSize) {
    const vec1 = v128.load(hash1.dataStart + i);
    const vec2 = v128.load(hash2.dataStart + i);
    const xor = v128.xor(vec1, vec2);

    // Perform SIMD popcount and accumulate
    acc = v128.add<u8>(acc, simdPopcount(xor));
  }

  // Sum up the accumulated popcount
  distance += u32(v128.extract_lane<u8>(acc, 0));
  distance += u32(v128.extract_lane<u8>(acc, 1));
  distance += u32(v128.extract_lane<u8>(acc, 2));
  distance += u32(v128.extract_lane<u8>(acc, 3));
  distance += u32(v128.extract_lane<u8>(acc, 4));
  distance += u32(v128.extract_lane<u8>(acc, 5));
  distance += u32(v128.extract_lane<u8>(acc, 6));
  distance += u32(v128.extract_lane<u8>(acc, 7));
  distance += u32(v128.extract_lane<u8>(acc, 8));
  distance += u32(v128.extract_lane<u8>(acc, 9));
  distance += u32(v128.extract_lane<u8>(acc, 10));
  distance += u32(v128.extract_lane<u8>(acc, 11));
  distance += u32(v128.extract_lane<u8>(acc, 12));
  distance += u32(v128.extract_lane<u8>(acc, 13));
  distance += u32(v128.extract_lane<u8>(acc, 14));
  distance += u32(v128.extract_lane<u8>(acc, 15));

  // Process remaining bytes
  for (; i < length; i++) {
    distance += POPCOUNT_TABLE[hash1[i] ^ hash2[i]];
  }

  return distance;
}
