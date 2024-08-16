export class LSH {
  private bands: Map<string, Set<string>>[]; // Using string as key because Map<Buffer, ...> can have unexpected behavior
  private bandSize: number;
  private numBands: number;

  constructor(
    hashLength: number,
    similarityThreshold: number,
    speedImportance: number = 0.5,
  ) {
    if (hashLength <= 0) {
      throw new Error("Hash size must be a positive integer");
    }

    [this.numBands, this.bandSize] = this.calculateBandsAndRows(
      hashLength,
      similarityThreshold,
      speedImportance,
    );
    // console.log(`Using ${this.numBands} bands with ${this.bandSize} rows each\n\n`);
    this.bands = Array.from(
      { length: this.numBands },
      () => new Map<string, Set<string>>(),
    );
  }

  private calculateBandsAndRows(
    hashLength: number,
    similarityThreshold: number,
    speedImportance: number,
  ): [number, number] {
    let bestBands = 1;
    let bestRows = hashLength;
    let bestScore = -Infinity;

    // console.log(`Calculating bands and rows for hash length: ${hashLength}, similarity: ${similarityThreshold}, speed importance: ${speedImportance}`);

    for (let b = 1; b <= hashLength; b++) {
      if (hashLength % b !== 0) continue;
      const r = hashLength / b;
      const calculatedSimilarity = Math.pow(1 / b, 1 / r);

      const similarityScore =
        1 - Math.abs(calculatedSimilarity - similarityThreshold);
      const speedScore = 1 - (b - 1) / (hashLength - 1);
      const balanceScore =
        1 -
        Math.abs(Math.log(b) - 0.5 * Math.log(hashLength)) /
          (0.5 * Math.log(hashLength));

      const balanceWeight = 0.2; // Adjust this to change the importance of balance
      const score =
        ((1 - speedImportance) * similarityScore +
          speedImportance * speedScore +
          balanceWeight * balanceScore) /
        (1 + balanceWeight);

      // console.log(`Bands: ${b}, Rows: ${r}, Similarity: ${calculatedSimilarity.toFixed(4)}, Score: ${score.toFixed(4)}`);

      if (score > bestScore) {
        bestScore = score;
        bestBands = b;
        bestRows = r;
      }
    }

    // console.log(`Selected configuration: ${bestBands} bands with ${bestRows} rows each. Best score: ${bestScore.toFixed(4)}`);

    return [bestBands, bestRows];
  }

  add(hash: Buffer, identifier: string) {
    for (let bandIndex = 0; bandIndex < this.numBands; bandIndex++) {
      const bandHash = this.getBandHash(hash, bandIndex).toString("hex"); // Convert Buffer to hex string for Map key
      if (!this.bands[bandIndex].has(bandHash)) {
        this.bands[bandIndex].set(bandHash, new Set<string>());
      }
      this.bands[bandIndex].get(bandHash)!.add(identifier);
    }
  }

  remove(hash: Buffer, identifier: string) {
    for (let bandIndex = 0; bandIndex < this.numBands; bandIndex++) {
      const bandHash = this.getBandHash(hash, bandIndex).toString("hex");
      const bucket = this.bands[bandIndex].get(bandHash);
      if (bucket) {
        bucket.delete(identifier);
        if (bucket.size === 0) {
          this.bands[bandIndex].delete(bandHash);
        }
      }
    }
  }

  getCandidates(hash: Buffer): Set<string> {
    const candidates = new Set<string>();
    for (let bandIndex = 0; bandIndex < this.numBands; bandIndex++) {
      const bandHash = this.getBandHash(hash, bandIndex).toString("hex");
      const bucket = this.bands[bandIndex].get(bandHash);
      if (bucket) {
        for (const id of bucket) {
          candidates.add(id);
        }
      }
    }
    return candidates;
  }

  getAllBuckets(): string[][] {
    const allBuckets: string[][] = [];
    for (const band of this.bands) {
      for (const bucket of band.values()) {
        allBuckets.push(Array.from(bucket));
      }
    }
    return allBuckets;
  }

  private getBandHash(hash: Buffer, bandIndex: number): Buffer {
    const start = bandIndex * this.bandSize;
    const end = start + this.bandSize;
    return hash.slice(start, end);
  }
}
