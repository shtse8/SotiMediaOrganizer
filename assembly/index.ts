export function hammingDistanceSIMD(
  hash1: StaticArray<u8>,
  hash2: StaticArray<u8>,
): i32 {
  let distance: i32 = 0;
  const length: i32 = min(hash1.length, hash2.length);
  let i: i32 = 0;

  // Process 16 bytes at a time using SIMD
  while (i + 16 <= length) {
    let a = v128.load(changetype<usize>(hash1) + i);
    let b = v128.load(changetype<usize>(hash2) + i);
    let xor = v128.xor(a, b);
    let popcnt = v128.popcnt<u8>(xor);
    distance +=
      i8x16.extract_lane_u(popcnt, 0) +
      i8x16.extract_lane_u(popcnt, 1) +
      i8x16.extract_lane_u(popcnt, 2) +
      i8x16.extract_lane_u(popcnt, 3) +
      i8x16.extract_lane_u(popcnt, 4) +
      i8x16.extract_lane_u(popcnt, 5) +
      i8x16.extract_lane_u(popcnt, 6) +
      i8x16.extract_lane_u(popcnt, 7) +
      i8x16.extract_lane_u(popcnt, 8) +
      i8x16.extract_lane_u(popcnt, 9) +
      i8x16.extract_lane_u(popcnt, 10) +
      i8x16.extract_lane_u(popcnt, 11) +
      i8x16.extract_lane_u(popcnt, 12) +
      i8x16.extract_lane_u(popcnt, 13) +
      i8x16.extract_lane_u(popcnt, 14) +
      i8x16.extract_lane_u(popcnt, 15);
    i += 16;
  }

  // Process remaining bytes
  while (i < length) {
    distance += popcnt(hash1[i] ^ hash2[i]);
    i++;
  }

  return distance;
}

// Helper function to count set bits (1s) in a byte
function popcnt(byte: u8): i32 {
  let count: i32 = 0;
  while (byte != 0) {
    count += i32(byte & 1);
    byte >>= 1;
  }
  return count;
}
