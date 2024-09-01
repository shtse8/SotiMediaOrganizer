export class PerceptualHashWorker {
  private readonly HASH_SIZE = 8;
  private scale: number;
  private dctCoefficients: Float32Array;
  private normFactors: Float32Array;

  constructor(private resolution: number) {
    this.initializeConstants();
  }

  private initializeConstants(): void {
    const size = this.resolution;
    this.scale = Math.sqrt(2 / size);

    // Pre-compute DCT coefficients
    this.dctCoefficients = new Float32Array(size * this.HASH_SIZE);
    for (let u = 0; u < this.HASH_SIZE; u++) {
      for (let x = 0; x < size; x++) {
        this.dctCoefficients[u * size + x] = Math.cos(
          ((2 * x + 1) * u * Math.PI) / (2 * size),
        );
      }
    }

    // Pre-compute normalization factors
    this.normFactors = new Float32Array(this.HASH_SIZE);
    for (let i = 0; i < this.HASH_SIZE; i++) {
      this.normFactors[i] = i === 0 ? this.scale / Math.SQRT2 : this.scale;
    }
  }

  computePerceptualHash(imageBuffer: Uint8Array): Uint8Array {
    const size = this.resolution;
    const hashSize = this.HASH_SIZE;

    const dct = this.fastDCT(imageBuffer, size);

    // Compute median of AC components for thresholding
    const medianAC = this.computeMedianAC(dct);

    // Compute hash
    const hash = new Uint8Array(hashSize);
    for (let i = 0; i < hashSize; i++) {
      for (let j = 0; j < 8; j++) {
        if (dct[i * hashSize + j] > medianAC) {
          hash[i] |= 1 << j;
        }
      }
    }

    return hash;
  }

  private fastDCT(input: Uint8Array, size: number): Float32Array {
    const output = new Float32Array(this.HASH_SIZE * this.HASH_SIZE);
    const temp = new Float32Array(this.HASH_SIZE);

    for (let y = 0; y < size; y++) {
      for (let u = 0; u < this.HASH_SIZE; u++) {
        let sum = 0;
        const coeffOffset = u * size;
        for (let x = 0; x < size; x++) {
          sum += input[y * size + x] * this.dctCoefficients[coeffOffset + x];
        }
        temp[u] = sum;
      }

      for (let v = 0; v < this.HASH_SIZE; v++) {
        const normFactor = this.normFactors[v];
        const vCoeff = this.dctCoefficients[v * size + y];
        const outputOffset = v * this.HASH_SIZE;
        for (let u = 0; u < this.HASH_SIZE; u++) {
          output[outputOffset + u] += normFactor * temp[u] * vCoeff;
        }
      }
    }

    return output;
  }

  private computeMedianAC(dct: Float32Array): number {
    const acValues = new Float32Array(dct.length - 1);
    for (let i = 1; i < dct.length; i++) {
      acValues[i - 1] = Math.abs(dct[i]);
    }
    return this.quickSelect(acValues, Math.floor(acValues.length / 2));
  }

  private quickSelect(arr: Float32Array, k: number): number {
    if (arr.length === 1) return arr[0];

    const pivotIndex = Math.floor(arr.length / 2);
    const pivot = arr[pivotIndex];

    const left = [];
    const right = [];

    for (let i = 0; i < arr.length; i++) {
      if (i === pivotIndex) continue;
      if (arr[i] < pivot) {
        left.push(arr[i]);
      } else {
        right.push(arr[i]);
      }
    }

    if (k < left.length) {
      return this.quickSelect(new Float32Array(left), k);
    } else if (k > arr.length - right.length) {
      return this.quickSelect(
        new Float32Array(right),
        k - (arr.length - right.length),
      );
    } else {
      return pivot;
    }
  }
}
