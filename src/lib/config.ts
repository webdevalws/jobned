/**
 * JobNed Configuration Utilities for Base URL and Storage URL
 * Centralized environment-aware URL construction for app and asset storage.
 */

/**
 * Returns the Base URL of the application.
 * Checks runtime environment variables first, then import.meta.env, fallback to Cloudflare production domain.
 */
export function getBaseUrl(env?: Record<string, any>): string {
  const baseUrl =
    env?.PUBLIC_BASE_URL ||
    env?.BASE_URL ||
    import.meta.env.PUBLIC_BASE_URL ||
    import.meta.env.BASE_URL ||
    'https://recruitnest.prashantsinghstd.workers.dev';

  return baseUrl.replace(/\/+$/, '');
}

/**
 * Returns the Storage / CDN Base URL for uploaded files (avatars, resumes, logos).
 */
export function getStorageUrl(env?: Record<string, any>): string {
  const storageUrl =
    env?.PUBLIC_STORAGE_URL ||
    env?.STORAGE_URL ||
    import.meta.env.PUBLIC_STORAGE_URL ||
    import.meta.env.STORAGE_URL ||
    `${getBaseUrl(env)}/uploads`;

  return storageUrl.replace(/\/+$/, '');
}

/**
 * Constructs a full public URL for a stored file relative path / key.
 *
 * @param path Relative path/key in database (e.g. "avatars/user-123.jpg")
 * @param fallback Fallback image URL if path is missing
 * @param env Cloudflare runtime env bindings if in server context
 */
export function getFileUrl(
  path?: string | null,
  fallback: string = '/images/default-avatar.png',
  env?: Record<string, any>
): string {
  if (!path) return fallback;
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) {
    return path;
  }
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${getStorageUrl(env)}${cleanPath}`;
}
