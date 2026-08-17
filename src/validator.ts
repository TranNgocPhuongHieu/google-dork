export type UrlStatus =
  | 'accessible'
  | 'deleted'
  | 'private'
  | 'login_required'
  | 'redirected_non_post'
  | 'unknown';

export async function validateDiscoveredUrl(_url: string, _site: string): Promise<UrlStatus> {
  return 'accessible';
}


