export const MAX_IMAGE_UPDATE_CANDIDATES = 24;

export interface ImageUpdateIntent {
  stackId: string;
  service: string;
  targetTag: string;
  source: 'manual' | 'wud';
  changelogUrl?: string;
}

export interface ImageUpdateReviewRow {
  service: string;
  source: ImageUpdateIntent['source'];
  before: string | null;
  after: string | null;
  status: 'ready' | 'review' | 'blocked';
  notes: string[];
  changelogUrl: string | null;
}

export interface ImageUpdatePreview {
  files: Array<{
    stackId: string;
    stackName: string;
    path: string;
    status: 'ready' | 'review' | 'blocked';
    reason: string | null;
    changes: ImageUpdateReviewRow[];
    token: string | null;
  }>;
}

export interface ImageUpdateStageResult {
  files: Array<{
    stackId: string;
    stackName: string;
    path: string;
    status: 'staged' | 'draft_exists' | 'source_changed' | 'candidate_changed' | 'review_required';
  }>;
}
