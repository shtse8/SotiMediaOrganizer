export class LSH {
    private bands: Map<string, Set<string>>[];
    private bandSize: number;
    private numBands: number;
  
    constructor(hashLength: number, similarityThreshold: number) {
      if (hashLength <= 0) {
        throw new Error('Hash size must be a positive integer');
      }
      
      [this.numBands, this.bandSize] = this.calculateBandsAndRows(hashLength, similarityThreshold);
      this.bands = Array.from({ length: this.numBands }, () => new Map<string, Set<string>>());
    }
  
    private calculateBandsAndRows(hashLength: number, similarityThreshold: number): [number, number] {
      let bestBands = 0;
      let bestRows = 0;
      let minDiff = Infinity;
  
      for (let b = 1; b <= hashLength; b++) {
          if (hashLength % b !== 0) continue;
          const r = hashLength / b;
          const calculatedSimilarity = Math.pow(1 / b, 1 / r);
          const diff = Math.abs(calculatedSimilarity - similarityThreshold);
          if (diff < minDiff) {
              minDiff = diff;
              bestBands = b;
              bestRows = r;
          }
      }
  
      return [bestBands, bestRows];
    }
  
    add(hash: string, identifier: string) {
      for (let i = 0; i < this.numBands; i++) {
        const bandHash = hash.slice(i * this.bandSize, (i + 1) * this.bandSize);
        if (!this.bands[i].has(bandHash)) {
          this.bands[i].set(bandHash, new Set());
        }
        this.bands[i].get(bandHash)!.add(identifier);
      }
    }
  
    remove(hash: string, identifier: string) {
      for (let i = 0; i < this.numBands; i++) {
        const bandHash = hash.slice(i * this.bandSize, (i + 1) * this.bandSize);
        const bandCandidates = this.bands[i].get(bandHash);
        if (bandCandidates) {
          bandCandidates.delete(identifier);
          if (bandCandidates.size === 0) {
            this.bands[i].delete(bandHash);
          }
        }
      }
    }
  
    getCandidates(hash: string): Set<string> {
      const candidates = new Set<string>();
      for (let i = 0; i < this.numBands; i++) {
        const bandHash = hash.slice(i * this.bandSize, (i + 1) * this.bandSize);
        const bandCandidates = this.bands[i].get(bandHash);
        if (bandCandidates) {
          for (const candidate of bandCandidates) {
            candidates.add(candidate);
          }
        }
      }
      return candidates;
    }
  
    getAllBuckets(): string[][] {
      const buckets: Set<string>[] = [];
      for (const band of this.bands) {
        for (const bucket of band.values()) {
          if (bucket.size > 1) {
            buckets.push(bucket);
          }
        }
      }
      return buckets.map(bucket => Array.from(bucket));
    }
  }
  