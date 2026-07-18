/**
 * Canonical list of supported source systems. Every module that needs to
 * iterate sources (ACL guard, query handler, disconnect command) imports
 * this tuple rather than redeclaring it locally — adding a fourth source
 * is a one-line change here + a new verifier module.
 */
export const SUPPORTED_SOURCES = ["notion", "confluence", "drive"] as const;
export type Source = (typeof SUPPORTED_SOURCES)[number];

export interface RetrievalHit {
  docId: string;
  source: Source;
  title: string;
  url: string;
  chunkText: string;
  lastModified: string;
  score: number;
  accessVerified: boolean;
  wasRedacted: boolean;
}

export interface ConnectorSearchResult {
  hits: RetrievalHit[];
  errors: ConnectorError[];
}

export interface ConnectorError {
  source: Source;
  message: string;
  partial: boolean;
}

export interface SourceCitation {
  source: Source;
  docId: string;
  title: string;
  url: string;
  lastModified: string;
  isStale: boolean;
}
