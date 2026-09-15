/**
 * Utility to generate a universally viewable URL for resumes across Web & Mobile (Capacitor)
 */
export function getResumeViewerUrl(url: string | null | undefined, origin: string): string {
  if (!url) return '#';
  
  let absoluteUrl = url.trim();
  if (absoluteUrl.startsWith('data:')) {
    return absoluteUrl;
  }

  if (absoluteUrl.startsWith('/')) {
    try {
      absoluteUrl = new URL(absoluteUrl, origin).href;
    } catch {
      absoluteUrl = `${origin.replace(/\/$/, '')}/${absoluteUrl.replace(/^\//, '')}`;
    }
  }

  // 1. Cloudinary Hosted Resumes (Sanskar Construction, Alightway, etc.)
  if (absoluteUrl.includes('cloudinary.com')) {
    const cleanUrl = absoluteUrl
      .replace('/fl_inline/', '/')
      .replace('/raw/upload/fl_inline/', '/raw/upload/');
    const base = origin.replace(/\/$/, '');
    return `${base}/api/resume-proxy?url=${encodeURIComponent(cleanUrl)}`;
  }

  // 2. Relative or local uploads & internal API resume endpoints
  if (absoluteUrl.includes('/api/resumes/') || absoluteUrl.includes('/uploads/')) {
    return absoluteUrl;
  }

  // 3. Direct external URLs (PDFs, Google Drive, Cloud Storage, R2)
  return absoluteUrl;
}
