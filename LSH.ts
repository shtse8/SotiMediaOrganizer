export class LSH {
    private bands: Map<string, Set<string>>[];
    private bandSize: number;
    private numBands: number;
  
    constructor(hashLength: number, similarityThreshold: number, speedImportance: number = 0.5) {
      if (hashLength <= 0) {
        throw new Error('Hash size must be a positive integer');
      }
      
      [this.numBands, this.bandSize] = this.calculateBandsAndRows(hashLength, similarityThreshold, speedImportance);
      console.log(`Using ${this.numBands} bands with ${this.bandSize} rows each\n\n`);
      this.bands = Array.from({ length: this.numBands }, () => new Map<string, Set<string>>());
    }
  
    private calculateBandsAndRows(hashLength: number, similarityThreshold: number, speedImportance: number): [number, number] {
        let bestBands = 1;
        let bestRows = hashLength;
        let bestScore = -Infinity;
    
        console.log(`Calculating bands and rows for hash length: ${hashLength}, similarity: ${similarityThreshold}, speed importance: ${speedImportance}`);
    
        // We'll consider all possible band numbers, but use the balance score to penalize extremes
        for (let b = 1; b <= hashLength; b++) {
          if (hashLength % b !== 0) continue;
          const r = hashLength / b;
          const calculatedSimilarity = Math.pow(1 / b, 1 / r);
          
          // Similarity score: higher is better (closer to threshold)
          const similarityScore = 1 - Math.abs(calculatedSimilarity - similarityThreshold);
          
          // Speed score: higher is better (fewer bands)
          const speedScore = 1 - (b - 1) / (hashLength - 1);
          
          // Balance score: penalize extreme configurations
          // This function peaks at sqrt(hashLength) and falls off towards the extremes
          const balanceScore = 1 - Math.abs(Math.log(b) - 0.5 * Math.log(hashLength)) / (0.5 * Math.log(hashLength));
    
          // Combine scores using weighted arithmetic mean
          const balanceWeight = 0.2; // Adjust this to change the importance of balance
          const score = (
            (1 - speedImportance) * similarityScore +
            speedImportance * speedScore +
            balanceWeight * balanceScore
          ) / (1 + balanceWeight);
    
          console.log(`Bands: ${b}, Rows: ${r}, Similarity: ${calculatedSimilarity.toFixed(4)}, Score: ${score.toFixed(4)}`);
    
          if (score > bestScore) {
            bestScore = score;
            bestBands = b;
            bestRows = r;
          }
        }
    
        console.log(`Selected configuration: ${bestBands} bands with ${bestRows} rows each. Best score: ${bestScore.toFixed(4)}`);
    
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
        const buckets: string[][] = [];
        for (const band of this.bands) {
        for (const bucket of band.values()) {
            // Include all buckets, even those with only one item
            buckets.push(Array.from(bucket));
        }
        }
        return buckets;
    }
  }
  