import type { ImageUpdatePublication } from './image-update-planning';

export type ImageUpdatePullCheckStatus = 'success' | 'pending' | 'failure' | 'missing';

export interface ImageUpdatePullReview extends ImageUpdatePublication {
  repositoryName: string;
  title: string;
  checkStatus: ImageUpdatePullCheckStatus;
  status: 'ready' | 'review' | 'blocked';
  conflicts?: true;
  ready: boolean;
}

export interface ImageUpdatePullReviewList {
  pulls: ImageUpdatePullReview[];
  unreadableRepositories: number;
}
